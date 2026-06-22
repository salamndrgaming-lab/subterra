import { describe, expect, it } from 'vitest';

import {
  COMMODITIES,
  LAYERS,
  LAYER_GROUPS,
  LAYER_PRESETS,
  CONUS_STATES,
} from '../../packages/shared/src/index';

describe('shared registry', () => {
  it('every layer references a known group', () => {
    for (const l of LAYERS) {
      expect(LAYER_GROUPS[l.group], `layer ${l.id} group`).toBeTruthy();
    }
  });

  it('layer ids are unique', () => {
    const ids = new Set<string>();
    for (const l of LAYERS) {
      expect(ids.has(l.id), `duplicate layer id: ${l.id}`).toBe(false);
      ids.add(l.id);
    }
  });

  it('every commodity has an id, label, and category', () => {
    for (const c of COMMODITIES) {
      expect(c.id).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(['precious', 'base', 'critical', 'energy', 'industrial']).toContain(c.category);
    }
  });

  it('CONUS state list has 48 states', () => {
    expect(CONUS_STATES.length).toBe(48);
  });

  it('includes the Phase 9 stake-ability constraint layers', () => {
    const ids = new Set(LAYERS.map((l) => l.id));
    expect(ids.has('withdrawals')).toBe(true);
    expect(ids.has('critical-habitat')).toBe(true);
    expect(ids.has('indian-lands')).toBe(true);
  });

  it('every preset references only registered layer ids', () => {
    const known = new Set(LAYERS.map((l) => l.id));
    for (const p of LAYER_PRESETS) {
      for (const id of p.visible) {
        expect(known.has(id), `preset ${p.id} references unknown layer ${id}`).toBe(true);
      }
    }
  });

  it('preset ids are unique', () => {
    const ids = new Set<string>();
    for (const p of LAYER_PRESETS) {
      expect(ids.has(p.id), `duplicate preset id: ${p.id}`).toBe(false);
      ids.add(p.id);
    }
  });
});
