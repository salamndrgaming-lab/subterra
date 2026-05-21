import { Link } from 'react-router-dom';

export function LandingPage() {
  return (
    <div className="relative min-h-full overflow-hidden bg-bg">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.04) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse at 50% 30%, #000 30%, transparent 75%)',
        }}
      />

      <main className="relative mx-auto max-w-5xl px-6 pt-24 pb-16">
        <div
          data-testid="status-pill"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-panel px-3 py-1 font-mono text-xs uppercase tracking-wider text-text-subtle"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          Phase 0 · scaffold
        </div>

        <h1 className="mt-6 font-mono text-5xl font-medium tracking-tight text-text md:text-7xl">
          The map of <span className="text-accent">what&apos;s underneath.</span>
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-text-subtle md:text-xl">
          Subterra aggregates weekly bulk extracts from BLM, USGS, EPA, HIFLD,
          and every state oil & gas commission into a single map for
          prospectors, junior explorers, landmen, and small operators.
        </p>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            to="/map"
            className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-3 font-mono text-sm font-medium text-bg transition hover:brightness-110"
          >
            Open the map →
          </Link>
          <a
            href="https://github.com/salamndrgaming-lab/subterra"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-bg-panel px-5 py-3 font-mono text-sm text-text transition hover:border-border-strong"
          >
            View on GitHub
          </a>
        </div>
      </main>

      <footer className="border-t border-border px-6 py-10 text-center font-mono text-xs text-text-muted">
        Subterra · open data, $0 infra, real claims
      </footer>
    </div>
  );
}
