'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function ProjectsShell() {
  const queryClient = useQueryClient();
  const aois = useQuery({ queryKey: ['aois'], queryFn: () => api.aois.list() });

  const remove = useMutation({
    mutationFn: (id: string) => api.aois.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['aois'] }),
  });

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 overflow-y-auto px-6 py-8">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl text-text">Projects &amp; AOIs</h1>
          <p className="mt-2 max-w-2xl text-sm text-text-subtle">
            Saved areas of interest are stored in PostGIS as <code className="font-mono text-accent">MULTIPOLYGON</code>{' '}
            geometries with computed acreage. Draw new AOIs from the{' '}
            <Link href="/map" className="text-accent underline-offset-2 hover:underline">map</Link>{' '}
            using the &ldquo;Draw AOI&rdquo; toggle.
          </p>
        </div>
        <Link
          href="/map"
          className="hidden rounded-md bg-accent px-4 py-2 font-mono text-xs text-bg hover:brightness-110 md:inline-block"
        >
          Open the map →
        </Link>
      </header>

      <section className="mt-8">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-text-muted">Saved AOIs</h2>
        {aois.isLoading ? (
          <Empty>Loading…</Empty>
        ) : !aois.data?.aois.length ? (
          <Empty>No AOIs saved yet. Open the map and click &ldquo;Draw AOI&rdquo;.</Empty>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {aois.data.aois.map((a) => (
              <li key={a.id} className="rounded-lg border border-border bg-bg-panel p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-display text-lg text-text">{a.name}</div>
                    <div className="font-mono text-[11px] text-text-muted">
                      {a.areaAcres ? `${a.areaAcres.toFixed(1)} ac` : '— ac'} ·{' '}
                      {a.centroid.coordinates[1].toFixed(3)}, {a.centroid.coordinates[0].toFixed(3)}
                    </div>
                  </div>
                  <button
                    onClick={() => remove.mutate(a.id)}
                    aria-label={`Delete ${a.name}`}
                    className="rounded border border-border bg-bg px-2 py-0.5 font-mono text-[10px] text-text-subtle hover:border-danger hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
                {a.notes && <div className="mt-2 font-mono text-xs text-text-subtle">{a.notes}</div>}
                <div className="mt-3 flex items-center justify-between font-mono text-[10px] text-text-muted">
                  <span>created {new Date(a.createdAt).toISOString().slice(0, 10)}</span>
                  <a
                    href={`/map?aoi=${a.id}`}
                    className="text-accent hover:underline"
                  >
                    Open on map →
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg-panel p-6 text-center font-mono text-xs text-text-muted">
      {children}
    </div>
  );
}
