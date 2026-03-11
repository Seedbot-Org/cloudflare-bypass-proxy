import { Page } from 'puppeteer';
import { logger } from '../logger';

// ─── Mirror Registry ──────────────────────────────────────────────────────────

// All known Stake mirrors
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

// All known Cloudflare challenge page signals — title and body text variants.
const CF_CHALLENGE_SIGNALS = [
	'Just a moment',
	'Performing security verification',
	'Verifying you are human',
	'Please wait',
	'Checking your browser',
	'DDoS protection by Cloudflare',
	'cf-browser-verification',
	'cf_chl_opt',
] as const;

function isCloudflareChallenge(title: string, bodyText: string): boolean {
	const haystack = `${title} ${bodyText}`.toLowerCase();
	return CF_CHALLENGE_SIGNALS.some((signal) => haystack.includes(signal.toLowerCase()));
}

async function isPageBlockedByCF(page: Page): Promise<boolean> {
	try {
		const { title, bodyText } = await page.evaluate(() => ({
			title: document.title,
			bodyText: document.body?.innerText?.slice(0, 2000) ?? '',
		}));
		return isCloudflareChallenge(title, bodyText);
	} catch {
		return false;
	}
}

// ─── Mirror Status Tracking ───────────────────────────────────────────────────

export type MirrorStatus = 'unknown' | 'healthy' | 'blocked' | 'unreachable';

export interface MirrorState {
	origin: string;
	status: MirrorStatus;
	lastChecked: number;
	blockedUntil: number; // Don't retry before this timestamp
	failCount: number;
}

// How long to avoid a blocked mirror before trying it again (exponential backoff)
const BASE_BACKOFF_MS = 2 * 60_000; // 2 minutes base
const MAX_BACKOFF_MS = 30 * 60_000; // 30 minutes max

function backoffMs(failCount: number): number {
	return Math.min(BASE_BACKOFF_MS * Math.pow(2, failCount - 1), MAX_BACKOFF_MS);
}

// ─── Mirror Router ────────────────────────────────────────────────────────────

export class MirrorRouter {
	private mirrors: Map<string, MirrorState>;

	constructor(mirrors: readonly string[] = STAKE_MIRRORS) {
		this.mirrors = new Map(mirrors.map((origin) => [origin, { origin, status: 'unknown', lastChecked: 0, blockedUntil: 0, failCount: 0 }]));
	}

	// ─── Mirror Selection ──────────────────────────────────────────────────────

	/**
	 * Returns mirrors in priority order, skipping ones that are currently
	 * on cooldown due to recent CF blocks.
	 */
	getAvailableMirrors(): string[] {
		const now = Date.now();

		return [...this.mirrors.values()]
			.filter((m) => now >= m.blockedUntil)
			.sort((a, b) => {
				// Prefer known-healthy > unknown > known-blocked (past cooldown)
				const rank = (s: MirrorStatus) => (s === 'healthy' ? 0 : s === 'unknown' ? 1 : 2);
				return rank(a.status) - rank(b.status);
			})
			.map((m) => m.origin);
	}

	// ─── Status Updates ────────────────────────────────────────────────────────

	markHealthy(origin: string): void {
		const state = this.mirrors.get(origin);
		if (!state) return;
		state.status = 'healthy';
		state.failCount = 0;
		state.blockedUntil = 0;
		state.lastChecked = Date.now();
		logger.debug({ origin }, 'Mirror marked healthy');
	}

	markBlocked(origin: string): void {
		const state = this.mirrors.get(origin);
		if (!state) return;
		state.failCount++;
		state.status = 'blocked';
		state.blockedUntil = Date.now() + backoffMs(state.failCount);
		state.lastChecked = Date.now();
		logger.warn({ origin, failCount: state.failCount, cooldownMs: backoffMs(state.failCount) }, 'Mirror blocked by CF — cooling down');
	}

	markUnreachable(origin: string): void {
		const state = this.mirrors.get(origin);
		if (!state) return;
		state.failCount++;
		state.status = 'unreachable';
		state.blockedUntil = Date.now() + backoffMs(state.failCount);
		state.lastChecked = Date.now();
		logger.warn({ origin }, 'Mirror unreachable — cooling down');
	}

	getStats(): Record<string, Pick<MirrorState, 'status' | 'failCount' | 'blockedUntil'>> {
		const out: Record<string, Pick<MirrorState, 'status' | 'failCount' | 'blockedUntil'>> = {};
		for (const [origin, state] of this.mirrors) {
			out[origin] = { status: state.status, failCount: state.failCount, blockedUntil: state.blockedUntil };
		}
		return out;
	}

	// ─── CF Bypass with Fallback ───────────────────────────────────────────────

	/**
	 * Tries each available mirror in order until one passes the CF challenge.
	 * Returns the first clean mirror origin, or throws if all are blocked.
	 *
	 * @param page     - Puppeteer page to navigate on
	 * @param timeout  - Per-mirror navigation timeout in ms
	 */
	async findCleanMirror(page: Page, timeout = 45_000): Promise<string> {
		const available = this.getAvailableMirrors();

		if (available.length === 0) {
			throw new Error('All mirrors are currently on cooldown');
		}

		logger.info({ count: available.length }, 'Searching for clean mirror...');

		for (const origin of available) {
			const result = await this._tryMirror(page, origin, timeout);

			if (result === 'clean') {
				this.markHealthy(origin);
				logger.info({ origin }, 'Clean mirror found');
				return origin;
			}

			if (result === 'blocked') {
				this.markBlocked(origin);
			} else {
				this.markUnreachable(origin);
			}
		}

		throw new Error(`All ${available.length} mirrors are blocked or unreachable`);
	}

	/**
	 * Navigates to an origin and checks if it's behind a CF challenge.
	 * Returns: 'clean' | 'blocked' | 'unreachable'
	 */
	private async _tryMirror(page: Page, origin: string, timeout: number): Promise<'clean' | 'blocked' | 'unreachable'> {
		logger.debug({ origin }, 'Trying mirror...');

		try {
			await page.goto(origin, { waitUntil: 'domcontentloaded', timeout });

			// Wait briefly for CF JS challenge to either resolve or stay stuck
			await this._waitForCFResolution(page, 10_000);

			const blocked = await isPageBlockedByCF(page);

			if (blocked) {
				logger.debug({ origin }, 'Mirror is CF-blocked');
				return 'blocked';
			}

			return 'clean';
		} catch (err) {
			logger.debug({ origin, err: (err as Error).message }, 'Mirror unreachable');
			return 'unreachable';
		}
	}

	/**
	 * Waits up to `timeout` ms for the page to clear a CF challenge.
	 * Resolves early if the challenge disappears before the timeout.
	 */
	private async _waitForCFResolution(page: Page, timeout: number): Promise<void> {
		try {
			await page.waitForFunction(
				(signals: string[]) => {
					const text = `${document.title} ${document.body?.innerText ?? ''}`.toLowerCase();
					return !signals.some((s) => text.includes(s.toLowerCase()));
				},
				{ timeout, polling: 500 },
				[...CF_CHALLENGE_SIGNALS]
			);
		} catch {
			// Timed out waiting — page is likely still blocked
		}
	}
}

// Singleton for use across the app
export const mirrorRouter = new MirrorRouter();
