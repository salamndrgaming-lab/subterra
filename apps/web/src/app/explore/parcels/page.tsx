import type { Metadata } from 'next';
import { TopNav } from '@/components/top-nav';
import { ExploreShell } from '@/components/explore/explore-shell';

export const metadata: Metadata = { title: 'Explore parcels' };

export default function ExploreParcelsPage() {
  return (
    <div className="flex h-full flex-col bg-bg">
      <TopNav />
      <ExploreShell
        title="Parcels"
        kind="parcels"
        description="Search and filter county parcels — surface ownership, acreage, estimated value, mineral rights status."
      />
    </div>
  );
}
