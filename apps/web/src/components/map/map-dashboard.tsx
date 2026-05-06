'use client';

import { MapView } from './map-view';
import { LayerSidebar } from './layer-sidebar';
import { BottomPanel } from './bottom-panel';
import { FeatureDrawer } from './feature-drawer';
import { MapTopBar } from './map-top-bar';
import { AoiToolbar } from './aoi-toolbar';
import { useMapStore } from '@/stores/map-store';
import { cn } from '@/lib/cn';

export function MapDashboard() {
  const sidebarOpen = useMapStore((s) => s.sidebarOpen);
  const bottomPanelOpen = useMapStore((s) => s.bottomPanelOpen);

  return (
    <div className="grid h-screen w-screen grid-rows-[48px_1fr] overflow-hidden bg-bg text-text">
      <MapTopBar />

      <div className="relative grid h-full w-full overflow-hidden"
           style={{ gridTemplateColumns: sidebarOpen ? '320px 1fr' : '0 1fr' }}>
        <LayerSidebar />

        <div
          className={cn(
            'relative grid h-full overflow-hidden',
            bottomPanelOpen ? 'grid-rows-[1fr_280px]' : 'grid-rows-[1fr_36px]',
          )}
        >
          <div className="relative h-full w-full">
            <MapView />
            <AoiToolbar />
            <FeatureDrawer />
          </div>
          <BottomPanel />
        </div>
      </div>
    </div>
  );
}
