/** Pricing / upgrade page. Tiers mirror the strategy memo; the paid
 *  tiers start a Stripe Checkout. Free is always available. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { fetchMe } from '@/lib/auth';
import { startCheckout, type PaidTier } from '@/lib/billing';

interface Plan {
  tier: 'free' | PaidTier;
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  features: string[];
}

const PLANS: Plan[] = [
  {
    tier: 'free',
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    blurb: 'The map + stake-clarity for anyone.',
    features: ['Full map + all data layers', 'Stake-ability overlay', 'Cross-sections', '5 saved areas'],
  },
  {
    tier: 'prospector',
    name: 'Prospector',
    price: '$29',
    cadence: '/mo',
    blurb: 'For the active staker.',
    features: [
      'Everything in Free',
      'Unlimited saved areas',
      'Weekly claim + permit alerts',
      'Maintenance-fee tracker',
      'Staking-packet PDF export',
    ],
  },
  {
    tier: 'operator',
    name: 'Operator',
    price: '$149',
    cadence: '/mo',
    blurb: 'For syndicates + landmen.',
    features: [
      'Everything in Prospector',
      'Bulk claim import',
      'Operator-intel panel',
      '3 team seats',
      'CSV exports',
    ],
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    cadence: '',
    blurb: 'For mining teams + juniors.',
    features: ['Everything in Operator', 'API access', 'White-label', 'Custom data layers', 'SLA + CSM'],
  },
];

export function PricingPage() {
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: fetchMe, retry: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const currentTier = me.data?.tier ?? 'free';

  const onPick = async (tier: 'free' | PaidTier) => {
    if (tier === 'free' || tier === 'enterprise') return;
    if (!me.data) {
      setNotice('Sign in first to upgrade.');
      return;
    }
    setBusy(tier);
    setNotice(null);
    try {
      await startCheckout(tier);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(
        msg === 'BILLING_UNAVAILABLE'
          ? 'Billing is coming soon — payments aren’t live yet.'
          : msg === 'UNAUTHENTICATED'
            ? 'Please sign in to upgrade.'
            : 'Could not start checkout. Try again.',
      );
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen bg-bg p-6 text-text">
      <div className="mx-auto max-w-5xl">
        <Link
          to="/map"
          className="block font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text"
        >
          ← Map
        </Link>
        <h1 className="mt-2 font-mono text-2xl text-text">Plans</h1>
        <p className="mt-1 font-mono text-[12px] text-text-muted">
          Start free. Upgrade when you need alerts, exports, or a team.
        </p>
        {notice && (
          <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-[12px] text-amber-300">
            {notice}
          </div>
        )}

        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((p) => {
            const isCurrent = currentTier === p.tier;
            return (
              <div
                key={p.tier}
                data-testid={`plan-${p.tier}`}
                className={`flex flex-col rounded-lg border p-5 ${
                  isCurrent ? 'border-accent bg-accent/5' : 'border-border bg-bg-surface'
                }`}
              >
                <div className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
                  {p.name}
                </div>
                <div className="mt-1 font-mono text-2xl text-text">
                  {p.price}
                  <span className="text-[12px] text-text-muted">{p.cadence}</span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-text-muted">{p.blurb}</div>
                <ul className="mt-3 flex-1 space-y-1 font-mono text-[11px] text-text">
                  {p.features.map((f) => (
                    <li key={f} className="flex gap-1.5">
                      <span className="text-accent">·</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  {isCurrent ? (
                    <div className="rounded border border-border px-3 py-2 text-center font-mono text-[11px] text-text-muted">
                      Current plan
                    </div>
                  ) : p.tier === 'free' ? (
                    <Link
                      to="/map"
                      className="block rounded border border-border px-3 py-2 text-center font-mono text-[11px] text-text hover:border-accent"
                    >
                      Use free
                    </Link>
                  ) : p.tier === 'enterprise' ? (
                    <a
                      href="mailto:sales@subterra.app?subject=Enterprise"
                      className="block rounded border border-border px-3 py-2 text-center font-mono text-[11px] text-text hover:border-accent"
                    >
                      Contact us
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onPick(p.tier)}
                      disabled={busy === p.tier}
                      className="w-full rounded border border-accent bg-accent/10 px-3 py-2 text-center font-mono text-[11px] text-accent hover:bg-accent/20 disabled:opacity-60"
                    >
                      {busy === p.tier ? 'Starting…' : `Upgrade to ${p.name}`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
