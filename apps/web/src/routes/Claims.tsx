/** /claims — BLM maintenance-fee tracker.
 *
 *  Lists every claim the user has marked as theirs + a big countdown
 *  to the next Sept 1 deadline (BLM annual maintenance fee).
 *
 *  Add flow: paste any number of serials (whitespace-separated) →
 *  client splits, server validates + dedupes via UNIQUE(user_id, serial).
 *
 *  Unauthenticated → redirect (link to /signin) instead of an error. */

import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchMe } from '@/lib/auth';
import { fetchAlerts, setAlertEnabled, deleteAlert } from '@/lib/alerts';
import {
  addTrackedClaims,
  daysUntil,
  deleteTrackedClaim,
  fetchTrackedClaims,
  nextMaintenanceFeeDate,
  type TrackedClaim,
} from '@/lib/my-claims';

export function ClaimsPage() {
  const me = useQuery({ queryKey: ['auth', 'me'], queryFn: fetchMe, retry: 0 });

  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <span className="font-mono text-[11px] text-text-muted">Loading…</span>
      </div>
    );
  }
  if (!me.data) {
    return <Navigate to="/signin" replace />;
  }
  return <SignedInClaims />;
}

function SignedInClaims() {
  const queryClient = useQueryClient();
  const claimsQuery = useQuery({
    queryKey: ['my-claims'],
    queryFn: fetchTrackedClaims,
    retry: 0,
  });
  const claims = claimsQuery.data ?? [];
  const deadline = nextMaintenanceFeeDate();
  const days = daysUntil(deadline);

  return (
    <div className="min-h-screen bg-bg p-6 text-text">
      <div className="mx-auto max-w-3xl">
        <Link
          to="/map"
          className="block font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text"
        >
          ← Map
        </Link>
        <h1 className="mt-2 font-mono text-xl text-text">My BLM mining claims</h1>
        <p className="mt-1 font-mono text-[12px] text-text-muted">
          Track claim serials and never miss a Sept 1 annual-fee deadline.
        </p>

        <Countdown days={days} deadline={deadline} claimCount={claims.length} />
        <AddClaimsForm onAdded={() => void queryClient.invalidateQueries({ queryKey: ['my-claims'] })} />
        <ClaimsList
          claims={claims}
          loading={claimsQuery.isLoading}
          onDeleted={() => void queryClient.invalidateQueries({ queryKey: ['my-claims'] })}
        />

        <AlertsManager />
      </div>
    </div>
  );
}

/** Watched-area alerts — list, enable/disable, and delete. Created from
 *  the map's "Watch this area" action; this is where they're managed. */
