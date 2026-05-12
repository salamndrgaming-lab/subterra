import { Router } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { query, withTransaction } from '../db.js';

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

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: 'admin' | 'pro' | 'free';
  is_verified: boolean;
}

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

authRouter.post('/register', async (req, res, next) => {
  try {
    const body = RegisterBody.parse(req.body);
    const passwordHash = await argon2.hash(body.password);
    const inserted = await withTransaction(async (client) => {
      const existing = await client.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [body.email]);
      if (existing.rowCount && existing.rowCount > 0) {
        throw new HttpError(409, 'email_taken', 'Email already registered');
      }
      const r = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, display_name, role)
         VALUES ($1, $2, $3, 'free')
         RETURNING id, email, password_hash, display_name, role, is_verified`,
        [body.email, passwordHash, body.displayName ?? null],
      );
      return r.rows[0]!;
    });
    const tokens = await issueTokens({ id: inserted.id, email: inserted.email, role: inserted.role });
    res.status(201).json({
      user: { id: inserted.id, email: inserted.email, displayName: inserted.display_name, role: inserted.role },
      tokens,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = LoginBody.parse(req.body);
    const result = await query<UserRow>(
      `SELECT id, email, password_hash, display_name, role, is_verified FROM users WHERE email = $1`,
      [body.email],
    );
    const user = result.rows[0];
    if (!user) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    const ok = await argon2.verify(user.password_hash, body.password);
    if (!ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    const tokens = await issueTokens({ id: user.id, email: user.email, role: user.role });
    res.json({
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
      tokens,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const RefreshBody = z.object({ refreshToken: z.string() });
    const body = RefreshBody.parse(req.body);
    const { payload } = await jwtVerify(body.refreshToken, refreshKey);
    const userId = String(payload.sub);
    const result = await query<UserRow>(
      `SELECT id, email, password_hash, display_name, role, is_verified FROM users WHERE id = $1`,
      [userId],
    );
    const user = result.rows[0];
    if (!user) throw new HttpError(401, 'invalid_token', 'Refresh token user not found');
    const tokens = await issueTokens({ id: user.id, email: user.email, role: user.role });
    res.json({ tokens });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', requireAuth, (_req, res) => {
  // Refresh-token revocation tracked in `refresh_tokens` table; the access JWT
  // is short-lived and not stored. Phase 2 wires hash-based revocation.
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await query<UserRow>(
      `SELECT id, email, password_hash, display_name, role, is_verified FROM users WHERE id = $1`,
      [req.user!.id],
    );
    const user = result.rows[0];
    if (!user) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, isVerified: user.is_verified } });
  } catch (err) {
    next(err);
  }
});
