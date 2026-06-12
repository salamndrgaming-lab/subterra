/** View-mode store — 3D terrain + satellite basemap toggles.
 *
 * Kept separate from the layers visibility store so this slice can be
 * persisted while the visibility store stays per-session (each fresh
 * load starts at registry defaults, by design). Persistence is via
 * localStorage so the user's choice survives reloads. */

import { create } from 'zustand';

interface ViewModeState {
  /** Pitches the map and applies DEM hillshading via setTerrain. */
  terrain3d: boolean;
  /** Swaps the dark vector basemap for a satellite raster basemap. */
  imagery: boolean;
  setTerrain3d: (v: boolean) => void;
  setImagery: (v: boolean) => void;
}

const STORAGE_KEY = 'subterra:view-mode:v1';

interface PersistedShape {
  terrain3d?: unknown;
  imagery?: unknown;
}

function loadPersisted(): { terrain3d: boolean; imagery: boolean } {
  if (typeof window === 'undefined') {
    return { terrain3d: false, imagery: false };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { terrain3d: false, imagery: false };
    const parsed = JSON.parse(raw) as PersistedShape;
    return {
      terrain3d: parsed.terrain3d === true,
      imagery: parsed.imagery === true,
    };
  } catch {
    return { terrain3d: false, imagery: false };
  }
}

function persist(state: { terrain3d: boolean; imagery: boolean }): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage can throw in private-mode Safari; ignore silently —
    // the toggle still works in-memory for the session.
  }
}

const initial = loadPersisted();

export const useViewMode = create<ViewModeState>((setState) => ({
  terrain3d: initial.terrain3d,
  imagery: initial.imagery,
  setTerrain3d: (v) =>
    setState((s) => {
      const next = { terrain3d: v, imagery: s.imagery };
      persist(next);
      return { terrain3d: v };
    }),
  setImagery: (v) =>
    setState((s) => {
      const next = { terrain3d: s.terrain3d, imagery: v };
      persist(next);
      return { imagery: v };
    }),
}));
