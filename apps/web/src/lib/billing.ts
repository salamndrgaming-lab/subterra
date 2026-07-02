/** Client for the /billing Worker routes — start checkout, open the
 *  customer portal. All requests carry the session cookie. */

import { API_BASE } from './api-base';

const API_URL = API_BASE;

export type PaidTier = 'prospector' | 'operator' | 'enterprise';

/** Start a Stripe Checkout for `tier`; redirects the browser to Stripe.
 *  Throws BILLING_UNAVAILABLE if billing isn't configured server-side, or
 *  UNAUTHENTICATED if not signed in — callers surface the right prompt. */
export async function startCheckout(tier: PaidTier): Promise<void> {
  const res = await fetch(`${API_URL}/billing/checkout`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (res.status === 503) throw new Error('BILLING_UNAVAILABLE');
  if (!res.ok) throw new Error(`checkout failed: HTTP ${res.status}`);
  const body = (await res.json()) as { url: string };
  window.location.href = body.url;
}

/** Open the Stripe billing portal (manage/cancel). Redirects on success. */
export async function openBillingPortal(): Promise<void> {
  const res = await fetch(`${API_URL}/billing/portal`, {
    method: 'POST',
    credentials: 'include',
  });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (res.status === 503) throw new Error('BILLING_UNAVAILABLE');
  if (!res.ok) throw new Error(`portal failed: HTTP ${res.status}`);
  const body = (await res.json()) as { url: string };
  window.location.href = body.url;
}
