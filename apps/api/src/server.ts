import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { config } from './config.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { layersRouter } from './routes/layers.js';
import { wellsRouter } from './routes/wells.js';
import { claimsRouter } from './routes/claims.js';
import { parcelsRouter } from './routes/parcels.js';
import { searchRouter } from './routes/search.js';
import { scoreRouter } from './routes/score.js';
import { analyticsRouter } from './routes/analytics.js';
import { stakingRouter } from './routes/staking.js';
import { alertsRouter } from './routes/alerts.js';
import { projectsRouter } from './routes/projects.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.cors.origin, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(morgan(config.isProd ? 'combined' : 'dev'));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'subterra-api', ts: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/layers', layersRouter);
app.use('/api/wells', wellsRouter);
app.use('/api/claims', claimsRouter);
app.use('/api/parcels', parcelsRouter);
app.use('/api/search', searchRouter);
app.use('/api/score', scoreRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/staking', stakingRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/projects', projectsRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

app.use(errorHandler);

app.listen(config.port, config.host, () => {
  console.log(`[api] listening on http://${config.host}:${config.port}`);
});
