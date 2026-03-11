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

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
	POOL_SIZE: 3,
	MAX_REQUESTS_PER_PAGE: 50,
	PAGE_MAX_AGE_MS: 10 * 60_000,
	REQUEST_TIMEOUT_MS: 30_000,
	QUEUE_TIMEOUT_MS: 60_000,
	CF_BYPASS_INTERVAL_MS: 5 * 60_000,
	HEALTH_CHECK_INTERVAL_MS: 30_000,
	HEAP_RECYCLE_THRESHOLD_MB: 512,
	BROWSER_RESTART_DELAY_MS: 2_000,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface PooledPage {
	page: Page;
	busy: boolean;
	requestCount: number;
	createdAt: number;
	lastBypassAt: Map<string, number>; // origin -> timestamp
	activeMirror: string | null; // currently bypassed mirror origin
}

interface QueuedRequest {
	request: GraphQLRequest;
	resolve: (value: ProxyResponse) => void;
	reject: (reason: unknown) => void;
}

// ─── Service ──────────────────────────────────────────────────────────────────

class PuppeteerService {
	private browser: Browser | null = null;
	private pool: PooledPage[] = [];
	private queue: QueuedRequest[] = [];
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private shuttingDown = false;
	private healthTimer: NodeJS.Timeout | null = null;

	// ─── Init ──────────────────────────────────────────────────────────────────

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
				'--mute-audio',
				'--no-first-run',
				'--window-size=1920,1080',
				'--js-flags=--max-old-space-size=256',
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

	// ─── Page Management ───────────────────────────────────────────────────────

	private async _createPage(): Promise<PooledPage> {
		if (!this.browser) throw new Error('Browser not initialized');

		const page = await this.browser.newPage();

		// Block resources not needed for GraphQL to reduce memory/CPU
		await page.setRequestInterception(true);
		page.on('request', (req) => {
			const blocked = ['image', 'stylesheet', 'font', 'media', 'websocket'];
			blocked.includes(req.resourceType()) ? req.abort() : req.continue();
		});

		await page.setViewport({ width: 1920, height: 1080 });
		await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36');
		await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

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

	private _isHealthy(pooled: PooledPage): boolean {
		const tooOld = Date.now() - pooled.createdAt > CONFIG.PAGE_MAX_AGE_MS;
		const worn = pooled.requestCount >= CONFIG.MAX_REQUESTS_PER_PAGE;
		return !tooOld && !worn;
	}

	private async _recyclePage(pooled: PooledPage): Promise<void> {
		const idx = this.pool.indexOf(pooled);
		if (idx === -1) return;

		logger.debug(`Recycling page (requests: ${pooled.requestCount})`);
		await pooled.page.close().catch(() => {});
		this.pool.splice(idx, 1);
		await this._createPage();
	}

	private async _acquirePage(): Promise<PooledPage> {
		await this.init();

		// Prefer a free healthy page
		const free = this.pool.find((p) => !p.busy && this._isHealthy(p));
		if (free) {
			free.busy = true;
			return free;
		}

		// Recycle a free stale page
		const stale = this.pool.find((p) => !p.busy && !this._isHealthy(p));
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

	// ─── Queue ─────────────────────────────────────────────────────────────────

	private _enqueue(request: GraphQLRequest): Promise<ProxyResponse> {
		return new Promise((resolve, reject) => {
			const item: QueuedRequest = { request, resolve, reject };
			this.queue.push(item);

			setTimeout(() => {
				const idx = this.queue.indexOf(item);
				if (idx !== -1) {
					this.queue.splice(idx, 1);
					reject(new Error('Request timed out in queue'));
				}
			}, CONFIG.QUEUE_TIMEOUT_MS);
		});
	}

	private _drainQueue(): void {
		while (this.queue.length > 0) {
			const free = this.pool.find((p) => !p.busy && this._isHealthy(p));
			if (!free) break;

			const item = this.queue.shift()!;
			free.busy = true;

			this._executeRequest(free, item.request)
				.then(item.resolve)
				.catch(item.reject)
				.finally(() => this._releasePage(free));
		}
	}

	// ─── Cloudflare Bypass with Mirror Fallback ──────────────────────────────

	/**
	 * Ensures the page has a clean, CF-free mirror active.
	 * If the current mirror is blocked, automatically rotates to the next one
	 * and rewrites `request.url` to point at the working mirror.
	 */
	private async _bypassCloudflare(pooled: PooledPage, request: GraphQLRequest): Promise<void> {
		const requestedOrigin = new URL(request.url).origin;
		const lastBypass = pooled.lastBypassAt.get(requestedOrigin) ?? 0;

		// Still fresh — no navigation needed
		if (pooled.activeMirror === requestedOrigin && Date.now() - lastBypass <= CONFIG.CF_BYPASS_INTERVAL_MS) {
			return;
		}

		// Find a clean mirror (starts with the requested origin, falls back to others)
		const cleanOrigin = await mirrorRouter.findCleanMirror(pooled.page);

		// Give CF time to write its session cookies
		await new Promise((r) => setTimeout(r, 1_500));

		pooled.activeMirror = cleanOrigin;
		pooled.lastBypassAt.set(cleanOrigin, Date.now());

		// Rewrite the request URL to use the clean mirror
		if (cleanOrigin !== requestedOrigin) {
			const originalPath = request.url.replace(requestedOrigin, '');
			request.url = `${cleanOrigin}${originalPath}`;
			logger.info({ from: requestedOrigin, to: cleanOrigin }, 'Routed to mirror');
		}
	}

	// ─── GraphQL Fetch ─────────────────────────────────────────────────────────

	private async _executeRequest(pooled: PooledPage, request: GraphQLRequest): Promise<ProxyResponse> {
		const start = Date.now();

		await this._bypassCloudflare(pooled, request);
		pooled.requestCount++;

		const fetchResult = await Promise.race([
			this._cdpFetch(pooled, request),
			new Promise<ProxyResponse>((_, reject) =>
				setTimeout(() => reject(new Error(`Timed out after ${CONFIG.REQUEST_TIMEOUT_MS}ms`)), CONFIG.REQUEST_TIMEOUT_MS)
			),
		]);

		return { ...fetchResult, timing: { duration: Date.now() - start } };
	}

	private async _cdpFetch(pooled: PooledPage, request: GraphQLRequest): Promise<ProxyResponse> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		};
		if (request.accessToken) headers['x-access-token'] = request.accessToken;

		const body = JSON.stringify({
			query: request.query,
			variables: request.variables ?? {},
			operationName: request.operationName,
		});

		// Use page.evaluate but with XMLHttpRequest instead of fetch —
		// XHR inherits the page's cookie jar more reliably across CF setups
		const result = await pooled.page.evaluate(
			async ({ url, headers, body }) => {
				return new Promise<{ success: boolean; status?: number; data?: unknown; error?: string }>((resolve) => {
					const xhr = new XMLHttpRequest();
					xhr.open('POST', url, true);

					for (const [key, value] of Object.entries(headers)) {
						xhr.setRequestHeader(key, value);
					}

					xhr.onload = () => {
						try {
							resolve({ success: true, status: xhr.status, data: JSON.parse(xhr.responseText) });
						} catch {
							resolve({ success: false, status: xhr.status, error: 'Failed to parse response JSON' });
						}
					};

					xhr.onerror = () => resolve({ success: false, error: 'XHR network error' });
					xhr.ontimeout = () => resolve({ success: false, error: 'XHR timed out' });

					xhr.send(body);
				});
			},
			{ url: request.url, headers, body }
		);

		// If still blocked by CF, invalidate this mirror so next request rotates
		if (result.status === 403 || result.status === 503) {
			const origin = new URL(request.url).origin;
			logger.warn({ status: result.status, origin }, 'CF block on active mirror — rotating on next request');
			pooled.lastBypassAt.delete(origin);
			pooled.activeMirror = null;
			mirrorRouter.markBlocked(origin);
		} else {
			// Confirm the mirror is healthy after a successful response
			mirrorRouter.markHealthy(new URL(request.url).origin);
		}

		return result;
	}

