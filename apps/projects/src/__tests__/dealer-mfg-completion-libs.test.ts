/**
 * Pure-lib tests for the 1125 dealer + manufacturing completion (client mirrors of the SQL math and
 * the file adapters). The PGlite suites in packages/projects-access replay the SQL side; expected
 * values here are worked by hand.
 */
import { describe, expect, it } from 'vitest';
import { parseShipmentFile } from '@/lib/dealer/oem-shipment';
import { stocking, seasonIndex, stdDev } from '@/lib/dealer/stocking';
import { buildX12_850, parseAck, prepareOrder, providerFor, type OrderHeader } from '@/lib/dealer/parts-ordering';
import { proposeRoute, routeLength } from '@/lib/dealer/routing';
import { billedHours, shortQuote, type ShortRate } from '@/lib/dealer/rental';
import { expandProduct, ParamError, type ProductDef } from '@/lib/mfg/products';
import { calibrate, takeoffQty, toFraction, uomFor } from '@/lib/mfg/takeoff';
import { boardFeet, edgeCode, edgeLf, fractionalInches, parseEdges, partSqft, sheets4x8 } from '@/lib/mfg/uom';

describe('OEM shipment files (DLR-03)', () => {
  it('parses an X12 856 into units, serials upper-cased, cost in cents', () => {
    const edi = 'ST*856*0001~BSN*00*SHP1*20261025~REF*IV*INV9~HL*1**S~HL*2*1*I~LIN**VP*Z421*SN*ab1~PID*F****Mower~CTP**UCP*8450.00~HL*3*1*I~LIN**VP*Z421~SE*9*0001~';
    const p = parseShipmentFile(edi);
    expect(p.source).toBe('EDI_856');
    expect(p.ship_ref).toBe('SHP1');
    expect(p.invoice_ref).toBe('INV9');
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0]).toMatchObject({ model: 'Z421', serial_number: 'AB1', description: 'Mower', cost_cents: 845000 });
    expect(p.warnings.join(' ')).toMatch(/1 unit\(s\) have no serial/);
  });
  it('parses a CSV export with quoted dollar amounts', () => {
    const p = parseShipmentFile('Serial,Model,Make,Year,Dealer Net\nab123,Z421,Kubota,2026,"8,450.00"');
    expect(p.source).toBe('CSV');
    expect(p.lines[0]).toEqual({ serial_number: 'AB123', model: 'Z421', make: 'Kubota', model_year: 2026, description: null, category: null, cost_cents: 845000 });
  });
});

describe('stock order suggestions (DLR-33)', () => {
  it('min / max / order from demand, lead and safety stock', () => {
    expect(stocking({ avgMonthly: 30, sdMonthly: 6, season: 1, leadDays: 10, reviewDays: 20, z: 1.65, onHand: 5, onOrder: 0 })).toEqual({ min: 20, max: 40, order: 35 });
  });
  it('clamps the season index and never orders below zero', () => {
    expect(stocking({ avgMonthly: 30, sdMonthly: 0, season: 10, leadDays: 30, reviewDays: 0, z: 0, onHand: 500, onOrder: 0 })).toEqual({ min: 120, max: 120, order: 0 });
    expect(seasonIndex([0, 0, 0], 2)).toBe(1);
    expect(seasonIndex([1, 3, 3, 1], 2)).toBe(1.5);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });
});

describe('electronic parts ordering adapters (DLR-34)', () => {
  const h: OrderHeader = { po_number: 'PO-77', dealer_account: 'D100', ship_to_name: 'Main Store', order_date: '2026-10-25', kind: 'STOCK' };
  const lines = [{ line_no: 1, part_number: 'ABC-1', description: 'Blade', qty: 5, unit_cost_cents: 1234 }];
  it('builds an X12 850 with envelopes and a correct SE segment count', () => {
    const x = buildX12_850(h, lines, { sender: 'D100', receiver: 'OREGON', control: 7 });
    expect(x.startsWith('ISA*')).toBe(true);
    expect(x).toContain('~ST*850*0001~');
    expect(x).toContain('~PO1*1*5*EA*12.34**VP*ABC-1~');
    expect(x).toContain('~SE*8*0001~');
    expect(x).toContain('~IEA*1*000000007~');
  });
  it('picks the file format by provider; API distributors are portal uploads until connected', () => {
    expect(prepareOrder('oregon', h, lines).format).toBe('X12_850');
    const k = prepareOrder('KUBOTA', h, lines);
    expect(k).toMatchObject({ format: 'CSV', sent: false, file_name: 'PO-77.csv' });
    expect(k.instructions).toMatch(/not connected yet/);
    expect(providerFor('nobody').code).toBe('OTHER');
  });
  it('reads 855 and CSV acknowledgments (accepted, backordered, ETA)', () => {
    const a = parseAck('ST*855*0001~BAK*00*AC*PO-77*20261025****V-9~PO1*1*5*EA*12.34**VP*ABC-1~ACK*IA*3*EA~ACK*IB*2*EA**20261101~');
    expect(a).toEqual({ status: 'ACKNOWLEDGED', vendor_ref: 'V-9', lines: [{ line_no: 1, part_number: 'ABC-1', qty_ack: 3, qty_backorder: 2, eta: '2026-11-01' }] });
    const c = parseAck('part,qty_shipped,backorder,eta\nABC-1,3,2,2026-11-01');
    expect(c.status).toBe('PARTIAL');
    expect(c.lines[0]).toEqual({ part_number: 'ABC-1', qty_ack: 3, qty_backorder: 2, eta: '2026-11-01' });
  });
});

