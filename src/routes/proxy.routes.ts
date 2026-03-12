import { Router, Request, Response, NextFunction } from 'express';
import { puppeteerService } from '../services/puppeteer.service';
import { config } from '../config';
import { logger } from '../logger';

const router: Router = Router();

// ─── Auth ─────────────────────────────────────────────────────────────────────

router.use((req: Request, res: Response, next: NextFunction) => {
	if (config.API_KEY && req.headers['x-api-key'] !== config.API_KEY) {
		return res.status(401).json({ success: false, error: 'Unauthorized' });
	}
	next();
});

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

const RATE_LIMIT = { MAX: 30, WINDOW_MS: 60_000 };
const ipHits = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
	const now = Date.now();
	for (const [ip, entry] of ipHits) {
		if (now - entry.windowStart > RATE_LIMIT.WINDOW_MS) ipHits.delete(ip);
	}
}, 5 * 60_000).unref();

router.use((req: Request, res: Response, next: NextFunction) => {
	const ip = req.ip ?? 'unknown';
	const now = Date.now();
	const entry = ipHits.get(ip);

	if (!entry || now - entry.windowStart > RATE_LIMIT.WINDOW_MS) {
		ipHits.set(ip, { count: 1, windowStart: now });
		return next();
	}

	if (++entry.count > RATE_LIMIT.MAX) {
		const retryAfter = Math.ceil((RATE_LIMIT.WINDOW_MS - (now - entry.windowStart)) / 1000);
		res.set('Retry-After', String(retryAfter));
		return res.status(429).json({ success: false, error: `Rate limit exceeded. Retry in ${retryAfter}s.` });
	}

	next();
});

// ─── Validation ───────────────────────────────────────────────────────────────

function validateBody(body: Record<string, unknown>): string | null {
	const { url, query, variables } = body;
	if (typeof url !== 'string' || !url.startsWith('https://')) return 'url must be a valid HTTPS URL';
	if (typeof query !== 'string' || !query.trim()) return 'query must be a non-empty string';
	if (query.length > 10_000) return 'query exceeds max length of 10,000 characters';
	if (variables !== undefined) {
		if (typeof variables !== 'object' || Array.isArray(variables)) return 'variables must be an object';
		if (JSON.stringify(variables).length > 5_000) return 'variables exceeds max size of 5,000 characters';
	}
	return null;
}

// ─── Deduplication ────────────────────────────────────────────────────────────
// Coalesces identical concurrent requests — prevents hammering Puppeteer

const inFlight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const existing = inFlight.get(key);
	if (existing) {
		logger.debug({ key }, 'Deduplicating in-flight request');
		return existing as Promise<T>;
	}
	const promise = fn().finally(() => inFlight.delete(key));
	inFlight.set(key, promise);
	setTimeout(() => inFlight.delete(key), 10_000).unref(); // safety eviction
	return promise;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/** POST /api/proxy/graphql — generic GraphQL proxy */
router.post('/graphql', async (req: Request, res: Response) => {
	const error = validateBody(req.body);
	if (error) return res.status(400).json({ success: false, error });

	const { url, query, variables, operationName, accessToken } = req.body;
	logger.info({ url, operationName }, 'GraphQL proxy request');

	const key = `${url}::${query.slice(0, 100)}::${JSON.stringify(variables ?? {})}`;
	const result = await dedupe(key, () => puppeteerService.graphqlRequest({ url, query, variables, operationName, accessToken })).catch((err) => ({
		success: false,
		error: err instanceof Error ? err.message : 'Internal error',
	}));

	res.status((result as { success: boolean }).success ? 200 : 500).json(result);
});

/** POST /api/proxy/stake/bet — Stake bet lookup */
router.post('/stake/bet', async (req: Request, res: Response) => {
	const { betId } = req.body;
	if (!betId) return res.status(400).json({ success: false, error: 'betId is required' });

	const query = `
		query LimboPreview($iid: String!) {
			bet(iid: $iid) {
				id iid
				bet {
					... on CasinoBet {
						...CasinoBet
						state { ...CasinoGameLimbo __typename }
						__typename
					}
					__typename
				}
				__typename
			}
		}
		fragment CasinoBet on CasinoBet {
			id active payoutMultiplier amountMultiplier amount payout updatedAt currency game
			user { id name __typename }
		}
		fragment CasinoGameLimbo on CasinoGameLimbo { result multiplierTarget }
	`;

	logger.info({ betId }, 'Stake bet lookup');

	const result = await dedupe(`stake::bet::${betId}`, () =>
		puppeteerService.graphqlRequest({
			url: 'https://stake.ac/_api/graphql',
			query,
			variables: { iid: betId },
			operationName: 'LimboPreview',
		})
	).catch((err) => ({ success: false, error: err instanceof Error ? err.message : 'Internal error' }));

	res.status((result as { success: boolean }).success ? 200 : 500).json(result);
});

/** GET /api/proxy/stats — pool health */
router.get('/stats', (_req: Request, res: Response) => {
	res.json(puppeteerService.getStats());
});

export { router as proxyRouter };