function AlertsManager() {
  const queryClient = useQueryClient();
  const alertsQuery = useQuery({ queryKey: ['alerts'], queryFn: fetchAlerts, retry: 0 });
  const alerts = alertsQuery.data ?? [];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['alerts'] });

  const kindLabel = (k: string) =>
    k === 'permit_filed' ? 'New drilling permits' : k === 'new_claim_filed' ? 'New mining claims' : k;

  return (
    <section className="mt-8">
      <h2 className="font-mono text-lg text-text">Area alerts</h2>
      <p className="mt-1 font-mono text-[12px] text-text-muted">
        Weekly email when new activity lands inside an area you&rsquo;re watching. Draw an area on the
        {' '}
        <Link to="/map" className="text-accent hover:underline">
          map
        </Link>{' '}
        and choose &ldquo;Watch this area&rdquo;.
      </p>
      {alerts.length === 0 ? (
        <div className="mt-3 rounded-lg border border-border bg-bg-surface p-4 font-mono text-[12px] text-text-muted">
          No area alerts yet.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {alerts.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-bg-surface p-3 font-mono text-[12px]"
            >
              <span
                aria-hidden
                className={`h-2 w-2 shrink-0 rounded-full ${a.isEnabled ? 'bg-success' : 'bg-border-strong'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-text">{a.name}</div>
                <div className="text-text-muted">{kindLabel(a.eventKind)}</div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await setAlertEnabled(a.id, !a.isEnabled);
                  refresh();
                }}
                className="rounded border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text"
              >
                {a.isEnabled ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                onClick={async () => {
                  await deleteAlert(a.id);
                  refresh();
                }}
                className="rounded border border-border px-2 py-1 text-[11px] text-red-400 hover:border-red-500/50"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Countdown({
  days,
  deadline,
  claimCount,
}: {
  days: number;
  deadline: Date;
  claimCount: number;
}) {
  // Tone tracks urgency:
  //   > 60 days: green (plenty of time)
  //   30-60 days: amber (start gathering paperwork)
  //   < 30 days: red (file now)
  const tone =
    days > 60
      ? { border: 'border-success/40', text: 'text-success', dot: 'bg-success' }
      : days > 30
        ? { border: 'border-amber-500/40', text: 'text-amber-400', dot: 'bg-amber-400' }
        : { border: 'border-red-500/40', text: 'text-red-400', dot: 'bg-red-400' };
  return (
    <section
      data-testid="fee-countdown"
      data-days={days}
      className={`mt-5 rounded-lg border ${tone.border} bg-bg-surface p-5 font-mono`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Next maintenance-fee deadline
          </div>
          <div className="mt-1 font-mono text-[12px] text-text">
            {deadline.toISOString().slice(0, 10)} · BLM annual fees
          </div>
        </div>
        <div className={`text-right ${tone.text}`}>
          <div className="flex items-baseline gap-2">
            <span aria-hidden className={`h-2 w-2 rounded-full ${tone.dot}`} />
            <span className="font-mono text-3xl font-bold">{Math.max(0, days)}</span>
            <span className="font-mono text-[12px]">days</span>
          </div>
        </div>
      </div>
      <p className="mt-4 font-mono text-[11px] leading-relaxed text-text-muted">
        Pay at{' '}
        <a
          href="https://mlrs.blm.gov/s/"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          BLM MLRS ↗
        </a>{' '}
        ({claimCount} claim{claimCount === 1 ? '' : 's'} tracked × $200/claim ={' '}
        <span className="text-text">${(claimCount * 200).toLocaleString()}</span> due).
      </p>
    </section>
  );
}

function AddClaimsForm({ onAdded }: { onAdded: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ added: number; skipped: number } | null>(null);
  const mutation = useMutation({
    mutationFn: (serials: string[]) => addTrackedClaims(serials),
    onSuccess: (data) => {
      setResult({ added: data.added, skipped: data.skipped });
      setText('');
      onAdded();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const serials = text
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (serials.length === 0) return;
    setResult(null);
    mutation.mutate(serials);
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 rounded-lg border border-border bg-bg-surface p-5">
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Add claim serials (paste one or many, whitespace or comma-separated)
        </span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="NMC1234567 NMC1234568 NMC1234569"
          data-testid="add-claims-input"
          className="mt-1 w-full rounded-md border border-border bg-bg-panel px-3 py-2 font-mono text-[12px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </label>
      <div className="mt-2 flex items-center justify-between">
        <button
          type="submit"
          disabled={mutation.isPending || !text.trim()}
          data-testid="add-claims-submit"
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? 'Adding…' : 'Track claims'}
        </button>
        {result && (
          <span data-testid="add-claims-result" className="font-mono text-[11px] text-text-muted">
            <span className="text-success">Added {result.added}</span>
            {result.skipped > 0 && (
              <span className="text-text-muted"> · {result.skipped} duplicate{result.skipped === 1 ? '' : 's'} skipped</span>
            )}
          </span>
        )}
        {mutation.isError && (
          <span className="font-mono text-[11px] text-red-400">
            {(mutation.error as Error).message}
          </span>
        )}
      </div>
    </form>
  );
}

function ClaimsList({
  claims,
  loading,
  onDeleted,
}: {
  claims: TrackedClaim[];
  loading: boolean;
  onDeleted: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (id: string) => deleteTrackedClaim(id),
    onSuccess: onDeleted,
  });
  if (loading) {
    return <p className="mt-5 font-mono text-[11px] text-text-muted">Loading claims…</p>;
  }
  if (claims.length === 0) {
    return (
      <p
        data-testid="claims-empty"
        className="mt-5 rounded-lg border border-dashed border-border bg-bg-surface/40 p-6 text-center font-mono text-[12px] text-text-muted"
      >
        No claims tracked yet. Paste a serial above to start the countdown.
      </p>
    );
  }
  return (
    <ul data-testid="tracked-claims" className="mt-5 divide-y divide-border rounded-lg border border-border bg-bg-surface">
      {claims.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2">
          <div className="min-w-0 font-mono text-[12px]">
            <div className="truncate text-text">{c.serial}</div>
            {c.name && <div className="truncate text-[10px] text-text-muted">{c.name}</div>}
          </div>
          <button
            type="button"
            onClick={() => mutation.mutate(c.id)}
            disabled={mutation.isPending}
            data-testid={`remove-claim-${c.serial}`}
            className="rounded border border-border bg-bg-panel px-2 py-1 font-mono text-[10px] text-text-muted hover:border-red-500/40 hover:text-red-400"
          >
            remove
          </button>
        </li>
      ))}
    </ul>
  );
}
