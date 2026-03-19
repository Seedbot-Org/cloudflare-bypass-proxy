import { connect } from 'puppeteer-real-browser';
import { logger } from '../logger';

// puppeteer-real-browser uses rebrowser-puppeteer-core types internally,
// which are not directly compatible with puppeteer v24 types.
// We use loose typing here to avoid version conflicts.
type AnyBrowser = any;
type AnyPage = any;

export interface GraphQLRequest {
    url: string;
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
}

export interface ProxyResponse {
    success: boolean;
    status?: number;
    data?: unknown;
    error?: string;
    timing?: {
        duration: number;
    };
}

const MAX_CF_WAIT_MS = 60000;
const CF_POLL_INTERVAL_MS = 2000;

class PuppeteerService {
    private browser: AnyBrowser = null;
    private page: AnyPage = null;
    private isInitialized = false;
    private initPromise: Promise<void> | null = null;
    private navigatedOrigins: Set<string> = new Set();

    async init(): Promise<void> {
        if (this.isInitialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._doInit();

        return this.initPromise;
    }

    private async _doInit(): Promise<void> {
        try {
            logger.info('Launching browser via puppeteer-real-browser...');

            const { browser, page } = await connect({
                headless: false,
                turnstile: true,
                disableXvfb: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1920,1080',
                ],
            });

            this.browser = browser;
            this.page = page;

            await page.setViewport({ width: 1920, height: 1080 });

            this.isInitialized = true;
            logger.info('Browser initialized with Turnstile support');
        } catch (error) {
            logger.error({ error }, 'Failed to initialize browser');
            this.initPromise = null;
            throw error;
        }
    }

    /**
     * Wait for Cloudflare challenge to clear on the page.
     * Returns true if challenge cleared, false if timed out.
     */
    private async waitForCloudflareClear(page: AnyPage): Promise<boolean> {
        const deadline = Date.now() + MAX_CF_WAIT_MS;
        while (Date.now() < deadline) {
            const title = await page.title().catch(() => '');
            if (!title.includes('Just a moment')) {
                logger.info('Cloudflare challenge cleared');
                return true;
            }
            logger.info('Waiting for Cloudflare challenge to resolve...');
            await new Promise(r => setTimeout(r, CF_POLL_INTERVAL_MS));
        }
        logger.warn('Cloudflare challenge did not clear within timeout');
        return false;
    }

    /**
     * Navigate to origin and wait for Cloudflare to resolve.
     * puppeteer-real-browser handles Turnstile automatically via turnstile:true.
     */
    async bypassCloudflare(origin: string): Promise<void> {
        await this.init();
        if (!this.page) throw new Error('Page not initialized');

        if (this.navigatedOrigins.has(origin)) {
            const currentUrl = this.page.url();
            if (currentUrl.startsWith(origin)) {
                const title = await this.page.title().catch(() => '');
                if (!title.includes('Just a moment')) {
                    return;
                }
                logger.info({ origin }, 'Page stuck on challenge, waiting for auto-solve...');
                await this.waitForCloudflareClear(this.page);
                return;
            }
        }

        logger.info({ origin }, 'Navigating to bypass Cloudflare...');

        try {
            await this.page.goto(origin, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });

            const cleared = await this.waitForCloudflareClear(this.page);

            if (cleared) {
                await new Promise(r => setTimeout(r, 2000));
                this.navigatedOrigins.add(origin);
                logger.info({ origin }, 'Cloudflare bypass complete');
            } else {
                logger.error({ origin }, 'Cloudflare bypass FAILED — challenge did not clear');
            }
        } catch (error) {
            logger.warn({ error }, 'Cloudflare bypass navigation warning (continuing anyway)');
        }
    }

    /**
     * Execute a GraphQL fetch on the persistent page.
     */
    private async executeGraphQL(
        request: GraphQLRequest,
    ): Promise<{ success: boolean; status?: number; data?: unknown; error?: string }> {
        if (!this.page) throw new Error('Page not initialized');

        return this.page.evaluate(
            async ({ url, query, variables, operationName }: { url: string; query: string; variables?: Record<string, unknown>; operationName?: string }) => {
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-apollo-operation-name': operationName || 'GraphQLQuery',
                            'apollo-require-preflight': 'true',
                        },
                        body: JSON.stringify({ query, variables, operationName }),
                    });

                    const rawText = await response.text();
                    let data: unknown;
                    try {
                        data = JSON.parse(rawText);
                    } catch {
                        return {
                            success: false,
                            status: response.status,
                            error: `Non-JSON response (status ${response.status})`,
                        };
                    }

                    return {
                        success: response.ok,
                        status: response.status,
                        data,
                    };
                } catch (error) {
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : 'Fetch failed',
                    };
                }
            },
            {
                url: request.url,
                query: request.query,
                variables: request.variables,
                operationName: request.operationName,
            }
        );
    }

    /**
     * Make a GraphQL request from within the browser context
     */
    async graphqlRequest(request: GraphQLRequest): Promise<ProxyResponse> {
        const startTime = Date.now();

        try {
            await this.init();

            const origin = new URL(request.url).origin;
            await this.bypassCloudflare(origin);

            logger.info(
                { url: request.url, operationName: request.operationName },
                'Making GraphQL request',
            );

            let result: { success: boolean; status?: number; data?: unknown; error?: string };

            try {
                result = await this.executeGraphQL(request);
            } catch (error) {
                const msg = error instanceof Error ? error.message : '';
                if (msg.includes('Execution context was destroyed') || msg.includes('navigation')) {
                    logger.warn('Execution context lost, re-bypassing Cloudflare...');
                    this.navigatedOrigins.delete(origin);
                    await this.bypassCloudflare(origin);
                    result = await this.executeGraphQL(request);
                } else {
                    throw error;
                }
            }

            // If Cloudflare blocked us, re-bypass and retry once
            if (!result.success && result.error?.includes('Non-JSON response') && result.status === 403) {
                logger.warn('Got Cloudflare 403, re-bypassing and retrying...');
                this.navigatedOrigins.delete(origin);
                await this.bypassCloudflare(origin);
                result = await this.executeGraphQL(request);
            }

            return { ...result, timing: { duration: Date.now() - startTime } };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ error: errorMessage }, 'GraphQL request failed');
            return {
                success: false,
                error: errorMessage,
                timing: { duration: Date.now() - startTime },
            };
        }
    }

    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            this.isInitialized = false;
            this.initPromise = null;
            this.navigatedOrigins.clear();
            logger.info('Browser closed');
        }
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