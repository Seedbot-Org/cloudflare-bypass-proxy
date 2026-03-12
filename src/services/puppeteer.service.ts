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
	PAGE_MAX_AGE_MS: 15 * 60_000, // 15 min
	REQUEST_TIMEOUT_MS: 15_000, // reduced from 30s — fail fast
	QUEUE_TIMEOUT_MS: 30_000, // reduced from 60s
	CF_BYPASS_INTERVAL_MS: 4 * 60_000, // slightly under CF session TTL
	HEALTH_CHECK_INTERVAL_MS: 60_000, // every 1 min is enough
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

		// Residential proxy via env — required in datacenter environments (Railway, Render, etc.)
		// Cloudflare blocks datacenter IPs regardless of stealth headers.
		// Set RESIDENTIAL_PROXY_URL=http://user:pass@proxy-host:port
		// Recommended: Webshare (residential), Oxylabs, Smartproxy, Bright Data
		const proxyUrl = process.env.RESIDENTIAL_PROXY_URL;
		console.log('🚀 ~ PuppeteerService ~ _init ~ proxyUrl:', proxyUrl);
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

		// Aggressive resource blocking — only scripts + XHR needed for GraphQL
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const type = req.resourceType();
			if (type === 'document' || type === 'script' || type === 'xhr' || type === 'fetch') {
				req.continue();
			} else {
				req.abort();
			}
		});

		// Prevent memory build-up from console logs
		page.on('console', () => {});
		page.on('pageerror', () => {});

		await page.setViewport({ width: 1280, height: 720 });
		await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
		await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

		// Cap JS execution time to prevent runaway scripts
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

	private async _bypassCloudflare(pooled: PooledPage, request: GraphQLRequest): Promise<void> {
		const origin = new URL(request.url).origin;
		const lastBypass = pooled.lastBypassAt.get(origin) ?? 0;

		if (pooled.activeMirror === origin && Date.now() - lastBypass <= CONFIG.CF_BYPASS_INTERVAL_MS) {
			return; // Still fresh, skip navigation
		}

		const cleanOrigin = await mirrorRouter.findCleanMirror(pooled.page);

		// Minimal wait — CF sets cookies during navigation, not after
		await new Promise((r) => setTimeout(r, 800));

		pooled.activeMirror = cleanOrigin;
		pooled.lastBypassAt.set(cleanOrigin, Date.now());

		if (cleanOrigin !== origin) {
			request.url = `${cleanOrigin}${request.url.replace(origin, '')}`;
			logger.info({ from: origin, to: cleanOrigin }, 'Mirror rotated');
		}
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
					setTimeout(() => reject(new Error(`Timed out after ${CONFIG.REQUEST_TIMEOUT_MS}ms`)), CONFIG.REQUEST_TIMEOUT_MS)
				),
			]);
			return { ...result, timing: { duration: Date.now() - start } };
		} catch (err) {
			const msg = (err as Error).message ?? '';
			// Page was killed mid-request (browser crash race) — surface clearly
			if (msg.includes('Target closed') || msg.includes('Session closed')) {
				throw new Error('Page closed during request — browser may have crashed');
			}
			throw err;
		}
	}

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

		const result = await pooled.page.evaluate(
			({ url, headers, body }) =>
				new Promise<{ success: boolean; status?: number; data?: unknown; error?: string }>((resolve) => {
					const xhr = new XMLHttpRequest();
					xhr.open('POST', url, true);
					for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
					xhr.timeout = 12_000;
					xhr.onload = () => {
						try {
							resolve({ success: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: JSON.parse(xhr.responseText) });
						} catch {
							resolve({ success: false, status: xhr.status, error: 'Failed to parse JSON' });
						}
					};
					xhr.onerror = () => resolve({ success: false, error: 'XHR network error' });
					xhr.ontimeout = () => resolve({ success: false, error: 'XHR timed out' });
					xhr.send(body);
				}),
			{ url: request.url, headers, body }
		);

		if (result.status === 403 || result.status === 503) {
			const origin = new URL(request.url).origin;
			logger.warn({ status: result.status, origin }, 'CF block — rotating mirror');
			pooled.lastBypassAt.delete(origin);
			pooled.activeMirror = null;
			mirrorRouter.markBlocked(origin);
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

			// Pages are already dead — just clear references, don't try to close them
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
