import { Page } from 'puppeteer';
import { logger } from '../logger';

// ─── Mirror Registry ──────────────────────────────────────────────────────────

export const STAKE_MIRRORS = [
	'https://stake.ac',
	'https://stake.games',
	'https://stake.bet',
	'https://staketr.com',
	'https://stake.pet',
	'https://stake.mba',
	'https://stake.jp',
	'https://stake.bz',
	'https://stake.ceo',
	'https://stake.krd',
	'https://stake1001.com',
	'https://stake1002.com',
	'https://stake1003.com',
	'https://stake1017.com',
	'https://stake1022.com',
	'https://stake1039.com',
] as const;

// ─── CF Detection ─────────────────────────────────────────────────────────────

// Ordered by how commonly they appear — short-circuits faster
const CF_SIGNALS = [
	'just a moment',
	'checking your browser',
	'verifying you are human',
	'performing security verification',
	'please wait',
	'ddos protection by cloudflare',
	'cf-browser-verification',
	'cf_chl_opt',
] as const;

// Pre-built lowercase array — avoids re-allocating on every check
const CF_SIGNALS_LOWER = CF_SIGNALS.map((s) => s.toLowerCase());

function isCloudflareChallenge(title: string, bodyText: string): boolean {
	const haystack = `${title} ${bodyText}`.toLowerCase();
	return CF_SIGNALS_LOWER.some((s) => haystack.includes(s));
}

async function isPageBlockedByCF(page: Page): Promise<boolean> {
	try {
		const { title, bodyText } = await page.evaluate(() => ({
			title: document.title,
			// Only grab first 1000 chars — CF signals are always near the top
			bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
		}));
		return isCloudflareChallenge(title, bodyText);
	} catch {
		return false;
	}
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type MirrorStatus = 'unknown' | 'healthy' | 'blocked' | 'unreachable';

export interface MirrorState {
	origin: string;
	status: MirrorStatus;
	lastChecked: number;
	blockedUntil: number;
	failCount: number;
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

const BASE_BACKOFF_MS = 2 * 60_000; // 2 min
const MAX_BACKOFF_MS = 30 * 60_000; // 30 min cap

function backoffMs(failCount: number): number {
	return Math.min(BASE_BACKOFF_MS * 2 ** (failCount - 1), MAX_BACKOFF_MS);
}

// ─── Mirror Router ────────────────────────────────────────────────────────────

export class MirrorRouter {
	private readonly mirrors: Map<string, MirrorState>;

	constructor(mirrors: readonly string[] = STAKE_MIRRORS) {
		this.mirrors = new Map(mirrors.map((origin) => [origin, { origin, status: 'unknown', lastChecked: 0, blockedUntil: 0, failCount: 0 }]));
	}

	// ─── Selection ────────────────────────────────────────────────────────────

	getAvailableMirrors(): string[] {
		const now = Date.now();
		// Rank: healthy=0, unknown=1, everything else=2
		const rank = (s: MirrorStatus) => (s === 'healthy' ? 0 : s === 'unknown' ? 1 : 2);

		return [...this.mirrors.values()]
			.filter((m) => now >= m.blockedUntil)
			.sort((a, b) => rank(a.status) - rank(b.status))
			.map((m) => m.origin);
	}

	// ─── Status Updates ───────────────────────────────────────────────────────

	markHealthy(origin: string): void {
		const s = this.mirrors.get(origin);
		if (!s) return;
		s.status = 'healthy';
		s.failCount = 0;
		s.blockedUntil = 0;
		s.lastChecked = Date.now();
	}

	markBlocked(origin: string): void {
		const s = this.mirrors.get(origin);
		if (!s) return;
		s.failCount++;
		s.status = 'blocked';
		s.blockedUntil = Date.now() + backoffMs(s.failCount);
		s.lastChecked = Date.now();
		logger.warn({ origin, failCount: s.failCount, cooldownMs: backoffMs(s.failCount) }, 'Mirror CF-blocked');
	}

	markUnreachable(origin: string): void {
		const s = this.mirrors.get(origin);
		if (!s) return;
		s.failCount++;
		s.status = 'unreachable';
		s.blockedUntil = Date.now() + backoffMs(s.failCount);
		s.lastChecked = Date.now();
		logger.warn({ origin, failCount: s.failCount }, 'Mirror unreachable');
	}

	getStats(): Record<string, Pick<MirrorState, 'status' | 'failCount' | 'blockedUntil'>> {
		const out: Record<string, Pick<MirrorState, 'status' | 'failCount' | 'blockedUntil'>> = {};
		for (const [origin, s] of this.mirrors) {
			out[origin] = { status: s.status, failCount: s.failCount, blockedUntil: s.blockedUntil };
		}
		return out;
	}

	// ─── CF Bypass ────────────────────────────────────────────────────────────

	/**
	 * Tries available mirrors in priority order until one is CF-clean.
	 * Returns the origin of the first working mirror.
	 */
	async findCleanMirror(page: Page, timeout = 30_000): Promise<string> {
		const available = this.getAvailableMirrors();

		if (available.length === 0) {
			throw new Error('All mirrors are on cooldown');
		}

		for (const origin of available) {
			const result = await this._tryMirror(page, origin, timeout);

			if (result === 'clean') {
				this.markHealthy(origin);
				logger.info({ origin }, 'Clean mirror found');
				return origin;
			}

			result === 'blocked' ? this.markBlocked(origin) : this.markUnreachable(origin);
		}

		throw new Error(`All ${available.length} mirrors are blocked or unreachable`);
	}

	private async _tryMirror(page: Page, origin: string, timeout: number): Promise<'clean' | 'blocked' | 'unreachable'> {
		try {
			await page.goto(origin, { waitUntil: 'domcontentloaded', timeout });
			await this._waitForCFClear(page, 8_000);
			return (await isPageBlockedByCF(page)) ? 'blocked' : 'clean';
		} catch (err) {
			logger.debug({ origin, err: (err as Error).message }, 'Mirror nav failed');
			return 'unreachable';
		}
	}

	/**
	 * Polls until CF signals disappear or timeout expires.
	 * Avoids waitForFunction to skip serialising the signals array on every tick.
	 */
	private async _waitForCFClear(page: Page, timeout: number): Promise<void> {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (!(await isPageBlockedByCF(page))) return;
			await new Promise((r) => setTimeout(r, 600));
		}
	}
}

export const mirrorRouter = new MirrorRouter();
