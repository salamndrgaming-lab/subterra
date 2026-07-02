/**
 * Stripe billing — checkout, customer portal, and webhook verification.
 *
 * Calls the Stripe REST API directly with fetch (form-encoded) rather than
 * the stripe-node SDK, to keep the Worker bundle small and avoid Node
 * shims. Everything is inert until the Stripe env vars are set:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *   STRIPE_PRICE_PROSPECTOR / _OPERATOR / _ENTERPRISE,
 *   WEB_APP_URL (for redirect + return URLs).
 *
 * The webhook signature verifier uses Web Crypto (HMAC-SHA256) — the one
 * genuinely tricky bit, and the part that's unit-tested.
 */

import type { Env } from './index';

export type PaidTier = 'prospector' | 'operator' | 'enterprise';
export type Tier = 'free' | PaidTier;

const STRIPE_API = 'https://api.stripe.com/v1';

/** The Stripe price id configured for a paid tier, or null if unset. */
export function priceIdForTier(env: Env, tier: PaidTier): string | null {
  switch (tier) {
    case 'prospector':
      return env.STRIPE_PRICE_PROSPECTOR || null;
    case 'operator':
      return env.STRIPE_PRICE_OPERATOR || null;
    case 'enterprise':
      return env.STRIPE_PRICE_ENTERPRISE || null;
  }
}

/** Reverse map: which tier a Stripe price id grants. Unknown → null. */
export function tierForPriceId(env: Env, priceId: string): PaidTier | null {
  if (priceId && priceId === env.STRIPE_PRICE_PROSPECTOR) return 'prospector';
  if (priceId && priceId === env.STRIPE_PRICE_OPERATOR) return 'operator';
  if (priceId && priceId === env.STRIPE_PRICE_ENTERPRISE) return 'enterprise';
  return null;
}

/** Rank so tier comparisons ("at least Prospector") are simple. */
export const TIER_RANK: Record<Tier, number> = {
  free: 0,
  prospector: 1,
  operator: 2,
  enterprise: 3,
};

export function tierAtLeast(have: string, need: Tier): boolean {
  const h = (TIER_RANK as Record<string, number>)[have] ?? 0;
  return h >= TIER_RANK[need];
}

async function stripePost(
  env: Env,
  path: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: Object.entries(form)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&'),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (json.error as { message?: string } | undefined)?.message ?? res.statusText;
    throw new Error(`stripe ${path} ${res.status}: ${msg}`);
  }
  return json;
}

/** Create a subscription Checkout Session; returns its hosted URL. */
export async function createCheckoutSession(
  env: Env,
  args: {
    priceId: string;
    userId: string;
    email: string;
    customerId?: string | null;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<string> {
  const form: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': args.priceId,
    'line_items[0][quantity]': '1',
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    client_reference_id: args.userId,
    // Tie the subscription back to our user for the webhook.
    'subscription_data[metadata][user_id]': args.userId,
    allow_promotion_codes: 'true',
  };
  if (args.customerId) form.customer = args.customerId;
  else form.customer_email = args.email;
  const session = await stripePost(env, '/checkout/sessions', form);
  const url = session.url;
  if (typeof url !== 'string') throw new Error('stripe checkout: no url in response');
  return url;
}

/** Create a Billing Portal session so a customer can manage/cancel. */
export async function createPortalSession(
  env: Env,
  args: { customerId: string; returnUrl: string },
): Promise<string> {
  const session = await stripePost(env, '/billing_portal/sessions', {
    customer: args.customerId,
    return_url: args.returnUrl,
  });
  const url = session.url;
  if (typeof url !== 'string') throw new Error('stripe portal: no url in response');
  return url;
}

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header,
 * `t=...,v1=...`). Returns true iff a v1 signature matches
 * HMAC-SHA256(secret, `${t}.${payload}`) and the timestamp is within
 * `toleranceSec`. Constant-time-ish compare via Web Crypto.
 */
export async function verifyStripeSignature(
  payload: string,
  sigHeader: string | null | undefined,
  secret: string,
  nowSec: number,
  toleranceSec = 300,
): Promise<boolean> {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualHex(expected, v1);
}

/** Length-checked, constant-time hex compare. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
