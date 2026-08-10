import { describe, it, expect } from 'vitest';
import {
  KPI_IDS,
  DEFAULT_VISIBLE,
  defaultConfig,
  applyLayout,
  sanitizeVisible,
  normalizeConfig,
  serializeConfig,
  deserializeConfig,
  moveInArray,
  moveMetric,
  toggleMetric,
  setPeriodOffset,
  kpiConfigStorageKey,
  type KpiId,
} from './kpi-config';

describe('serialize / deserialize round-trip', () => {
  it('restores an equivalent config through a serialize→deserialize cycle', () => {
    const cfg = { version: 1 as const, visible: ['cash', 'runway', 'revenue'] as KpiId[], periodOffset: -2 };
    const restored = deserializeConfig(serializeConfig(cfg));
    expect(restored.visible).toEqual(['cash', 'runway', 'revenue']);
    expect(restored.periodOffset).toBe(-2);
    expect(restored.version).toBe(1);
  });

  it('falls back to the default config on malformed JSON', () => {
    const restored = deserializeConfig('{not json');
    expect(restored.visible).toEqual([...DEFAULT_VISIBLE]);
    expect(restored.periodOffset).toBe(0);
  });

  it('returns the default config for null/empty stored value', () => {
    expect(deserializeConfig(null).visible).toEqual([...DEFAULT_VISIBLE]);
    expect(deserializeConfig(undefined).visible).toEqual([...DEFAULT_VISIBLE]);
  });
});

describe('drop-unknown-metric (graceful degradation)', () => {
  it('drops ids that are no longer in the catalog and de-dupes', () => {
    const raw = { version: 1, visible: ['revenue', 'ghostMetric', 'revenue', 'cash'], periodOffset: 0 };
    const cfg = normalizeConfig(raw);
    expect(cfg.visible).toEqual(['revenue', 'cash']);
  });

  it('drops ids not present in a restricted "available" universe', () => {
    const available: KpiId[] = ['revenue', 'netIncome'];
    const cfg = normalizeConfig({ visible: ['revenue', 'cash', 'netIncome'] }, available);
    expect(cfg.visible).toEqual(['revenue', 'netIncome']);
  });

  it('falls back to the default set when everything saved is unknown', () => {
    const cfg = normalizeConfig({ visible: ['nope', 'alsoNope'] });
    // default set, filtered to what remains available (all of it here)
    expect(cfg.visible).toEqual(sanitizeVisible(DEFAULT_VISIBLE));
    expect(cfg.visible.length).toBeGreaterThan(0);
  });

  it('clamps an out-of-range period offset', () => {
    expect(normalizeConfig({ visible: ['cash'], periodOffset: 5 }).periodOffset).toBe(0);
    expect(normalizeConfig({ visible: ['cash'], periodOffset: -99 }).periodOffset).toBe(-11);
  });
});

describe('applyLayout', () => {
  it('seeds a valid, in-catalog config for each starter layout', () => {
    for (const id of ['controller', 'cfo', 'owner'] as const) {
      const cfg = applyLayout(id);
      expect(cfg.visible.length).toBeGreaterThan(0);
      // every seeded id is a real, computable catalog metric
      expect(cfg.visible.every((v) => KPI_IDS.includes(v))).toBe(true);
    }
  });

  it('owner layout is the compact essentials set', () => {
    expect(applyLayout('owner').visible).toEqual(['revenue', 'netIncome', 'cash', 'runway', 'ar', 'ap']);
  });

  it('preserves the passed period offset', () => {
    expect(applyLayout('cfo', -3).periodOffset).toBe(-3);
  });
});

describe('reorder', () => {
  it('moveInArray moves an item and is a no-op on invalid indices', () => {
    expect(moveInArray(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveInArray(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveInArray(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
    expect(moveInArray(['a', 'b', 'c'], -1, 2)).toEqual(['a', 'b', 'c']);
    expect(moveInArray(['a', 'b', 'c'], 0, 9)).toEqual(['a', 'b', 'c']);
  });

  it('moveMetric shifts a visible tile up/down and clamps at the ends', () => {
    const base = { version: 1 as const, visible: ['revenue', 'cash', 'runway'] as KpiId[], periodOffset: 0 };
    expect(moveMetric(base, 'cash', -1).visible).toEqual(['cash', 'revenue', 'runway']);
    expect(moveMetric(base, 'cash', 1).visible).toEqual(['revenue', 'runway', 'cash']);
    // already first — up is a no-op
    expect(moveMetric(base, 'revenue', -1).visible).toEqual(['revenue', 'cash', 'runway']);
    // not visible — no-op
    expect(moveMetric(base, 'ap', 1).visible).toEqual(['revenue', 'cash', 'runway']);
  });
});

describe('toggleMetric', () => {
  it('adds an unselected metric to the end and removes a selected one', () => {
    const base = { version: 1 as const, visible: ['revenue', 'cash'] as KpiId[], periodOffset: 0 };
    expect(toggleMetric(base, 'ap').visible).toEqual(['revenue', 'cash', 'ap']);
    expect(toggleMetric(base, 'cash').visible).toEqual(['revenue']);
  });

  it('refuses to remove the last remaining tile', () => {
    const one = { version: 1 as const, visible: ['revenue'] as KpiId[], periodOffset: 0 };
    expect(toggleMetric(one, 'revenue').visible).toEqual(['revenue']);
  });

  it('ignores unknown ids', () => {
    const base = { version: 1 as const, visible: ['revenue'] as KpiId[], periodOffset: 0 };
    const available: KpiId[] = ['revenue', 'cash'];
    // 'ap' not in restricted availability → unchanged
    expect(toggleMetric(base, 'ap', available).visible).toEqual(['revenue']);
  });
});

describe('setPeriodOffset & storage key', () => {
  it('clamps offsets into range', () => {
    expect(setPeriodOffset(defaultConfig(), -3).periodOffset).toBe(-3);
    expect(setPeriodOffset(defaultConfig(), 4).periodOffset).toBe(0);
  });

  it('namespaces the storage key per user + company', () => {
    expect(kpiConfigStorageKey('user_1', 'loc_9')).toBe('meritbooks:fpna:kpi-config:v1:user_1:loc_9');
    expect(kpiConfigStorageKey('', '')).toBe('meritbooks:fpna:kpi-config:v1:anon:all');
    expect(kpiConfigStorageKey('user_1', 'loc_9')).not.toBe(kpiConfigStorageKey('user_1', 'loc_8'));
  });
});
