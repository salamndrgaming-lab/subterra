import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopNav />
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-8">
        <h1 className="font-display text-3xl text-text">Settings</h1>
        <p className="mt-2 text-sm text-text-subtle">Account preferences, API keys, and alert rule management.</p>

        <section className="mt-6 space-y-4">
          <Group title="Account">
            <Row label="Email" value="—" />
            <Row label="Plan" value="Free" />
          </Group>

          <Group title="Map preferences">
            <Row label="Default style" value="Mapbox dark v11" />
            <Row label="Units" value="imperial (ft, mi, ac)" />
          </Group>

          <Group title="Alerts">
            <p className="font-mono text-xs text-text-subtle">
              Manage alert rules at <code className="text-accent">/api/alerts</code>. Phase 3 ships the in-app rule builder.
            </p>
          </Group>
        </section>
      </main>
    </div>
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 py-2 font-mono text-xs last:border-0">
      <span className="text-text-muted">{label}</span>
      <span className="data-value text-text">{value}</span>
    </div>
  );
}
