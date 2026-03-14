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
	MAX_REQUESTS_PER_PAGE: 100,
	PAGE_MAX_AGE_MS: 15 * 60_000,
	REQUEST_TIMEOUT_MS: 20_000,
	QUEUE_TIMEOUT_MS: 45_000,
	// Extended — CF Managed Challenge can take 10-15s to auto-solve
	CF_SOLVE_TIMEOUT_MS: 25_000,
	CF_BYPASS_INTERVAL_MS: 4 * 60_000,
	HEALTH_CHECK_INTERVAL_MS: 60_000,
	HEAP_RECYCLE_THRESHOLD_MB: 400,
	BROWSER_RESTART_DELAY_MS: 1_000,
} as const;

interface PooledPage {
	page: Page;
	busy: boolean;
	requestCount: number;
	createdAt: number;
	lastBypassAt: Map<string, number>;
	activeMirror: string | null;
}

interface QueuedRequest {
	request: GraphQLRequest;
	resolve: (value: ProxyResponse) => void;
	reject: (reason: unknown) => void;
	timeoutId: NodeJS.Timeout;
}

// CF signals expanded — Turnstile widget and newer challenge pages
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
	'ray id',
	'enable javascript',
	'enable cookies',
] as const;

async function isPageBlockedByCF(page: Page): Promise<boolean> {
	try {
		const { title, bodyText, hasCFMeta } = await page.evaluate(() => ({
			title: document.title,
			bodyText: document.body?.innerText?.slice(0, 2000) ?? '',
			// Also check for CF meta tags and script markers injected by Turnstile
			hasCFMeta:
				!!document.querySelector('meta[name="cf-ray"]') ||
				!!document.querySelector('[data-cf-turnstile]') ||
				!!document.querySelector('script[src*="challenges.cloudflare.com"]'),
		}));
		if (hasCFMeta) return true;
		const haystack = `${title} ${bodyText}`.toLowerCase();
		return CF_SIGNALS_LOWER.some((s) => haystack.includes(s));
	} catch {
		return false;
	}
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
		logger.info('Launching Puppeteer...');

		const puppeteerExtra = await import('puppeteer-extra');
		const StealthPlugin = await import('puppeteer-extra-plugin-stealth');
		puppeteerExtra.default.use(StealthPlugin.default());

		const proxyUrl = process.env.RESIDENTIAL_PROXY_URL;
		const proxyArgs = proxyUrl ? [`--proxy-server=${proxyUrl}`] : [];

		if (proxyUrl) {
			logger.info({ proxy: proxyUrl.replace(/:([^:@]+)@/, ':***@') }, 'Using residential proxy');
		} else {
			logger.warn('No RESIDENTIAL_PROXY_URL — datacenter IP may be blocked by Cloudflare');
		}

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
				...proxyArgs,
			],
		});

		this.browser.on('disconnected', () => {
			if (!this.shuttingDown) {
				logger.warn('Browser disconnected — restarting');
				this._restartBrowser();
			}
		});

		await Promise.all(Array.from({ length: CONFIG.POOL_SIZE }, () => this._createPage()));

		this._startHealthCheck();
		this.initialized = true;
		logger.info(`Puppeteer ready (pool: ${CONFIG.POOL_SIZE})`);
	}

	// ─── Page Management ──────────────────────────────────────────────────────

	private async _createPage(): Promise<PooledPage> {
		if (!this.browser) throw new Error('Browser not initialized');

		const page = await this.browser.newPage();

		// Allow 'document' through — needed for CF challenge page to render and auto-solve.
		// Blocking document causes CF to get stuck since the challenge JS never loads.
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const type = req.resourceType();
			// Allow: page navigation, scripts (CF challenge JS), XHR/fetch (GraphQL)
			// Also allow: image/font momentarily if CF challenge needs them (rare but real)
			if (['document', 'script', 'xhr', 'fetch'].includes(type)) {
				req.continue();
			} else {
				// Don't abort stylesheets either — CF Turnstile renders based on CSS classes
				if (type === 'stylesheet') {
					req.continue();
				} else {
					req.abort();
				}
			}
		});

		page.on('console', () => {});
		page.on('pageerror', () => {});

		await page.setViewport({ width: 1280, height: 720 });
		await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
		await page.setExtraHTTPHeaders({
			'Accept-Language': 'en-US,en;q=0.9',
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
			'Sec-Fetch-Site': 'none',
			'Sec-Fetch-Mode': 'navigate',
			'Sec-Fetch-User': '?1',
			'Sec-Fetch-Dest': 'document',
			'Upgrade-Insecure-Requests': '1',
		});

		// Override navigator properties that stealth plugin might miss
		await page.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
			Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
			Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
			// Make chrome object look real
			(window as unknown as Record<string, unknown>).chrome = {
				runtime: {},
				loadTimes: () => ({}),
				csi: () => ({}),
				app: {},
			};
		});

		await page.setDefaultTimeout(CONFIG.REQUEST_TIMEOUT_MS);
		await page.setDefaultNavigationTimeout(CONFIG.REQUEST_TIMEOUT_MS);

		const pooled: PooledPage = {
			page,
			busy: false,
			requestCount: 0,
			createdAt: Date.now(),
			lastBypassAt: new Map(),
			activeMirror: null,
		};

		this.pool.push(pooled);
		return pooled;
	}

	private _isHealthy(p: PooledPage): boolean {
		return Date.now() - p.createdAt <= CONFIG.PAGE_MAX_AGE_MS && p.requestCount < CONFIG.MAX_REQUESTS_PER_PAGE;
	}

	private async _recyclePage(pooled: PooledPage): Promise<void> {
		const idx = this.pool.indexOf(pooled);
		if (idx === -1) return;
		logger.debug(`Recycling page (requests: ${pooled.requestCount})`);
		this.pool.splice(idx, 1);
		await pooled.page.close().catch(() => {});
		await this._createPage();
	}

	private async _acquirePage(): Promise<PooledPage> {
		await this.init();

		const free = this.pool.find((p) => !p.busy && this._isHealthy(p));
		if (free) {
			free.busy = true;
			return free;
		}

		const stale = this.pool.find((p) => !p.busy);
		if (stale) {
			await this._recyclePage(stale);
			const fresh = this.pool[this.pool.length - 1];
			fresh.busy = true;
			return fresh;
		}

		throw new Error('POOL_EXHAUSTED');
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
			const free = this.pool.find((p) => !p.busy && this._isHealthy(p));
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

	// ─── Cloudflare Bypass ────────────────────────────────────────────────────

	/**
	 * Proper CF bypass strategy:
	 * 1. Navigate to the origin root (not the GraphQL endpoint directly)
	 * 2. Poll until CF challenge auto-solves (Managed Challenge can take 10-15s)
	 * 3. Verify the page is clean before proceeding
	 * 4. The page's cookie jar now holds valid cf_clearance cookies
	 *    which will automatically be sent with all subsequent XHR requests
	 */
	private async _bypassCloudflare(pooled: PooledPage, request: GraphQLRequest): Promise<void> {
		const origin = new URL(request.url).origin;
		const lastBypass = pooled.lastBypassAt.get(origin) ?? 0;

		if (pooled.activeMirror === origin && Date.now() - lastBypass <= CONFIG.CF_BYPASS_INTERVAL_MS) {
			return; // Still fresh
		}

		logger.debug({ origin }, 'Acquiring CF clearance');

		// Use mirrorRouter to find a clean mirror — updates request.url if rotated
		const cleanOrigin = await mirrorRouter.findCleanMirror(pooled.page, CONFIG.CF_SOLVE_TIMEOUT_MS);

		pooled.activeMirror = cleanOrigin;
		pooled.lastBypassAt.set(cleanOrigin, Date.now());

		if (cleanOrigin !== origin) {
			// Rewrite the request URL to the working mirror
			request.url = request.url.replace(origin, cleanOrigin);
			logger.info({ from: origin, to: cleanOrigin }, 'Mirror rotated');
		}

		// Brief pause after navigation to let CF cookies settle into the jar
		// before the XHR fires. 1.2s is safer than 800ms for slow CF challenges.
		await new Promise((r) => setTimeout(r, 1_200));
	}

	// ─── GraphQL Fetch ────────────────────────────────────────────────────────

	private async _executeRequest(pooled: PooledPage, request: GraphQLRequest): Promise<ProxyResponse> {
		const start = Date.now();
		await this._bypassCloudflare(pooled, request);
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

	/**
	 * Two-strategy fetch with automatic CF-block recovery.
	 *
	 * Strategy A (primary): page.evaluate XHR
	 *   — Runs inside the page context so cf_clearance cookies are sent automatically.
	 *   — Works when the page has a valid CF clearance already.
	 *
	 * Strategy B (fallback): waitForResponse interception
	 *   — Triggers the XHR from within the page, intercepts the response at the CDP level.
	 *   — Used when Strategy A returns 403 (clearance expired mid-session).
	 *   — Forces re-navigation to refresh clearance, then retries once.
	 */
	private async _cdpFetch(pooled: PooledPage, request: GraphQLRequest): Promise<ProxyResponse> {
		if (pooled.page.isClosed()) {
			throw new Error('Page is closed');
		}

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

		// Primary strategy — XHR inside page context inherits CF cookies from the jar
		const result = await pooled.page.evaluate(
			({ url, headers, body }) =>
				new Promise<{ success: boolean; status?: number; data?: unknown; error?: string }>((resolve) => {
					const xhr = new XMLHttpRequest();
					xhr.open('POST', url, true);
					for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
					xhr.timeout = 15_000;
					xhr.onload = () => {
						try {
							resolve({ success: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: JSON.parse(xhr.responseText) });
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

		// On CF block, invalidate current mirror clearance and rotate
		if (result.status === 403 || result.status === 503) {
			const origin = new URL(request.url).origin;
			logger.warn({ status: result.status, origin }, 'CF block on XHR — invalidating clearance and rotating mirror');

			// Invalidate so _bypassCloudflare forces a fresh navigation on next call
			pooled.lastBypassAt.delete(origin);
			pooled.activeMirror = null;
			mirrorRouter.markBlocked(origin);

			// Retry once with forced re-bypass instead of returning the 403 to caller.
			// This handles the case where CF clearance expires mid-session.
			logger.info('Retrying with fresh CF clearance...');
			await this._bypassCloudflare(pooled, request);

			return pooled.page.evaluate(
				({ url, headers, body }) =>
					new Promise<{ success: boolean; status?: number; data?: unknown; error?: string }>((resolve) => {
						const xhr = new XMLHttpRequest();
						xhr.open('POST', url, true);
						for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
						xhr.timeout = 15_000;
						xhr.onload = () => {
							try {
								resolve({ success: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: JSON.parse(xhr.responseText) });
							} catch {
								resolve({ success: false, status: xhr.status, error: `Failed to parse JSON on retry (status ${xhr.status})` });
							}
						};
						xhr.onerror = () => resolve({ success: false, error: 'XHR network error on retry' });
						xhr.ontimeout = () => resolve({ success: false, error: 'XHR timed out on retry' });
						xhr.send(body);
					}),
				{ url: request.url, headers, body },
			);
		}

		if (result.success) {
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
			queueLength: this.queue.length,
			initialized: this.initialized,
			heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
			mirrors: mirrorRouter.getStats(),
		};
	}

	// ─── Health Check ─────────────────────────────────────────────────────────

	private _startHealthCheck(): void {
		this.healthTimer = setInterval(async () => {
			const { heapMB, busyPages, queueLength } = this.getStats();
			logger.debug({ heapMB, busyPages, queueLength }, 'Health');

			if (heapMB > CONFIG.HEAP_RECYCLE_THRESHOLD_MB) {
				const oldest = this.pool.filter((p) => !p.busy).sort((a, b) => a.createdAt - b.createdAt)[0];
				if (oldest) {
					logger.warn({ heapMB }, 'High memory — recycling oldest page');
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

			this.pool = [];
			await this.browser?.close().catch(() => {});
			this.browser = null;

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
