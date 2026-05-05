import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';
import { ExploreShell } from '@/components/explore/explore-shell';

export const metadata: Metadata = { title: 'Explore mining' };

export default function ExploreMiningPage() {
  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopNav />
      <ExploreShell
        title="Mining claims &amp; occurrences"
        kind="claims"
        description="BLM mining claims (active, closed) and USGS MRDS occurrences across the western US."
      />
    </div>
  );
}
