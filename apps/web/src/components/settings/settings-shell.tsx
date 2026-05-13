'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';

export function SettingsShell() {
  const tokens = useAuthStore((s) => s.tokens);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.auth.me(),
    enabled: !!tokens,
  });
  const health = useQuery({
    queryKey: ['sources-health-settings'],
    queryFn: () => api.sources.health(),
    refetchInterval: 30_000,
  });

  return (
    <main className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto px-6 py-8">
      <h1 className="font-display text-3xl text-text">Settings</h1>
      <p className="mt-2 text-sm text-text-subtle">Account, session, data-source health.</p>

      <section className="mt-6 space-y-4">
        <Group title="Account">
          {!tokens ? (
            <div className="font-mono text-xs text-text-subtle">
              Not signed in.{' '}
              <Link href="/auth/login" className="text-accent hover:underline">Sign in</Link>{' '}
              or <Link href="/auth/register" className="text-accent hover:underline">create an account</Link>.
            </div>
          ) : me.isLoading ? (
            <div className="font-mono text-xs text-text-muted">Loading…</div>
          ) : me.data ? (
            <>
              <Row label="Email" value={me.data.user.email} />
              <Row label="Display name" value={me.data.user.displayName ?? '—'} />
              <Row label="Plan" value={me.data.user.role} />
              <Row label="Verified" value={me.data.user.isVerified ? 'yes' : 'no'} />
              <Row label="User ID" value={me.data.user.id} mono />
            </>
          ) : (
            <div className="font-mono text-xs text-danger">
              Session expired. <Link href="/auth/login" className="text-accent hover:underline">Sign in again</Link>.
            </div>
          )}
        </Group>

        <Group title="Map preferences">
          <Row label="Default style" value="OpenFreeMap dark (MapLibre)" />
          <Row label="Units" value="imperial (ft, mi, ac)" />
        </Group>

        <Group title="Data source health">
          {health.isLoading || !health.data ? (
            <div className="font-mono text-xs text-text-muted">Probing upstreams…</div>
          ) : (
            <>
              <Row label="Overall" value={health.data.overall} />
              <ul className="mt-2 space-y-1 font-mono text-[11px]">
                {health.data.sources.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 border-b border-border/40 pb-1.5">
                    <span className="flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          s.status === 'ok' ? 'bg-success' : s.status === 'degraded' ? 'bg-accent' : 'bg-danger'
                        }`}
                        aria-hidden
                      />
                      <span className="text-text">{s.name}</span>
                    </span>
                    <span className="text-text-subtle">
                      {s.httpStatus ? `${s.httpStatus} · ` : ''}
                      {s.latencyMs ? `${s.latencyMs}ms` : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Group>

        <Group title="Alerts">
          <p className="font-mono text-xs text-text-subtle">
            Manage alert rules at <code className="text-accent">/api/alerts</code>. The in-app rule builder lands in
            Phase 3.
          </p>
        </Group>
      </section>
    </main>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg-panel p-5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{title}</div>
      <div className="mt-3 space-y-2">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-2 font-mono text-xs last:border-0">
      <span className="text-text-muted">{label}</span>
      <span className={mono ? 'data-value text-text' : 'text-text'}>{value}</span>
    </div>
  );
}
