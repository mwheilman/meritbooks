import { describe, it, expect } from 'vitest';
import {
  mapAssetClass,
  parseDollarsToCents,
  toIsoDate,
  normalizeAssetExtraction,
  DEFAULT_CAPITALIZATION_THRESHOLD_CENTS,
  DEFAULT_ASSET_CLASS,
  BOOK_METHOD_VALUES,
} from './asset-parse';

describe('mapAssetClass', () => {
  it('maps computers to a 5-yr (60mo) straight-line class', () => {
    const r = mapAssetClass('laptop computer', 'Dell Latitude 7440');
    expect(r.category).toBe('COMPUTER');
    expect(r.usefulLifeMonths).toBe(60);
    expect(r.method).toBe('STRAIGHT_LINE');
  });

  it('maps furniture to a 7-yr (84mo) class', () => {
    expect(mapAssetClass(null, 'Executive office desk').usefulLifeMonths).toBe(84);
    expect(mapAssetClass('furniture', 'ergonomic chair').category).toBe('FURNITURE');
  });

  it('maps vehicles to a 5-yr (60mo) class', () => {
    const r = mapAssetClass('delivery truck', 'Ford Transit cargo van');
    expect(r.category).toBe('VEHICLE');
    expect(r.usefulLifeMonths).toBe(60);
  });

  it('maps machinery/equipment to a 7-yr (84mo) class', () => {
    expect(mapAssetClass('CNC machine', null).category).toBe('MACHINERY');
    expect(mapAssetClass('welder', 'MIG welding equipment').usefulLifeMonths).toBe(84);
  });

  it('maps leasehold improvements to a 15-yr (180mo) class, ahead of building', () => {
    // "tenant improvement" contains neither... it must beat generic building matching.
    const r = mapAssetClass('leasehold improvement', 'tenant build-out of warehouse space');
    expect(r.category).toBe('LEASEHOLD');
    expect(r.usefulLifeMonths).toBe(180);
  });

  it('maps buildings to a 39-yr (468mo) class', () => {
    expect(mapAssetClass('building', 'new warehouse structure').usefulLifeMonths).toBe(468);
  });

  it('falls back to the neutral 7-yr OTHER class for unknown descriptions', () => {
    const r = mapAssetClass('widget', 'unclassifiable capitalized thing');
    expect(r.category).toBe(DEFAULT_ASSET_CLASS.category);
    expect(r.usefulLifeMonths).toBe(84);
  });

  it('never throws on non-string input and returns a valid book method', () => {
    const r = mapAssetClass(undefined, 42 as unknown);
    expect(BOOK_METHOD_VALUES).toContain(r.method);
  });
});

describe('parseDollarsToCents (cost normalization)', () => {
  it('converts whole dollars to integer cents', () => {
    expect(parseDollarsToCents(2500)).toBe(250_000);
  });

  it('converts decimal dollars with rounding to cents', () => {
    expect(parseDollarsToCents(1234.56)).toBe(123_456);
    expect(parseDollarsToCents('1,234.56')).toBe(123_456);
    expect(parseDollarsToCents('$12,000')).toBe(1_200_000);
  });

  it('returns null for blank / non-numeric / negative', () => {
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents(-5)).toBeNull();
    expect(parseDollarsToCents(null)).toBeNull();
  });
});

describe('toIsoDate', () => {
  it('accepts a valid ISO date', () => {
    expect(toIsoDate('2026-03-15')).toBe('2026-03-15');
  });
  it('rejects impossible / malformed dates', () => {
    expect(toIsoDate('2026-02-30')).toBeNull();
    expect(toIsoDate('03/15/2026')).toBeNull();
    expect(toIsoDate(123)).toBeNull();
  });
});

describe('normalizeAssetExtraction', () => {
  const sample = {
    vendor: { name: 'Acme Equipment Co' },
    assets: [
      {
        description: 'Dell Latitude 7440 Laptop',
        asset_type: 'laptop computer',
        serial_number: 'SN-ABC-123',
        quantity: 3,
        unit_cost: 1800,
        total_cost: 5400,
        purchase_date: '2026-03-15',
        in_service_date: null,
        snippet: '3x Dell Latitude 7440 ... $5,400.00',
        note: 'includes 3-yr warranty',
        confidence: { description: 0.95, asset_type: 0.9, cost: 0.95, date: 0.9 },
      },
      {
        description: 'Office stapler box',
        asset_type: 'office supply',
        quantity: 1,
        total_cost: 45,
        purchase_date: '2026-03-15',
        confidence: { description: 0.8, asset_type: 0.4, cost: 0.9, date: 0.9 },
      },
    ],
  };

  it('extracts vendor, cost in cents, quantity, class + life proposal', () => {
    const [laptop] = normalizeAssetExtraction(sample);
    expect(laptop.vendorName).toBe('Acme Equipment Co');
    expect(laptop.name).toBe('Dell Latitude 7440 Laptop');
    expect(laptop.costCents).toBe(540_000);
    expect(laptop.unitCostCents).toBe(180_000);
    expect(laptop.quantity).toBe(3);
    expect(laptop.proposedCategory).toBe('COMPUTER');
    expect(laptop.usefulLifeMonths).toBe(60);
    expect(laptop.depreciationMethod).toBe('STRAIGHT_LINE');
    expect(laptop.serialNumber).toBe('SN-ABC-123');
    expect(laptop.purchaseDate).toBe('2026-03-15');
  });

  it('flags a below-threshold line as capitalize-vs-expense', () => {
    const [, cheap] = normalizeAssetExtraction(sample);
    expect(cheap.costCents).toBe(4_500);
    expect(cheap.belowCapitalizationThreshold).toBe(true);
    expect(cheap.suggestExpense).toBe(true);
    expect(cheap.capitalizationThresholdCents).toBe(DEFAULT_CAPITALIZATION_THRESHOLD_CENTS);
  });

  it('does NOT flag an above-threshold line', () => {
    const [laptop] = normalizeAssetExtraction(sample);
    expect(laptop.belowCapitalizationThreshold).toBe(false);
    expect(laptop.suggestExpense).toBe(false);
  });

  it('honors a custom capitalization threshold', () => {
    const [laptop] = normalizeAssetExtraction(sample, { capitalizationThresholdCents: 1_000_000 });
    expect(laptop.belowCapitalizationThreshold).toBe(true);
  });

  it('derives total cost from unit cost × quantity when total is missing', () => {
    const [a] = normalizeAssetExtraction({
      assets: [{ description: 'Server', asset_type: 'server', quantity: 2, unit_cost: 4000 }],
    });
    expect(a.costCents).toBe(800_000);
  });

  it('leaves cost null and flags it when undeterminable', () => {
    const [a] = normalizeAssetExtraction({ assets: [{ description: 'Mystery machine', asset_type: 'machine' }] });
    expect(a.costCents).toBeNull();
    expect(a.lowConfidenceFields).toContain('costCents');
  });

  it('flags an unclassifiable line for human review of the category', () => {
    const [a] = normalizeAssetExtraction({ assets: [{ description: 'thing', asset_type: 'unknown', total_cost: 9999 }] });
    expect(a.proposedCategory).toBe('OTHER');
    expect(a.lowConfidenceFields).toContain('proposedCategory');
  });

  it('never throws on malformed input', () => {
    expect(normalizeAssetExtraction(null)).toEqual([]);
    expect(normalizeAssetExtraction({ assets: 'nope' })).toEqual([]);
    expect(normalizeAssetExtraction({ assets: [null, 5, 'x'] })).toEqual([]);
  });
});
