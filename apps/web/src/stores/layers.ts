/** Layer visibility — single source of truth for the sidebar + MapLibre
 * source-layer visibility. Initialized from the shared registry; users
 * can toggle individual layers from the sidebar. Not persisted in v1 —
 * each fresh load starts at the registry defaults. */

import { create } from 'zustand';
import type { LayerPreset } from '@subterra/shared';
import { LAYERS } from '@subterra/shared';

interface LayerVisibilityState {
  visibility: Record<string, boolean>;
  toggle: (id: string) => void;
  set: (id: string, visible: boolean) => void;
  /** Apply a preset: every layer id in `preset.visible` goes on, every
   *  other registered layer goes off. Single state update so the map
   *  reconciles in one render pass instead of one per layer. */
  applyPreset: (preset: LayerPreset) => void;
}

const initial = Object.fromEntries(LAYERS.map((l) => [l.id, l.defaultVisible]));

export const useLayerVisibility = create<LayerVisibilityState>((setState) => ({
  visibility: initial,
  toggle: (id) =>
    setState((s) => ({ visibility: { ...s.visibility, [id]: !s.visibility[id] } })),
  set: (id, visible) =>
    setState((s) => ({ visibility: { ...s.visibility, [id]: visible } })),
  applyPreset: (preset) => {
    const wanted = new Set(preset.visible);
    const next = Object.fromEntries(LAYERS.map((l) => [l.id, wanted.has(l.id)]));
    setState({ visibility: next });
  },
}));
