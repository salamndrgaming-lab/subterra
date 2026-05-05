import { Router } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { SignJWT } from 'jose';
import { config } from '../config.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

const accessKey = new TextEncoder().encode(config.jwt.accessSecret);
const refreshKey = new TextEncoder().encode(config.jwt.refreshSecret);

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(80).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function issueTokens(user: { id: string; email: string; role: 'admin' | 'pro' | 'free' }) {
  const access = await new SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${config.jwt.accessTtlSeconds}s`)
    .sign(accessKey);

  const refresh = await new SignJWT({ type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${config.jwt.refreshTtlSeconds}s`)
    .sign(refreshKey);

  return { accessToken: access, refreshToken: refresh, expiresIn: config.jwt.accessTtlSeconds };
}

// In-memory user store for the scaffold. Replace with `users` table in Phase 2.
const memUsers = new Map<string, { id: string; email: string; passwordHash: string; displayName?: string; role: 'admin' | 'pro' | 'free' }>();

authRouter.post('/register', async (req, res, next) => {
  try {
    const body = RegisterBody.parse(req.body);
    if ([...memUsers.values()].some((u) => u.email === body.email)) {
      throw new HttpError(409, 'email_taken', 'Email already registered');
    }
    const id = crypto.randomUUID();
    const passwordHash = await argon2.hash(body.password);
    memUsers.set(id, { id, email: body.email, passwordHash, displayName: body.displayName, role: 'free' });
    const tokens = await issueTokens({ id, email: body.email, role: 'free' });
    res.status(201).json({ user: { id, email: body.email, displayName: body.displayName ?? null, role: 'free' }, tokens });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = LoginBody.parse(req.body);
    const user = [...memUsers.values()].find((u) => u.email === body.email);
    if (!user) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    const ok = await argon2.verify(user.passwordHash, body.password);
    if (!ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    const tokens = await issueTokens(user);
    res.json({ user: { id: user.id, email: user.email, displayName: user.displayName ?? null, role: user.role }, tokens });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const RefreshBody = z.object({ refreshToken: z.string() });
    const body = RefreshBody.parse(req.body);
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(body.refreshToken, refreshKey);
    const userId = String(payload.sub);
    const user = memUsers.get(userId);
    if (!user) throw new HttpError(401, 'invalid_token', 'Refresh token user not found');
    const tokens = await issueTokens(user);
    res.json({ tokens });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', requireAuth, (_req, res) => {
  // TODO: revoke refresh tokens by hash in DB.
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const user = memUsers.get(req.user!.id);
  if (!user) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName ?? null, role: user.role } });
});
