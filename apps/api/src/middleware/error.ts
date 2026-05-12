import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'validation_error',
      message: 'Invalid request payload',
      issues: err.issues,
    });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  console.error('[api] unhandled error', err);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
};
