import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { logger } from './logger';
import { proxyRouter } from './routes/proxy.routes';
import { healthRouter } from './routes/health.routes';
import { mirrorRouter } from './services/mirror-router';
import { puppeteerService } from './services/puppeteer.service';

const app = express();

// Middleware
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGINS }));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
	logger.info({ method: req.method, path: req.path }, 'Incoming request');
	next();
});

// Routes
app.use('/health', healthRouter);
app.use('/api/proxy', proxyRouter);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
	logger.error({ err, path: req.path }, 'Unhandled error');
	res.status(500).json({ success: false, error: err.message });
});

async function start() {
	await mirrorRouter.discoverMirrors();

	puppeteerService.init().catch((err) => logger.error({ err }, 'Puppeteer init failed'));

	app.listen(config.PORT, () => {
		logger.info(`Proxy running on port ${config.PORT}`);
	});
}

start().catch((err) => {
	logger.error({ err }, 'Server failed to start');
	process.exit(1);
});
