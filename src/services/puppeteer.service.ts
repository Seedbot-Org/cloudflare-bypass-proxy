import puppeteer, { Browser, Page } from 'puppeteer';
import { logger } from '../logger';

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

class PuppeteerService {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private isInitialized = false;
    private initPromise: Promise<void> | null = null;

    /**
     * Initialize browser with stealth mode
     */
    async init(): Promise<void> {
        if (this.isInitialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._doInit();
        return this.initPromise;
    }

    private async _doInit(): Promise<void> {
        try {
            logger.info('Launching Puppeteer browser...');

            // Dynamic import for puppeteer-extra
            const puppeteerExtra = await import('puppeteer-extra');
            const StealthPlugin = await import('puppeteer-extra-plugin-stealth');

            puppeteerExtra.default.use(StealthPlugin.default());

            const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            const launchOptions = {
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1920,1080',
                ],
                ...(executablePath ? { executablePath } : {}),
            };

            this.browser = await puppeteerExtra.default.launch(launchOptions);

            this.page = await this.browser.newPage();

            // Set realistic viewport and user agent
            await this.page.setViewport({ width: 1920, height: 1080 });
            await this.page.setUserAgent(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            // Set extra headers
            await this.page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
            });

            this.isInitialized = true;
            logger.info('Puppeteer browser initialized');
        } catch (error) {
            logger.error({ error }, 'Failed to initialize Puppeteer');
            throw error;
        }
    }

    /**
     * Navigate to a site to bypass Cloudflare
     */
    async bypassCloudflare(url: string): Promise<void> {
        await this.init();
        if (!this.page) throw new Error('Page not initialized');

        const urlObj = new URL(url);
        const baseUrl = urlObj.origin;

        logger.info({ url: baseUrl }, 'Navigating to bypass Cloudflare...');

        try {
            await this.page.goto(baseUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000,
            });

            // Wait for Cloudflare challenge to complete (if present)
            await this.page.waitForFunction(
                () => {
                    // Check if we're past Cloudflare challenge
                    return !document.title.includes('Just a moment');
                },
                { timeout: 30000 }
            ).catch(() => {
                // Timeout is fine, might not have Cloudflare
            });

            logger.info('Cloudflare bypass complete');
        } catch (error) {
            logger.warn({ error }, 'Navigation warning (continuing anyway)');
        }
    }

    /**
     * Make a GraphQL request from within the browser context
     */
    async graphqlRequest(request: GraphQLRequest): Promise<ProxyResponse> {
        const startTime = Date.now();

        try {
            await this.init();
            if (!this.page) throw new Error('Page not initialized');

            // First, navigate to bypass Cloudflare if needed
            await this.bypassCloudflare(request.url);

            logger.info({ url: request.url, operationName: request.operationName }, 'Making GraphQL request');

            // Execute fetch within the browser context
            const result = await this.page.evaluate(
                async ({ url, query, variables, operationName }) => {
                    try {
                        const response = await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-apollo-operation-name': operationName || 'GraphQLQuery',
                                'apollo-require-preflight': 'true',
                            },
                            body: JSON.stringify({
                                query,
                                variables,
                                operationName,
                            }),
                        });

                        const data = await response.json();
                        return {
                            success: true,
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

            const duration = Date.now() - startTime;

            return {
                ...result,
                timing: { duration },
            };
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

    /**
     * Close browser
     */
    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            this.isInitialized = false;
            this.initPromise = null;
            logger.info('Browser closed');
        }
    }
}

export const puppeteerService = new PuppeteerService();

// Graceful shutdown
process.on('SIGINT', async () => {
    await puppeteerService.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await puppeteerService.close();
    process.exit(0);
});
