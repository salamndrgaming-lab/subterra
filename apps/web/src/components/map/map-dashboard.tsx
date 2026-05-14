'use client';

import { Suspense } from 'react';
import { MapView } from './map-view';
import { LayerSidebar } from './layer-sidebar';
import { BottomPanel } from './bottom-panel';
import { FeatureDrawer } from './feature-drawer';
import { MapTopBar } from './map-top-bar';
import { AoiToolbar } from './aoi-toolbar';
import { AoiDeeplink } from './aoi-deeplink';
import { DataStatus } from './data-status';
import { useMapStore } from '@/stores/map-store';
import { cn } from '@/lib/cn';

export function MapDashboard() {
  const sidebarOpen = useMapStore((s) => s.sidebarOpen);
  const bottomPanelOpen = useMapStore((s) => s.bottomPanelOpen);
  const mapInstance = useMapStore((s) => s.mapInstance);

  return (
    <div className="grid h-full w-full grid-rows-[48px_minmax(0,1fr)] overflow-hidden bg-bg text-text">
      <MapTopBar />

      <div
        className="relative grid h-full w-full overflow-hidden"
        style={{
          gridTemplateColumns: sidebarOpen ? '320px minmax(0,1fr)' : '0 minmax(0,1fr)',
          gridTemplateRows: 'minmax(0, 1fr)',
        }}
      >
        <LayerSidebar />

        <div
          className={cn(
            'relative grid h-full overflow-hidden',
            bottomPanelOpen ? 'grid-rows-[minmax(0,1fr)_280px]' : 'grid-rows-[minmax(0,1fr)_36px]',
          )}
        >
          <div className="relative h-full w-full">
            <MapView />
            <Suspense fallback={null}>
              <AoiDeeplink map={mapInstance} />
            </Suspense>
            <AoiToolbar />
            <DataStatus />
            <FeatureDrawer />
          </div>
          <BottomPanel />
        </div>
      </div>
    </div>
  );
}
