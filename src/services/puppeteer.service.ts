import { Browser, Page } from 'puppeteer';
import { logger } from '../logger';
import { mirrorRouter } from './mirror-router';

export interface GraphQLRequest {
	url: string;
	query: string;
	variables?: Record<string, unknown>;
	operationName?: string;
	accessToken?: string;
}

export interface ProxyResponse {
	success: boolean;
	status?: number;
	data?: unknown;
	error?: string;
	timing?: { duration: number };
}

const CONFIG = {
	POOL_SIZE: 3,
	MAX_REQUESTS_PER_PAGE: 200,
	PAGE_MAX_AGE_MS: 20 * 60_000, // 20 min

	// CF clearance TTL is ~5 min. Refresh at 3.5 min to stay safely ahead.
	// This runs in the background — zero impact on request latency.
	CF_REFRESH_INTERVAL_MS: 3.5 * 60_000,

	// Timeout for the initial CF solve during warmup / forced refresh
	CF_SOLVE_TIMEOUT_MS: 25_000,
	REQUEST_TIMEOUT_MS: 15_000,
	QUEUE_TIMEOUT_MS: 30_000,
	HEALTH_CHECK_INTERVAL_MS: 60_000,
	HEAP_RECYCLE_THRESHOLD_MB: 400,
	BROWSER_RESTART_DELAY_MS: 1_000,
} as const;

interface PooledPage {
	page: Page;
	busy: boolean;
	requestCount: number;
	createdAt: number;
	// The mirror this page currently holds clearance for (null = not warmed up)
	activeMirror: string | null;
	// Whether this page is currently being warmed up (prevents double-warm races)
	warming: boolean;
	// Timer that proactively refreshes CF clearance before it expires
	refreshTimer: NodeJS.Timeout | null;
}

interface QueuedRequest {
	request: GraphQLRequest;
	resolve: (value: ProxyResponse) => void;
	reject: (reason: unknown) => void;
	timeoutId: NodeJS.Timeout;
}

class PuppeteerService {
	private browser: Browser | null = null;
	private pool: PooledPage[] = [];
	private queue: QueuedRequest[] = [];
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private shuttingDown = false;
	private healthTimer: NodeJS.Timeout | null = null;
	private restartTimer: NodeJS.Timeout | null = null;

	// ─── Init ─────────────────────────────────────────────────────────────────

