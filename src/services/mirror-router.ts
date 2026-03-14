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

// ─── Reachability pre-check (pure Node fetch, no Puppeteer) ──────────────────
//
// Used at startup to rank mirrors before any browser page exists.
// Runs all mirrors in parallel — completes in ~2-3s instead of 16 × 25s.
//
// Returns latency in ms so we can sort fastest-first, giving Puppeteer
// the best mirror to navigate to immediately.

const REACH_TIMEOUT_MS = 5_000;

interface ReachResult {
	origin: string;
	reachable: boolean;
	latencyMs: number;
}

async function probeOrigin(origin: string): Promise<ReachResult> {
	const start = Date.now();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REACH_TIMEOUT_MS);
		const res = await fetch(`${origin}/`, {
			method: 'HEAD',
			signal: controller.signal,
			redirect: 'manual',
		}).finally(() => clearTimeout(timer));

		const latencyMs = Date.now() - start;
		// 403/503 = CF is answering (reachable), 2xx/3xx = clean, 404 = up but no root
		const reachable = res.status < 600;
		return { origin, reachable, latencyMs };
	} catch {
		return { origin, reachable: false, latencyMs: REACH_TIMEOUT_MS };
	}
}

// ─── Mirror Router ────────────────────────────────────────────────────────────

export class MirrorRouter {
	private readonly mirrors: Map<string, MirrorState>;
	// Ordered list of reachable mirrors, fastest first — set at startup
	private _rankedMirrors: string[] = [];
	private _startupDone = false;

	constructor(mirrors: readonly string[] = STAKE_MIRRORS) {
		this.mirrors = new Map(mirrors.map((origin) => [origin, { origin, status: 'unknown', lastChecked: 0, blockedUntil: 0, failCount: 0 }]));
	}

	// ─── Startup discovery ────────────────────────────────────────────────────
	//
	// Call this once at server startup, before launching Puppeteer.
	// Probes all mirrors in parallel via cheap HTTP HEAD requests and builds
	// a ranked list (fastest-first, unreachable excluded).
	//
	// After this runs, findCleanMirror skips the probe phase entirely and
	// navigates Puppeteer directly to the top-ranked mirror.

	async discoverMirrors(): Promise<void> {
		const allOrigins = [...this.mirrors.keys()];
		logger.info({ count: allOrigins.length }, 'Probing mirrors at startup...');

		const results = await Promise.all(allOrigins.map(probeOrigin));

		const reachable = results.filter((r) => r.reachable).sort((a, b) => a.latencyMs - b.latencyMs);

		const unreachable = results.filter((r) => !r.reachable);

		// Pre-mark unreachable ones so they sit in backoff immediately
		for (const { origin } of unreachable) {
			this.markUnreachable(origin);
		}

		this._rankedMirrors = reachable.map((r) => r.origin);
		this._startupDone = true;

		logger.info(
			{
				reachable: reachable.map((r) => `${r.origin} (${r.latencyMs}ms)`),
				unreachable: unreachable.map((r) => r.origin),
			},
			`Mirror discovery complete — ${reachable.length} reachable, ${unreachable.length} unreachable`,
		);
	}

	// ─── Selection ────────────────────────────────────────────────────────────

	getAvailableMirrors(): string[] {
		const now = Date.now();

		if (this._startupDone && this._rankedMirrors.length > 0) {
			// Use pre-ranked list — filters out anything that's since been blocked/unreachable
			return this._rankedMirrors.filter((origin) => {
				const s = this.mirrors.get(origin);
				return s && now >= s.blockedUntil;
			});
		}

		// Fallback: startup hasn't run yet, use default sort
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

		// Promote to front of ranked list so future pages use it immediately
		this._rankedMirrors = [origin, ...this._rankedMirrors.filter((o) => o !== origin)];
	}

	markBlocked(origin: string): void {
		const s = this.mirrors.get(origin);
		if (!s) return;
		s.failCount++;
		s.status = 'blocked';
		s.blockedUntil = Date.now() + backoffMs(s.failCount);
		s.lastChecked = Date.now();
		// Remove from ranked list — it'll re-appear after blockedUntil via getAvailableMirrors filter
		this._rankedMirrors = this._rankedMirrors.filter((o) => o !== origin);
		logger.warn({ origin, failCount: s.failCount, cooldownMs: backoffMs(s.failCount) }, 'Mirror CF-blocked');
	}

	markUnreachable(origin: string): void {
		const s = this.mirrors.get(origin);
		if (!s) return;
		s.failCount++;
		s.status = 'unreachable';
		s.blockedUntil = Date.now() + backoffMs(s.failCount);
		s.lastChecked = Date.now();
		this._rankedMirrors = this._rankedMirrors.filter((o) => o !== origin);
		logger.warn({ origin, failCount: s.failCount }, 'Mirror unreachable');
	}

	getStats(): Record<string, Pick<MirrorState, 'status' | 'failCount' | 'blockedUntil'>> {
		const out: Record<string, Pick<MirrorState, 'status' | 'failCount' | 'blockedUntil'>> = {};
		for (const [origin, s] of this.mirrors) {
			out[origin] = { status: s.status, failCount: s.failCount, blockedUntil: s.blockedUntil };
		}
		return out;
	}

	// ─── CF Bypass (Puppeteer) ────────────────────────────────────────────────
	//
	// After discoverMirrors() has run, this skips the parallel probe phase
	// and navigates directly to the top-ranked reachable mirror.
	// On a warm server, this saves 2-5s per page warmup.

	async findCleanMirror(page: Page, timeout = 25_000): Promise<string> {
		const available = this.getAvailableMirrors();

		if (available.length === 0) {
			throw new Error('All mirrors are on cooldown — no reachable mirrors available');
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

		throw new Error(`All ${available.length} mirrors are CF-blocked or unreachable`);
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
				logger.warn({ origin, elapsed: Date.now() - solveStart }, 'CF challenge did not resolve');
				return 'blocked';
			}

			logger.debug({ origin, elapsed: Date.now() - solveStart }, 'CF cleared');
			return 'clean';
		} catch (err) {
			const msg = (err as Error).message ?? '';
			if (msg.includes('timeout') || msg.includes('Timeout')) return 'blocked';
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