describe('pickup / delivery routes (DLR-41)', () => {
  it('windowed stops first, then nearest neighbour; unlocated stops last', () => {
    const stops = [
      { id: 'C', lat: 0, lng: 0.03 }, { id: 'A', lat: 0, lng: 0.02 }, { id: 'B', lat: 0, lng: 0.01 },
      { id: 'W', lat: 0, lng: 0.05, window_end: '09:00' }, { id: 'U', lat: null, lng: null },
    ];
    const r = proposeRoute({ lat: 0, lng: 0 }, stops).map((s) => s.id);
    expect(r).toEqual(['W', 'C', 'A', 'B', 'U']);
    const straight = proposeRoute({ lat: 0, lng: 0 }, stops.filter((s) => s.id !== 'W'));
    expect(straight.map((s) => s.id)).toEqual(['B', 'A', 'C', 'U']);
    expect(Math.round(routeLength({ lat: 0, lng: 0 }, straight))).toBe(3336);
  });
});

describe('short rentals (DLR-63)', () => {
  const rate: ShortRate = { day_cents: 6000, hour_cents: 1500, half_day_cents: 4000, min_hours: 2, min_charge_cents: 0 };
  const H = 3_600_000;
  it('bills whole hours, rounding up', () => {
    expect(billedHours(0, 61 * 60_000)).toBe(2);
    expect(billedHours(0, H)).toBe(1);
  });
  it('takes the cheapest of hours, half day and day', () => {
    expect(shortQuote(rate, 0, H)).toMatchObject({ basis: 'HOURS', rental_cents: 3000 });
    expect(shortQuote(rate, 0, 3 * H, 500)).toMatchObject({ basis: 'HALF_DAY', rental_cents: 4000, total_cents: 4500 });
    expect(shortQuote(rate, 0, 6 * H)).toMatchObject({ basis: 'DAY', rental_cents: 6000 });
    expect(shortQuote({ ...rate, min_charge_cents: 5000 }, 0, H)?.rental_cents).toBe(5000);
    expect(shortQuote(rate, 0, 25 * H)).toBeNull();
  });
});

describe('parametric products (MFG-07)', () => {
  const def: ProductDef = {
    params: { w: { default: 30, min: 9, max: 48 } },
    components: [
      { kind: 'SHEET', key: 'PLY34', coef: { const: 1, w: 0.05 }, unit_cost_cents: 5000 },
      { kind: 'LABOR', key: 'CNC', coef: { const: 12 } },
      { kind: 'HARDWARE', key: 'hinge', coef: { doors: 2 }, unit_cost_cents: 350 },
      { kind: 'FINISH', key: 'none', coef: { drawers: 1 } },
    ],
    price_coef: {},
    markup_pct: 0.5,
  };
  it('expands quantities × units, costs in integer cents, markup to sell', () => {
    const e = expandProduct(def, { doors: 2, qty: 2 }, { CNC: 75 });
    expect(e.components.map((c) => [c.key, c.qty, c.cost_cents])).toEqual([['PLY34', 5, 25000], ['CNC', 24, 1800], ['hinge', 8, 2800]]);
    expect(e).toMatchObject({ units: 2, labor_minutes: 24, cost_cents: 29600, sell_cents: 44400 });
  });
  it('rejects parameters out of range', () => {
    expect(() => expandProduct(def, { w: 50 })).toThrow(ParamError);
  });
});

describe('drawing takeoff (MFG-05)', () => {
  const page = { width: 612, height: 792 };
  it('calibrates and measures linear, area and count', () => {
    const ppu = calibrate([0, 0], [0.5, 0], 10, page);
    expect(ppu).toBeCloseTo(30.6, 10);
    expect(takeoffQty('LINEAR', [[0, 0], [1, 0]], page, ppu, 'FT')).toBe(20);
    expect(takeoffQty('AREA', [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]], { width: 100, height: 100 }, 10, 'IN')).toBe(0.1736);
    expect(takeoffQty('COUNT', [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]], page, ppu, 'FT')).toBe(3);
    expect(uomFor('AREA', 'MM')).toBe('M2');
    expect(() => calibrate([0, 0], [0, 0], 10, page)).toThrow();
  });
  it('clamps pointer positions to the page', () => {
    expect(toFraction(-5, 250, { left: 0, top: 0, width: 100, height: 200 })).toEqual([0, 1]);
  });
});

describe('cut-list units (MFG-20)', () => {
  it('square feet, edge banding, sheets, board feet, fractional inches', () => {
    expect(partSqft(762, 610, 2)).toBe(10.007);
    expect(edgeLf(762, 610, 2, parseEdges('L1W1'))).toBe(9);
    expect(edgeCode(parseEdges('4'))).toBe('ALL');
    expect(edgeCode(parseEdges('l2w2'))).toBe('L2W2');
    expect(sheets4x8(40, 80)).toBe(2);
    expect(sheets4x8(25.6, null)).toBe(1);
    expect(boardFeet(304.8, 304.8, 25.4, 1)).toBe(1);
    expect(fractionalInches(762)).toBe('30"');
    expect(fractionalInches(763.5875)).toBe('30 1/16"');
  });
});
