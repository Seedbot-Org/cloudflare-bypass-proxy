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

// Expanded signal list — Turnstile, newer CF challenge pages, JS/cookie gates
const CF_SIGNALS_LOWER = [
	'just a moment',
	'checking your browser',
	'verifying you are human',
	'performing security verification',
	'please wait',
	'ddos protection by cloudflare',
	'cf-browser-verification',
	'cf_chl_opt',
	'turnstile',
	'enable javascript',
	'enable cookies',
	'ray id',
] as const;

async function isPageBlockedByCF(page: Page): Promise<boolean> {
	try {
		const { title, bodyText, hasCFDom } = await page.evaluate(() => ({
			title: document.title ?? '',
			// Grab more text — CF sometimes puts challenge text lower in the DOM
			bodyText: document.body?.innerText?.slice(0, 3000) ?? '',
			// Check CF-specific DOM markers that can't be faked by coincidence
			hasCFDom:
				!!document.querySelector('meta[name="cf-ray"]') ||
				!!document.querySelector('[data-cf-turnstile]') ||
				!!document.querySelector('script[src*="challenges.cloudflare.com"]') ||
				!!document.getElementById('cf-wrapper') ||
				!!document.getElementById('challenge-form'),
		}));

		if (hasCFDom) return true;

		const haystack = `${title} ${bodyText}`.toLowerCase();
		return CF_SIGNALS_LOWER.some((s) => haystack.includes(s));
	} catch {
		// If evaluate throws (page crashed / navigating), assume still blocked
		return true;
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

const BASE_BACKOFF_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

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
	 * Tries available mirrors in priority order until one passes CF.
	 * Returns the clean mirror origin.
	 *
	 * Key improvements vs original:
	 * - Waits for 'networkidle2' not just 'domcontentloaded' — CF challenge JS
	 *   needs to fully execute and the clearance XHR to complete before we proceed
	 * - Poll window extended to match CONFIG.CF_SOLVE_TIMEOUT_MS (25s)
	 * - Faster tick (400ms) for quicker detection after CF auto-solve
	 * - Logs the solve duration to help tune timeouts
	 */
	async findCleanMirror(page: Page, timeout = 25_000): Promise<string> {
		const available = this.getAvailableMirrors();

		if (available.length === 0) {
			throw new Error('All mirrors are on cooldown');
		}

		for (const origin of available) {
			const result = await this._tryMirror(page, origin, timeout);

			if (result === 'clean') {
				this.markHealthy(origin);
				logger.info({ origin }, 'Clean mirror — CF clearance acquired');
				return origin;
			}

			result === 'blocked' ? this.markBlocked(origin) : this.markUnreachable(origin);
		}

		throw new Error(`All ${available.length} mirrors are blocked or unreachable`);
	}

	private async _tryMirror(page: Page, origin: string, timeout: number): Promise<'clean' | 'blocked' | 'unreachable'> {
		try {
			logger.debug({ origin }, 'Trying mirror');

			// 'networkidle2' waits for the CF clearance XHR to finish (not just DOM load).
			// Without this, the page appears ready but cf_clearance cookie isn't set yet.
			// This is the single most impactful fix in this file.
			await page.goto(origin, {
				waitUntil: 'networkidle2',
				timeout,
			});

			// After networkidle2, CF may still be running its JS verification loop.
			// Poll until the challenge disappears or we time out.
			const solveStart = Date.now();
			await this._waitForCFClear(page, timeout - (Date.now() - solveStart));
			const solveDuration = Date.now() - solveStart;

			const blocked = await isPageBlockedByCF(page);
			if (blocked) {
				logger.warn({ origin, solveDuration }, 'CF challenge did not resolve within timeout');
				return 'blocked';
			}

			logger.debug({ origin, solveDuration }, 'CF cleared');
			return 'clean';
		} catch (err) {
			const msg = (err as Error).message ?? '';

			// Distinguish navigation timeout (CF is fighting us — mark blocked)
			// from network errors (mirror is down — mark unreachable)
			if (msg.includes('timeout') || msg.includes('Timeout')) {
				logger.warn({ origin, err: msg }, 'Mirror navigation timed out — likely CF hard block');
				return 'blocked';
			}

			logger.debug({ origin, err: msg }, 'Mirror nav failed — unreachable');
			return 'unreachable';
		}
	}

	/**
	 * Polls until CF signals disappear or timeout expires.
	 *
	 * Tick reduced from 600ms to 400ms — CF Managed Challenge typically
	 * auto-solves in 3-8s, so faster polling means we proceed ~200ms earlier
	 * on average, reducing per-request latency.
	 */
	private async _waitForCFClear(page: Page, timeout: number): Promise<void> {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const stillBlocked = await isPageBlockedByCF(page);
			if (!stillBlocked) return;
			// 400ms tick vs original 600ms
			await new Promise((r) => setTimeout(r, 400));
		}
		// Don't throw — let the caller check and decide whether to mark blocked/unreachable
	}
}

export const mirrorRouter = new MirrorRouter();
