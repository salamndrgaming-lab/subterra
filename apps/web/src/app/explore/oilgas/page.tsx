import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';
import { ExploreShell } from '@/components/explore/explore-shell';

export const metadata: Metadata = { title: 'Explore oil & gas' };

export default function ExploreOilGasPage() {
  return (
    <div className="flex h-screen flex-col bg-bg">
      <TopNav />
      <ExploreShell
        title="Oil &amp; gas wells"
        kind="wells"
        description="Active, plugged, and permitted wells — operator, basin, formation, depth, status."
      />
    </div>
  );
}
