// backend/src/app.js
import cors from 'cors';
import express from 'express';
import { apiErrorHandler, ApiError } from './errors/apiError.js';
import { createProviderBundle } from './providers.js';
import { createCaseRoutes } from './routes/cases.js';
import { createDialogueRoutes } from './routes/dialogue.js';
import { createSessionEndRoutes } from './routes/sessionEnd.js';

/**
 * @param {{
 *   providers?: ReturnType<typeof createProviderBundle>,
 *   casesDir?: string,
 *   promptsDir?: string,
 *   generateFeedbackFn?: import('./services/feedbackService.js').generateFeedback,
 * }} [deps]
 */
export function createApp(deps = {}) {
  const providers = deps.providers ?? createProviderBundle();
  const app = express();

  const corsOrigin = process.env.CORS_ORIGIN?.trim() || 'http://localhost:5174';
  app.use(
    cors({
      origin: corsOrigin,
      methods: ['GET', 'POST', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  // Attach providers for downstream modules (M4–M8) without leaking keys to clients.
  app.locals.providers = providers;

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      providers: providers.publicSummary,
    });
  });

  app.use(createCaseRoutes({ casesDir: deps.casesDir }));
  app.use(createDialogueRoutes({ casesDir: deps.casesDir, promptsDir: deps.promptsDir }));
  app.use(
    createSessionEndRoutes({
      casesDir: deps.casesDir,
      generateFeedbackFn: deps.generateFeedbackFn,
    }),
  );

  app.use((_req, _res, next) => {
    next(
      new ApiError({
        code: 'NOT_FOUND',
        message: 'Not found.',
        retryable: false,
        status: 404,
      }),
    );
  });

  app.use(apiErrorHandler);
  return app;
}
