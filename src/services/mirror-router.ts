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
			bodyText: document.body?.innerText?.slice(0, 3000) ?? '',
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

// ─── Fast HTTP reachability pre-check ─────────────────────────────────────────
//
// Before spending 25s on a Puppeteer navigation, do a cheap Node.js fetch to
// see if the host responds at all. On Railway (datacenter IP), unreachable hosts
// fail in <3s via ECONNREFUSED/ENOTFOUND instead of burning the full timeout.
//
// Results:
//   'reachable'   → 2xx/3xx/404 response — host is up, proceed to Puppeteer
//   'cf-blocked'  → 403/503 response — CF is answering, proceed to Puppeteer
//   'unreachable' → timeout / DNS fail / ECONNREFUSED — skip immediately

const REACH_TIMEOUT_MS = 5_000;

async function checkReachable(origin: string): Promise<'reachable' | 'unreachable' | 'cf-blocked'> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REACH_TIMEOUT_MS);

		const res = await fetch(`${origin}/`, {
			method: 'HEAD',
			signal: controller.signal,
			redirect: 'manual',
		}).finally(() => clearTimeout(timer));

		if (res.status === 403 || res.status === 503) return 'cf-blocked';
		return 'reachable';
	} catch (err) {
		logger.debug({ origin, err: (err as Error).message }, 'Reachability pre-check failed');
		return 'unreachable';
	}
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
	 * Two-phase mirror selection:
	 *
	 * Phase 1 — parallel cheap reachability checks via Node fetch (5s timeout each).
	 *   Filters out network-unreachable mirrors instantly without tying up Puppeteer.
	 *   On Railway/datacenter IPs, this eliminates all unreachable mirrors in ~5s
	 *   instead of hanging 16 × 25s = 400s.
	 *
	 * Phase 2 — sequential Puppeteer navigation only on hosts confirmed reachable.
	 *   Uses networkidle2 so the CF clearance XHR completes before we proceed.
	 */
	async findCleanMirror(page: Page, timeout = 25_000): Promise<string> {
		const available = this.getAvailableMirrors();

		if (available.length === 0) {
			throw new Error('All mirrors are on cooldown');
		}

		// ── Phase 1: parallel reachability pre-check ───────────────────────────
		logger.debug({ count: available.length }, 'Running parallel reachability pre-check');

		const reachResults = await Promise.all(available.map(async (origin) => ({ origin, reach: await checkReachable(origin) })));

		const reachableMirrors: string[] = [];
		for (const { origin, reach } of reachResults) {
			if (reach === 'unreachable') {
				this.markUnreachable(origin);
			} else {
				reachableMirrors.push(origin);
			}
		}

		logger.info(
			{
				total: available.length,
				reachable: reachableMirrors.length,
				unreachable: available.length - reachableMirrors.length,
			},
			'Reachability pre-check complete',
		);

		if (reachableMirrors.length === 0) {
			// This is almost always a datacenter IP issue, not a CF issue.
			// Stealth plugins cannot fix IP-level blocks.
			logger.error(
				{
					hint: 'Set RESIDENTIAL_PROXY_URL=http://user:pass@host:port (Webshare, Oxylabs, Bright Data, Smartproxy)',
				},
				'All mirrors are network-unreachable — datacenter IP block detected. Residential proxy required.',
			);
			throw new Error(
				'All mirrors are network-unreachable from this server. ' + 'A residential proxy is required — set RESIDENTIAL_PROXY_URL.',
			);
		}

		// ── Phase 2: Puppeteer navigation on reachable mirrors only ───────────
		for (const origin of reachableMirrors) {
			const result = await this._tryMirror(page, origin, timeout);

			if (result === 'clean') {
				this.markHealthy(origin);
				logger.info({ origin }, 'Clean mirror — CF clearance acquired');
				return origin;
			}

			result === 'blocked' ? this.markBlocked(origin) : this.markUnreachable(origin);
		}

		throw new Error(`All ${reachableMirrors.length} reachable mirrors are CF-blocked`);
	}

	private async _tryMirror(page: Page, origin: string, timeout: number): Promise<'clean' | 'blocked' | 'unreachable'> {
		try {
			logger.debug({ origin }, 'Puppeteer navigating to mirror');

			// networkidle2 is critical — waits for the CF clearance background XHR.
			// domcontentloaded returns too early: cf_clearance cookie is not yet set.
			await page.goto(origin, { waitUntil: 'networkidle2', timeout });

			const solveStart = Date.now();
			await this._waitForCFClear(page, timeout - (Date.now() - solveStart));

			const blocked = await isPageBlockedByCF(page);
			if (blocked) {
				logger.warn({ origin, elapsed: Date.now() - solveStart }, 'CF challenge did not resolve within timeout');
				return 'blocked';
			}

			logger.debug({ origin, elapsed: Date.now() - solveStart }, 'CF cleared');
			return 'clean';
		} catch (err) {
			const msg = (err as Error).message ?? '';
			if (msg.includes('timeout') || msg.includes('Timeout')) {
				return 'blocked';
			}
			return 'unreachable';
		}
	}

	private async _waitForCFClear(page: Page, timeout: number): Promise<void> {
		const deadline = Date.now() + Math.max(timeout, 0);
		while (Date.now() < deadline) {
			if (!(await isPageBlockedByCF(page))) return;
			await new Promise((r) => setTimeout(r, 400));
		}
	}
}

export const mirrorRouter = new MirrorRouter();
