import type { RequestHandler } from 'express';
import { jwtVerify } from 'jose';
import { config } from '../config.js';
import { HttpError } from './error.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: { id: string; email: string; role: 'admin' | 'pro' | 'free' };
  }
}

const accessKey = new TextEncoder().encode(config.jwt.accessSecret);

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return next(new HttpError(401, 'unauthorized', 'Missing bearer token'));
  }
  const token = header.slice('Bearer '.length);
  try {
    const { payload } = await jwtVerify(token, accessKey);
    req.user = {
      id: String(payload.sub),
      email: String(payload['email'] ?? ''),
      role: (payload['role'] as 'admin' | 'pro' | 'free') ?? 'free',
    };
    next();
  } catch {
    next(new HttpError(401, 'unauthorized', 'Invalid or expired token'));
  }
};

export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next();
  const token = header.slice('Bearer '.length);
  try {
    const { payload } = await jwtVerify(token, accessKey);
    req.user = {
      id: String(payload.sub),
      email: String(payload['email'] ?? ''),
      role: (payload['role'] as 'admin' | 'pro' | 'free') ?? 'free',
    };
  } catch {
    // ignore — treat as anonymous
  }
  next();
};
