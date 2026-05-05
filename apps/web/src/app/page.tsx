import Link from 'next/link';
import { TopNav } from '@/components/top-nav';

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-bg">
      {/* animated grid background */}
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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(245,158,11,0.10), transparent 60%), radial-gradient(ellipse 80% 50% at 80% 100%, rgba(59,130,246,0.06), transparent 70%)',
        }}
      />

      <TopNav />

      <main className="relative">
        <section className="px-6 pt-20 pb-32 md:pt-32">
          <div className="mx-auto max-w-5xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-panel px-3 py-1 text-xs font-mono uppercase tracking-wider text-text-subtle">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-glow" />
              Live · BLM · USGS · State commissions
            </div>

            <h1 className="mt-6 font-display text-5xl font-medium tracking-tight text-text md:text-7xl">
              The map of <span className="text-accent">what's underneath.</span>
            </h1>

            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-text-subtle md:text-xl">
              Subterra aggregates fragmented public and commercial datasets — BLM lands, mining
              claims, oil & gas wells, USGS mineral occurrences, county parcels — into a single
              dark, data-dense interface for prospectors, junior explorers, landmen, and small
              resource operators.
            </p>

            <div className="mt-10 flex flex-wrap gap-3">
              <Link
                href="/map"
                className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-3 font-mono text-sm font-medium text-bg transition hover:brightness-110"
              >
                Open the map →
              </Link>
              <Link
                href="/explore/mining"
                className="inline-flex items-center gap-2 rounded-md border border-border bg-bg-panel px-5 py-3 font-mono text-sm text-text transition hover:border-border-strong"
              >
                Explore mining claims
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-border bg-bg-surface/40 px-6 py-20">
          <div className="mx-auto grid max-w-6xl gap-6 md:grid-cols-3">
            <FeatureCard
              kicker="LAYERS"
              title="Every public map, one viewport"
              body="BLM Surface Management. PLSS township & range. Mining claims. State oil & gas commission wells. USGS MRDS. Toggle, filter, query."
            />
            <FeatureCard
              kicker="STAKING"
              title="Federal claim toolkit"
              body="Find open federal land. Run a conflict check on a drawn polygon against active MLRS claims. Export Notice of Location, GPS coordinates, monument checklist."
            />
            <FeatureCard
              kicker="SCORING"
              title="Opportunity engine"
              body="Score any parcel or AOI: proximity to production, geology similarity, infrastructure, claim density, commodity tailwinds, permitting complexity."
            />
          </div>
        </section>

        <footer className="border-t border-border px-6 py-10 text-center font-mono text-xs text-text-muted">
          Subterra · Built on PostGIS · Open data, not open to interpretation
        </footer>
      </main>
    </div>
  );
}

function FeatureCard({ kicker, title, body }: { kicker: string; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-panel p-6 shadow-panel">
      <div className="font-mono text-xs uppercase tracking-wider text-accent">{kicker}</div>
      <h3 className="mt-3 font-display text-xl text-text">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-text-subtle">{body}</p>
    </div>
  );
}
