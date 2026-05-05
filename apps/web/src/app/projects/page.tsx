import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';

export const metadata: Metadata = { title: 'Projects' };

export default function ProjectsPage() {
  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopNav />
      <main className="mx-auto w-full max-w-7xl flex-1 overflow-y-auto px-6 py-8">
        <h1 className="font-display text-3xl text-text">Projects &amp; watchlists</h1>
        <p className="mt-2 max-w-2xl text-sm text-text-subtle">
          Save AOIs, group claims and wells into named projects, and pin entities to watchlists. Project CRUD is
          wired to <code className="font-mono text-accent">/api/projects</code>; UI lands in Phase 4.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <Placeholder title="My projects" />
          <Placeholder title="Watchlists" />
          <Placeholder title="Saved AOIs" />
        </div>
      </main>
    </div>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-panel p-6">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{title}</div>
      <div className="mt-3 font-display text-xl text-text">Empty</div>
      <div className="mt-1 text-xs text-text-subtle">No items yet — Phase 4 ships the full CRUD UI.</div>
    </div>
  );
}
