import cors from 'cors';
import express from 'express';
import { apiErrorHandler, ApiError } from './errors/apiError.js';
import { createProviderBundle } from './providers.js';
import { createCaseRoutes } from './routes/cases.js';
import { createDialogueRoutes } from './routes/dialogue.js';
import { createSessionEndRoutes } from './routes/sessionEnd.js';
import { createSpeechRoutes } from './routes/speech.js';
import { activeSessionRegistry as defaultActiveSessionRegistry } from './services/activeSessionRegistry.js';

const DEFAULT_CORS_ORIGIN = 'http://localhost:5174';
// 60 validated transcript items can each contain 2,000 characters. One MiB
// remains bounded while accommodating worst-case JSON escaping overhead.
const JSON_BODY_LIMIT = '1mb';

function knownCorsOrigins(value) {
  const entries = (value || DEFAULT_CORS_ORIGIN)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 || entries.includes('*')) {
    throw new Error('CORS config invalid: provide one or more explicit known origins');
  }
  return entries.map((entry) => {
    let parsed;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(`CORS config invalid: "${entry}" is not a valid origin`);
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(`CORS config invalid: "${entry}" must be an HTTP(S) origin`);
    }
    return parsed.origin;
  });
}

/**
 * @param {{
 *   providers?: ReturnType<typeof createProviderBundle>,
 *   activeSessionRegistry?: object,
 *   casesDir?: string,
 *   promptsDir?: string,
 *   generateFeedbackFn?: import('./services/feedbackService.js').generateFeedback,
 *   corsOrigins?: string,
 * }} [deps]
 */
export function createApp(deps = {}) {
  const providers = deps.providers ?? createProviderBundle();
  const activeSessionRegistry =
    deps.activeSessionRegistry ?? defaultActiveSessionRegistry;
  const app = express();
  const allowedOrigins = knownCorsOrigins(
    deps.corsOrigins ?? process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN,
  );

  app.use(
    cors({
      origin(origin, callback) {
        callback(null, !origin || allowedOrigins.includes(origin));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.locals.providers = providers;
  app.locals.activeSessionRegistry = activeSessionRegistry;
  app.locals.llmProvider = providers.llmProvider;
  app.locals.foundry = providers.foundry;
  app.locals.ttsProvider = providers.tts;

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, providers: providers.publicSummary });
  });

  app.use(createCaseRoutes({ casesDir: deps.casesDir, activeSessionRegistry }));
  app.use(
    createDialogueRoutes({
      activeSessionRegistry,
      llmProvider: providers.llmProvider,
      promptsDir: deps.promptsDir,
    }),
  );
  app.use(
    createSpeechRoutes({
      activeSessionRegistry,
      ttsProvider: providers.tts,
      casesDir: deps.casesDir,
    }),
  );
  app.use(
    createSessionEndRoutes({
      activeSessionRegistry,
      llmProvider: providers.llmProvider,
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

  app.use((error, _req, _res, next) => {
    if (error instanceof ApiError) {
      next(error);
      return;
    }
    if (error?.type === 'entity.too.large') {
      next(
        new ApiError({
          code: 'REQUEST_TOO_LARGE',
          message: 'Request body is too large.',
          retryable: false,
          status: 413,
        }),
      );
      return;
    }
    if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
      next(
        new ApiError({
          code: 'VALIDATION',
          message: 'Request body must contain valid JSON.',
          retryable: false,
          status: 400,
        }),
      );
      return;
    }
    next(
      new ApiError({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        retryable: true,
        status: 500,
      }),
    );
  });
  app.use(apiErrorHandler);
  return app;
}
