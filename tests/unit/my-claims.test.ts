import { describe, expect, it } from 'vitest';

import {
  daysUntil,
  nextMaintenanceFeeDate,
} from '../../apps/web/src/lib/my-claims';

describe('nextMaintenanceFeeDate', () => {
  it('returns Sept 1 of the same year when called in March', () => {
    const today = new Date(Date.UTC(2026, 2, 15)); // 2026-03-15
    const d = nextMaintenanceFeeDate(today);
    expect(d.toISOString().slice(0, 10)).toBe('2026-09-01');
  });
  it('returns Sept 1 of the next year when called in October', () => {
    const today = new Date(Date.UTC(2026, 9, 1)); // 2026-10-01
    const d = nextMaintenanceFeeDate(today);
    expect(d.toISOString().slice(0, 10)).toBe('2027-09-01');
  });
  it('returns Sept 1 of the same year when called ON Sept 1 (still meets the deadline)', () => {
    const today = new Date(Date.UTC(2026, 8, 1, 12)); // 2026-09-01 noon UTC
    const d = nextMaintenanceFeeDate(today);
    expect(d.toISOString().slice(0, 10)).toBe('2026-09-01');
  });
  it('rolls forward when called on Sept 2', () => {
    const today = new Date(Date.UTC(2026, 8, 2)); // 2026-09-02
    const d = nextMaintenanceFeeDate(today);
    expect(d.toISOString().slice(0, 10)).toBe('2027-09-01');
  });
});

describe('daysUntil', () => {
  it('returns positive days between today and a future date', () => {
    const today = new Date(Date.UTC(2026, 5, 1));
    const target = new Date(Date.UTC(2026, 8, 1));
    expect(daysUntil(target, today)).toBe(92);
  });
  it('returns 0 when today equals the target (same instant)', () => {
    const today = new Date(Date.UTC(2026, 8, 1, 12));
    const target = new Date(Date.UTC(2026, 8, 1, 12));
    expect(daysUntil(target, today)).toBe(0);
  });
  it('returns negative when the target is in the past', () => {
    const today = new Date(Date.UTC(2026, 9, 1));
    const target = new Date(Date.UTC(2026, 8, 1));
    expect(daysUntil(target, today)).toBe(-30);
  });
});