	// ─── Public ────────────────────────────────────────────────────────────────

	async graphqlRequest(request: GraphQLRequest): Promise<ProxyResponse> {
		if (this.shuttingDown) {
			return { success: false, error: 'Service is shutting down' };
		}

		const start = Date.now();

		try {
			let pooled: PooledPage;

			try {
				pooled = await this._acquirePage();
			} catch (err) {
				if ((err as Error).message === 'POOL_EXHAUSTED') {
					logger.debug('Pool exhausted — queuing request');
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

	// ─── Health Check ──────────────────────────────────────────────────────────

	private _startHealthCheck(): void {
		this.healthTimer = setInterval(async () => {
			const { heapMB, busyPages, queueLength } = this.getStats();
			logger.debug({ heapMB, busyPages, queueLength }, 'Health check');

			if (heapMB > CONFIG.HEAP_RECYCLE_THRESHOLD_MB) {
				logger.warn({ heapMB }, 'High memory — recycling oldest free page');
				const oldest = this.pool.filter((p) => !p.busy).sort((a, b) => a.createdAt - b.createdAt)[0];
				if (oldest) await this._recyclePage(oldest);
			}
		}, CONFIG.HEALTH_CHECK_INTERVAL_MS);

		this.healthTimer.unref();
	}

	// ─── Crash Recovery ────────────────────────────────────────────────────────

	private async _restartBrowser(): Promise<void> {
		this.initialized = false;
		this.initPromise = null;
		this.pool = [];

		for (const item of this.queue.splice(0)) {
			item.reject(new Error('Browser crashed'));
		}

		await this.browser?.close().catch(() => {});
		this.browser = null;

		await new Promise((r) => setTimeout(r, CONFIG.BROWSER_RESTART_DELAY_MS));
		await this.init();
		logger.info('Browser restarted');
	}

	// ─── Shutdown ──────────────────────────────────────────────────────────────

	async close(): Promise<void> {
		this.shuttingDown = true;

		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}

		for (const item of this.queue.splice(0)) {
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

process.on('SIGINT', async () => {
	await puppeteerService.close();
	process.exit(0);
});
process.on('SIGTERM', async () => {
	await puppeteerService.close();
	process.exit(0);
});
