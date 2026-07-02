import { describe, expect, it } from 'vitest';

import {
  priceIdForTier,
  tierForPriceId,
  tierAtLeast,
  timingSafeEqualHex,
  verifyStripeSignature,
} from '../../apps/api/src/billing';

// Minimal Env stub for the pure mapping functions.
const ENV = {
  STRIPE_PRICE_PROSPECTOR: 'price_pro',
  STRIPE_PRICE_OPERATOR: 'price_op',
  STRIPE_PRICE_ENTERPRISE: 'price_ent',
} as unknown as Parameters<typeof priceIdForTier>[0];

/** Build a valid Stripe-Signature header for a payload (mirrors what
 *  Stripe does) so we can test the verifier without the real service. */
async function sign(payload: string, secret: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${hex}`;
}

describe('billing tier mapping', () => {
  it('maps tier → price and back', () => {
    expect(priceIdForTier(ENV, 'prospector')).toBe('price_pro');
    expect(priceIdForTier(ENV, 'enterprise')).toBe('price_ent');
    expect(tierForPriceId(ENV, 'price_op')).toBe('operator');
    expect(tierForPriceId(ENV, 'unknown')).toBeNull();
  });

  it('tierAtLeast ranks correctly', () => {
    expect(tierAtLeast('operator', 'prospector')).toBe(true);
    expect(tierAtLeast('free', 'prospector')).toBe(false);
    expect(tierAtLeast('enterprise', 'enterprise')).toBe(true);
    expect(tierAtLeast('bogus', 'prospector')).toBe(false);
  });
});

describe('timingSafeEqualHex', () => {
  it('true for equal, false for differing or mismatched-length', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
  });
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const payload = '{"type":"checkout.session.completed"}';

  it('accepts a valid, fresh signature', async () => {
    const t = 1_800_000_000;
    const header = await sign(payload, secret, t);
    expect(await verifyStripeSignature(payload, header, secret, t)).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const t = 1_800_000_000;
    const header = await sign(payload, secret, t);
    expect(await verifyStripeSignature(payload + 'x', header, secret, t)).toBe(false);
  });

  it('rejects a stale timestamp beyond tolerance', async () => {
    const t = 1_800_000_000;
    const header = await sign(payload, secret, t);
    expect(await verifyStripeSignature(payload, header, secret, t + 10_000)).toBe(false);
  });

  it('rejects a wrong secret, missing header, empty secret', async () => {
    const t = 1_800_000_000;
    const header = await sign(payload, secret, t);
    expect(await verifyStripeSignature(payload, header, 'whsec_wrong', t)).toBe(false);
    expect(await verifyStripeSignature(payload, null, secret, t)).toBe(false);
    expect(await verifyStripeSignature(payload, header, '', t)).toBe(false);
  });
});
