// backend/src/errors/apiError.js
/** Shared API error envelope for JSON routes (§6). */

export class ApiError extends Error {
  /**
   * @param {object} opts
   * @param {string} opts.code
   * @param {string} opts.message
   * @param {boolean} [opts.retryable=false]
   * @param {number} [opts.status=500]
   * @param {unknown} [opts.details]
   */
  constructor({ code, message, retryable = false, status = 500, details }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    /** @type {{ code: string, message: string, retryable: boolean, details?: unknown }} */
    const body = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

/**
 * Express error middleware — sends ApiError envelope for known errors.
 * @param {unknown} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function apiErrorHandler(err, _req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message,
    retryable: true,
  });
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ retryable?: boolean, status?: number, details?: unknown }} [opts]
 */
export function createApiError(code, message, opts = {}) {
  return new ApiError({ code, message, ...opts });
}
