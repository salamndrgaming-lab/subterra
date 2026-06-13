/** View-mode store — 3D terrain + satellite basemap + stake-clarity
 *  toggles.
 *
 *  Kept separate from the layers visibility store so these slices can be
 *  persisted while the visibility store stays per-session (each fresh
 *  load starts at registry defaults, by design). Persistence is via
 *  localStorage so the user's choice survives reloads. */

import { create } from 'zustand';

interface ViewModeState {
  /** Pitches the map and applies DEM hillshading via setTerrain. */
  terrain3d: boolean;
  /** Swaps the dark vector basemap for a satellite raster basemap. */
  imagery: boolean;
  /** Stake-clarity overlay: paints BLM-open polygons green, layers
   *  withdrawals + critical-habitat + tribal lands red on top, and
   *  fades unrelated layers. Single switch instead of seven toggles. */
  stakeClarity: boolean;
  setTerrain3d: (v: boolean) => void;
  setImagery: (v: boolean) => void;
  setStakeClarity: (v: boolean) => void;
}

const STORAGE_KEY = 'subterra:view-mode:v2';

interface PersistedShape {
  terrain3d?: unknown;
  imagery?: unknown;
  stakeClarity?: unknown;
}

interface PersistedState {
  terrain3d: boolean;
  imagery: boolean;
  stakeClarity: boolean;
}

function loadPersisted(): PersistedState {
  const defaults: PersistedState = { terrain3d: false, imagery: false, stakeClarity: false };
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migrate from v1 if present so users don't lose their toggle state.
      const legacy = window.localStorage.getItem('subterra:view-mode:v1');
      if (legacy) {
        const parsed = JSON.parse(legacy) as PersistedShape;
        return {
          terrain3d: parsed.terrain3d === true,
          imagery: parsed.imagery === true,
          stakeClarity: false,
        };
      }
      return defaults;
    }
    const parsed = JSON.parse(raw) as PersistedShape;
    return {
      terrain3d: parsed.terrain3d === true,
      imagery: parsed.imagery === true,
      stakeClarity: parsed.stakeClarity === true,
    };
  } catch {
    return defaults;
  }
}

function persist(state: PersistedState): void {
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
  stakeClarity: initial.stakeClarity,
  setTerrain3d: (v) =>
    setState((s) => {
      persist({ terrain3d: v, imagery: s.imagery, stakeClarity: s.stakeClarity });
      return { terrain3d: v };
    }),
  setImagery: (v) =>
    setState((s) => {
      persist({ terrain3d: s.terrain3d, imagery: v, stakeClarity: s.stakeClarity });
      return { imagery: v };
    }),
  setStakeClarity: (v) =>
    setState((s) => {
      persist({ terrain3d: s.terrain3d, imagery: s.imagery, stakeClarity: v });
      return { stakeClarity: v };
    }),
}));
