/** Layer visibility — single source of truth for the sidebar + MapLibre
 * source-layer visibility. Initialized from the shared registry; users
 * can toggle individual layers from the sidebar. Not persisted in v1 —
 * each fresh load starts at the registry defaults. */

import { create } from 'zustand';
import { LAYERS } from '@subterra/shared';

interface LayerVisibilityState {
  visibility: Record<string, boolean>;
  toggle: (id: string) => void;
  set: (id: string, visible: boolean) => void;
}

const initial = Object.fromEntries(LAYERS.map((l) => [l.id, l.defaultVisible]));

export const useLayerVisibility = create<LayerVisibilityState>((setState) => ({
  visibility: initial,
  toggle: (id) =>
    setState((s) => ({ visibility: { ...s.visibility, [id]: !s.visibility[id] } })),
  set: (id, visible) =>
    setState((s) => ({ visibility: { ...s.visibility, [id]: visible } })),
}));