	async init(): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;
		this.initPromise = this._init().catch((err) => {
			this.initPromise = null;
			throw err;
		});
		return this.initPromise;
	}

	private async _init(): Promise<void> {
		logger.info('Starting up...');

		// Probe all mirrors in parallel via cheap HTTP (no browser needed).
		// This runs BEFORE launching Puppeteer so by the time pages are created,
		// mirrorRouter already knows which mirrors are reachable and their latency rank.
		// Each subsequent _warmPage() navigates directly to the top mirror — no probing.
		await mirrorRouter.discoverMirrors();

		// Launch browser
		logger.info('Launching Puppeteer...');
		const puppeteerExtra = await import('puppeteer-extra');
		const StealthPlugin = await import('puppeteer-extra-plugin-stealth');
		puppeteerExtra.default.use(StealthPlugin.default());

		this.browser = await puppeteerExtra.default.launch({
			headless: true,
			executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--disable-gpu',
				'--disable-extensions',
				'--disable-background-networking',
				'--disable-background-timer-throttling',
				'--disable-backgrounding-occluded-windows',
				'--disable-renderer-backgrounding',
				'--mute-audio',
				'--no-first-run',
				'--window-size=1280,720',
				'--js-flags=--max-old-space-size=128',
				'--disable-blink-features=AutomationControlled',
				'--disable-features=IsolateOrigins,site-per-process',
			],
		});

		this.browser.on('disconnected', () => {
			if (!this.shuttingDown) {
				logger.warn('Browser disconnected — restarting');
				this._restartBrowser();
			}
		});

		// Create pages and warm them all in parallel.
		// Because discoverMirrors() already ranked mirrors, each _warmPage()
		// goes straight to the best mirror without re-probing.
		await Promise.all(Array.from({ length: CONFIG.POOL_SIZE }, () => this._createPage()));

		// Warm all pages concurrently in the background (don't block init return)
		this._warmAllPages().catch((err) => logger.error({ err }, 'Initial warmup failed'));

		this._startHealthCheck();
		this.initialized = true;
		logger.info(`Puppeteer ready (pool: ${CONFIG.POOL_SIZE}) — warming pages in background`);
	}

	// ─── Page Management ──────────────────────────────────────────────────────

	private async _createPage(): Promise<PooledPage> {
		if (!this.browser) throw new Error('Browser not initialized');

		const page = await this.browser.newPage();

		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const type = req.resourceType();
			if (['document', 'script', 'xhr', 'fetch', 'stylesheet'].includes(type)) {
				req.continue();
			} else {
				req.abort();
			}
		});

		page.on('console', () => {});
		page.on('pageerror', () => {});

		await page.setViewport({ width: 1280, height: 720 });
		await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
		await page.setExtraHTTPHeaders({
			'Accept-Language': 'en-US,en;q=0.9',
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
			'Sec-Fetch-Site': 'none',
			'Sec-Fetch-Mode': 'navigate',
			'Sec-Fetch-User': '?1',
			'Sec-Fetch-Dest': 'document',
			'Upgrade-Insecure-Requests': '1',
		});

		await page.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
			Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
			Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
			(window as unknown as Record<string, unknown>).chrome = {
				runtime: {},
				loadTimes: () => ({}),
				csi: () => ({}),
				app: {},
			};
		});

		await page.setDefaultTimeout(CONFIG.REQUEST_TIMEOUT_MS);
		await page.setDefaultNavigationTimeout(CONFIG.CF_SOLVE_TIMEOUT_MS);

		const pooled: PooledPage = {
			page,
			busy: false,
			requestCount: 0,
			createdAt: Date.now(),
			activeMirror: null,
			warming: false,
			refreshTimer: null,
		};

		this.pool.push(pooled);
		return pooled;
	}

	// ─── CF Warmup ────────────────────────────────────────────────────────────

	private async _warmAllPages(): Promise<void> {
		await Promise.all(this.pool.map((p) => this._warmPage(p)));
	}

	private async _warmPage(pooled: PooledPage): Promise<void> {
		if (pooled.warming) return;
		pooled.warming = true;

		// Cancel existing refresh timer before re-warming
		if (pooled.refreshTimer) {
			clearTimeout(pooled.refreshTimer);
			pooled.refreshTimer = null;
		}

		try {
			// findCleanMirror uses the pre-ranked list from discoverMirrors()
			// so it navigates to the fastest known-good mirror immediately
			const origin = await mirrorRouter.findCleanMirror(pooled.page, CONFIG.CF_SOLVE_TIMEOUT_MS);
			pooled.activeMirror = origin;
			logger.info({ origin }, 'Page warmed — CF clearance acquired');

			// Schedule proactive refresh before clearance expires
			pooled.refreshTimer = setTimeout(() => {
				this._warmPage(pooled).catch((err) => logger.warn({ err }, 'Background CF refresh failed'));
			}, CONFIG.CF_REFRESH_INTERVAL_MS);
			pooled.refreshTimer.unref();
		} catch (err) {
			logger.error({ err }, 'Page warmup failed');
			pooled.activeMirror = null;
		} finally {
			pooled.warming = false;
		}
	}

	private _isHealthy(p: PooledPage): boolean {
		return Date.now() - p.createdAt <= CONFIG.PAGE_MAX_AGE_MS && p.requestCount < CONFIG.MAX_REQUESTS_PER_PAGE && p.activeMirror !== null;
	}

	private async _recyclePage(pooled: PooledPage): Promise<void> {
		const idx = this.pool.indexOf(pooled);
		if (idx === -1) return;
		logger.debug(`Recycling page (requests: ${pooled.requestCount})`);

		if (pooled.refreshTimer) {
			clearTimeout(pooled.refreshTimer);
			pooled.refreshTimer = null;
		}

		this.pool.splice(idx, 1);
		await pooled.page.close().catch(() => {});

		const fresh = await this._createPage();
		// Warm the new page in background — don't hold up the recycle
		this._warmPage(fresh).catch((err) => logger.warn({ err }, 'Recycled page warmup failed'));
	}

	private async _acquirePage(): Promise<PooledPage> {
		await this.init();

		// Prefer a warm, healthy, free page
		const ready = this.pool.find((p) => !p.busy && !p.warming && this._isHealthy(p));
		if (ready) {
			ready.busy = true;
			return ready;
		}

		// If a page is warming, wait for it rather than navigating again
		const warming = this.pool.find((p) => !p.busy && p.warming);
		if (warming) {
			logger.debug('Waiting for page warmup...');
			await this._waitForWarm(warming);
			if (warming.activeMirror) {
				warming.busy = true;
				return warming;
			}
		}

		// Stale but free — recycle + warm, then use it
		const stale = this.pool.find((p) => !p.busy);
		if (stale) {
			await this._recyclePage(stale);
			const fresh = this.pool[this.pool.length - 1];
			if (!fresh.activeMirror) await this._waitForWarm(fresh);
			fresh.busy = true;
			return fresh;
		}

		throw new Error('POOL_EXHAUSTED');
	}

	private async _waitForWarm(pooled: PooledPage, maxWait = CONFIG.CF_SOLVE_TIMEOUT_MS): Promise<void> {
		const deadline = Date.now() + maxWait;
		while (Date.now() < deadline && pooled.warming) {
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	private _releasePage(pooled: PooledPage): void {
		pooled.busy = false;
		this._drainQueue();
	}

	// ─── Queue ────────────────────────────────────────────────────────────────

	private _enqueue(request: GraphQLRequest): Promise<ProxyResponse> {
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				const idx = this.queue.findIndex((i) => i.timeoutId === timeoutId);
				if (idx !== -1) this.queue.splice(idx, 1);
				reject(new Error('Request timed out in queue'));
			}, CONFIG.QUEUE_TIMEOUT_MS);
			this.queue.push({ request, resolve, reject, timeoutId });
		});
	}

	private _drainQueue(): void {
		while (this.queue.length > 0) {
			const free = this.pool.find((p) => !p.busy && !p.warming && this._isHealthy(p));
			if (!free) break;

			const item = this.queue.shift()!;
			clearTimeout(item.timeoutId);
			free.busy = true;

			this._executeRequest(free, item.request)
				.then(item.resolve)
				.catch(item.reject)
				.finally(() => this._releasePage(free));
		}
	}

	// ─── GraphQL Fetch ────────────────────────────────────────────────────────

	private async _executeRequest(pooled: PooledPage, request: GraphQLRequest): Promise<ProxyResponse> {
		const start = Date.now();

		// Rewrite the URL to the mirror this page has clearance for.
		// No navigation — the page is already parked on the mirror.
		if (pooled.activeMirror) {
			const originalOrigin = new URL(request.url).origin;
			if (originalOrigin !== pooled.activeMirror) {
				request.url = request.url.replace(originalOrigin, pooled.activeMirror);
			}
		}

		pooled.requestCount++;

		try {
			const result = await Promise.race([
				this._cdpFetch(pooled, request),
				new Promise<ProxyResponse>((_, reject) =>
					setTimeout(() => reject(new Error(`Timed out after ${CONFIG.REQUEST_TIMEOUT_MS}ms`)), CONFIG.REQUEST_TIMEOUT_MS),
				),
			]);
			return { ...result, timing: { duration: Date.now() - start } };
		} catch (err) {
			const msg = (err as Error).message ?? '';
			if (msg.includes('Target closed') || msg.includes('Session closed')) {
				throw new Error('Page closed during request — browser may have crashed');
			}
			throw err;
		}
	}

	private async _cdpFetch(pooled: PooledPage, request: GraphQLRequest): Promise<ProxyResponse> {
		if (pooled.page.isClosed()) throw new Error('Page is closed');

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		if (request.accessToken) headers['x-access-token'] = request.accessToken;

		const body = JSON.stringify({
			query: request.query,
			variables: request.variables ?? {},
			...(request.operationName && { operationName: request.operationName }),
		});

		const result = await pooled.page.evaluate(
			({ url, headers, body }) =>
				new Promise<{ success: boolean; status?: number; data?: unknown; error?: string }>((resolve) => {
					const xhr = new XMLHttpRequest();
					xhr.open('POST', url, true);
					for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
					xhr.timeout = 12_000;
					xhr.onload = () => {
						try {
							resolve({
								success: xhr.status >= 200 && xhr.status < 300,
								status: xhr.status,
								data: JSON.parse(xhr.responseText),
							});
						} catch {
							resolve({ success: false, status: xhr.status, error: `Failed to parse JSON (status ${xhr.status})` });
						}
					};
					xhr.onerror = () => resolve({ success: false, error: 'XHR network error' });
					xhr.ontimeout = () => resolve({ success: false, error: 'XHR timed out' });
					xhr.send(body);
				}),
			{ url: request.url, headers, body },
		);

		// CF blocked mid-session — clearance expired sooner than expected.
		// Trigger a background re-warm and return error so the caller can retry.
		if (result.status === 403 || result.status === 503) {
			const origin = new URL(request.url).origin;
			logger.warn({ status: result.status, origin }, 'CF block mid-session — triggering re-warm');
			mirrorRouter.markBlocked(origin);
			pooled.activeMirror = null;
			// Re-warm in background; don't block the response
			this._warmPage(pooled).catch((err) => logger.warn({ err }, 'Re-warm after CF block failed'));
		} else if (result.success) {
			mirrorRouter.markHealthy(new URL(request.url).origin);
		}

		return result;
	}

	// ─── Public ───────────────────────────────────────────────────────────────

	async graphqlRequest(request: GraphQLRequest): Promise<ProxyResponse> {
		if (this.shuttingDown) return { success: false, error: 'Service is shutting down' };

		const start = Date.now();

		try {
			let pooled: PooledPage;
			try {
				pooled = await this._acquirePage();
			} catch (err) {
				if ((err as Error).message === 'POOL_EXHAUSTED') {
					logger.debug('Pool exhausted — queuing');
					return this._enqueue(request);
				}
				throw err;
			}

			try {
				return await this._executeRequest(pooled, request);
			} finally {
				this._releasePage(pooled);
			}
		} catch (err) {
			const error = err instanceof Error ? err.message : 'Unknown error';
			logger.error({ error, url: request.url }, 'GraphQL request failed');
			return { success: false, error, timing: { duration: Date.now() - start } };
		}
	}

	getStats() {
		return {
			poolSize: this.pool.length,
			busyPages: this.pool.filter((p) => p.busy).length,
			warmPages: this.pool.filter((p) => p.activeMirror !== null).length,
			warmingPages: this.pool.filter((p) => p.warming).length,
			queueLength: this.queue.length,
			initialized: this.initialized,
			heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
			mirrors: mirrorRouter.getStats(),
		};
	}

	// ─── Health Check ─────────────────────────────────────────────────────────

	private _startHealthCheck(): void {
		this.healthTimer = setInterval(async () => {
			const stats = this.getStats();
			logger.debug(stats, 'Health');

			if (stats.heapMB > CONFIG.HEAP_RECYCLE_THRESHOLD_MB) {
				const oldest = this.pool.filter((p) => !p.busy).sort((a, b) => a.createdAt - b.createdAt)[0];
				if (oldest) {
					logger.warn({ heapMB: stats.heapMB }, 'High memory — recycling oldest page');
					await this._recyclePage(oldest);
				}
			}
		}, CONFIG.HEALTH_CHECK_INTERVAL_MS);

		this.healthTimer.unref();
	}

	// ─── Crash Recovery ───────────────────────────────────────────────────────

	private _restartBrowser(): void {
		if (this.restartTimer) return;
		this.restartTimer = setTimeout(async () => {
			this.restartTimer = null;
			this.initialized = false;
			this.initPromise = null;

			for (const item of this.queue.splice(0)) {
				clearTimeout(item.timeoutId);
				item.reject(new Error('Browser crashed'));
			}

			// Clear refresh timers before nuking pool
			for (const p of this.pool) {
				if (p.refreshTimer) clearTimeout(p.refreshTimer);
			}
			this.pool = [];

			await this.browser?.close().catch(() => {});
			this.browser = null;

			// Re-discover mirrors before restarting — topology may have changed
			await mirrorRouter.discoverMirrors().catch((err) => logger.warn({ err }, 'Mirror re-discovery failed on browser restart'));

			await this.init().catch((err) => logger.error({ err }, 'Browser restart failed'));
			logger.info('Browser restarted');
		}, CONFIG.BROWSER_RESTART_DELAY_MS);

		this.restartTimer?.unref?.();
	}

	// ─── Shutdown ─────────────────────────────────────────────────────────────

	async close(): Promise<void> {
		this.shuttingDown = true;

		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}

		for (const item of this.queue.splice(0)) {
			clearTimeout(item.timeoutId);
			item.reject(new Error('Service shutting down'));
		}

		for (const p of this.pool) {
			if (p.refreshTimer) clearTimeout(p.refreshTimer);
		}

		await Promise.allSettled(this.pool.map((p) => p.page.close()));
		this.pool = [];

		await this.browser?.close().catch(() => {});
		this.browser = null;
		this.initialized = false;
		this.initPromise = null;

		logger.info('PuppeteerService closed');
	}
}

export const puppeteerService = new PuppeteerService();

const shutdown = async () => {
	await puppeteerService.close();
	process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
