import { describe, expect, it } from 'vitest';
import { dateText, dollarsToCentsText, parseDelimited, sniffDelimiter, xmlElements } from '@/lib/dealer/tabular';
import { parsePriceFile, supersessionLoops } from '@/lib/dealer/price-files';
import { catalogLink, cleanScan, parsePickList, validTemplate } from '@/lib/dealer/catalog';
import { daysLeft, missingLabels, packetText, submitterFor, SUBMITTERS } from '@/lib/dealer/warranty-adapters';
import { centsWords, depthErrorCopy } from '@/lib/dealer/errors';
import { fractionText, guessUnits, kindOf as cadKind, parseCadFile } from '@/lib/mfg/cad-import';
import { KioskQueue, minutesBetween, newEventId, type KioskStorage } from '@/lib/mfg/kiosk-queue';
import { categoryOf, parseMeasureFile, wasteOf } from '@/lib/flooring/measure-import';
import { looseDate, parseVendorEmail, trackingNumbers } from '@/lib/design/inbox-parse';
import { continuation, issueWords, retainageCents } from '@/lib/development/draw';
import { materialQty, sfToSy } from '@/lib/flooring/uom';
import { computeProForma, inBalance, irr } from '@/lib/development/returns';

describe('tabular toolkit', () => {
  it('reads dollars exactly, with parentheses, commas and half-up thousandths', () => {
    expect(dollarsToCentsText('$1,234.5')).toBe(123450);
    expect(dollarsToCentsText('(12.00)')).toBe(-1200);
    expect(dollarsToCentsText('12.345')).toBe(1235);
    expect(dollarsToCentsText('12.344')).toBe(1234);
    expect(dollarsToCentsText('0.1')).toBe(10);
    expect(dollarsToCentsText('abc')).toBeNull();
    expect(dollarsToCentsText('')).toBeNull();
  });
  it('sniffs delimiters and keeps quoted commas', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(sniffDelimiter('a|b|c')).toBe('|');
    expect(parseDelimited('a\tb\n"x, y"\t2,5')).toEqual([['a', 'b'], ['x, y', '2,5']]);
  });
  it('reads dates in the shapes vendors send', () => {
    expect(dateText('10/25/26')).toBe('2026-10-25');
    expect(dateText('20261025')).toBe('2026-10-25');
    expect(dateText('2026-02-30')).toBeNull();
  });
  it('reads XML elements with attributes and children', () => {
    const els = xmlElements('<Root><Part Name="Side" Qty="2"/><Part><Name>Back &amp; top</Name><Qty>1</Qty></Part></Root>', ['part']);
    expect(els).toHaveLength(2);
    expect(els[0]!.attrs.name).toBe('Side');
    expect(els[1]!.children.name).toBe('Back & top');
  });
});

describe('OEM price files', () => {
  it('maps OEM headings, supersessions and prices to cents', () => {
    const csv = 'Part Number,Description,Suggested Retail,Dealer Net,Superseded By,Price Group,Effective Date\n' +
      'abc-100,Air filter,$24.99,14.10,,F1,11/01/2026\n' +
      'ABC-200,Old belt,19.50,11.00,ABC-201,B2,\n' +
      ',orphan,1.00,,,,\n';
    const r = parsePriceFile(csv, 'KUBOTA');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ part_number: 'ABC-100', list_price_cents: 2499, cost_cents: 1410, category: 'F1' });
    expect(r.rows[1]!.supersedes_to).toBe('ABC-201');
    expect(r.effectiveOn).toBe('2026-11-01');
    expect(r.issues.some((i) => /No part number/.test(i.message))).toBe(true);
  });
  it('reads a fixed-width record file with implied decimals and skips header records', () => {
    const rec = (pn: string, d: string, list: string, cost: string, sup = '', grp = '') => pn.padEnd(15) + d.padEnd(30) + list.padStart(9, '0') + cost.padStart(9, '0') + sup.padEnd(15) + grp.padEnd(4);
    const text = `H20261101 PRICE FILE\n${rec('K1234', 'Hydraulic filter', '4599', '2875')}\n${rec('K2000', 'Seal', '899', '410', 'K2001', 'S1')}\nT000002`;
    const r = parsePriceFile(text, 'FIXED_KUBOTA');
    expect(r.rows.map((x) => [x.part_number, x.list_price_cents, x.cost_cents, x.supersedes_to])).toEqual([['K1234', 4599, 2875, null], ['K2000', 899, 410, 'K2001']]);
    expect(r.effectiveOn).toBe('2026-11-01');
  });
  it('refuses a file with no part number column and finds supersession loops', () => {
    expect(parsePriceFile('Name,Price\nx,1', 'GENERIC').issues[0]!.message).toMatch(/No part number column/);
    const rows = parsePriceFile('Part,Replaced By\nA,B\nB,C\nC,A\nD,E', 'GENERIC').rows;
    expect(supersessionLoops(rows)).toEqual([['A', 'B', 'C']]);
  });
});

describe('parts catalog and the counter', () => {
  it('builds a catalog link only from a saved address with lookup tokens', () => {
    expect(validTemplate('https://catalog.example/lookup?part={part}')).toBe(true);
    expect(validTemplate('javascript:alert(1)')).toBe(false);
    expect(catalogLink({ adapter: 'PARTSTREAM', urlTemplate: 'https://catalog.example/p?brand={brand}&q={q}&sn={serial}' }, { brand: 'kubota', model: 'BX 23S', serial: 'S/N 1' }))
      .toBe('https://catalog.example/p?brand=KUBOTA&q=BX%2023S&sn=S%2FN%201');
    expect(catalogLink({ adapter: 'PARTSMART', urlTemplate: null }, { brand: 'X', model: 'Y', serial: null })).toBeNull();
  });
  it('parses pick lists from a cart URL, an export and pasted lines, adding up repeats', () => {
    expect(parsePickList('https://cart.example/add?sku=AB-1&qty=2&sku=CD-2&qty=1')).toEqual([{ part_number: 'AB-1', qty: 2 }, { part_number: 'CD-2', qty: 1 }]);
    expect(parsePickList('Part Number,Qty,Description\nab-1,3,Filter\nAB-1,1,Filter')).toEqual([{ part_number: 'AB-1', qty: 4, description: 'Filter' }]);
    expect(parsePickList('2 x K1234\nK2000, 3\nK9999')).toEqual([{ part_number: 'K1234', qty: 2 }, { part_number: 'K2000', qty: 3 }, { part_number: 'K9999', qty: 1 }]);
  });
  it('cleans scanner input', () => {
    expect(cleanScan(' 012345678905\r\n')).toBe('012345678905');
    expect(cleanScan('a')).toBeNull();
  });
});

describe('warranty adapters', () => {
  it('every direct OEM is a stub that sends the clerk to the portal-assist packet', async () => {
    const s = submitterFor('kubota')!;
    expect(s.brand).toBe('KUBOTA');
    const r = await s.submit({ submission_id: 'x', attempt_no: 1, channel: 'DIRECT', packet: { copy_fields: [], submit_by: null } });
    expect(r.status).toBe('NOT_CONNECTED');
    expect(Object.keys(SUBMITTERS)).toHaveLength(7);
    expect(submitterFor('Acme')).toBeNull();
  });
  it('words missing fields, the packet and the days left', () => {
    expect(missingLabels(['defect_code', 'pre_auth_ref'])).toEqual(['Defect code', 'Pre-authorization number (over the OEM’s limit)']);
    expect(packetText({ copy_fields: [{ label: 'Serial number', value: 'S1' }, { label: 'Hours', value: null }], parts: [{ part_number: 'P1', description: 'Pump', qty: 1, unit_price_cents: 100, is_causal: true }], submit_by: null }))
      .toBe('Serial number: S1\nPart P1 (causal) × 1 — Pump');
    expect(daysLeft('2026-11-01', '2026-10-25')).toBe(7);
    expect(daysLeft('2026-10-20', '2026-10-25')).toBe(-5);
  });
});

describe('1122 error copy', () => {
  it('keeps the detail, words cents as dollars and hides ids', () => {
    expect(centsWords('out by 50000000 cents')).toBe('out by $500,000.00');
    const e = depthErrorCopy({ code: 'P0001', message: 'PM_DEV_OUT_OF_BALANCE: the project is out of balance by 50000000 cents; fund the gap' });
    expect(e).toEqual({ status: 422, code: 'PM_DEV_OUT_OF_BALANCE', error: 'The project is out of balance by $500,000.00; fund the gap.' });
    expect(depthErrorCopy({ code: '42501', message: 'PM_SOD_VIOLATION: the person who prepared the pay ticket cannot approve it' })!.status).toBe(403);
    expect(depthErrorCopy({ code: 'P0001', message: 'PM_FLR_CAPACITY_FULL: crew A is full on 2026-11-02' })!.status).toBe(409);
    expect(depthErrorCopy({ code: '22023', message: 'PM_INVALID: x' })).toBeNull();
    expect(depthErrorCopy({ code: '42501', message: 'PM_KIOSK_LOCKED: badge 12 locked until 10:41' })!.error).toMatch(/Too many tries/);
  });
});

describe('CAD / CAM import', () => {
  it('maps a Cabinet Vision style CSV in inches to millimetres with line kinds', () => {
    const csv = 'Cabinet,Type,Part Name,Material,Qty,Length,Width,Thickness,Grain,Edgeband,CNC\n' +
      'B1,Part,Left side,Maple ply,1,34 1/2,23 1/4,3/4,L,PVC maple,Y\n' +
      'B1,Hardware,Hinge 110,,4,,,,,,\n' +
      'B1,Sheet,Maple ply 3/4,Maple ply,3,96,48,3/4,,,\n' +
      ',Part,,,1,,,,,,\n';
    const r = parseCadFile(csv, 'CABINET_VISION');
    expect(r.units).toBe('in');
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatchObject({ line_kind: 'PART', assembly_ref: 'B1', length_mm: 876.3, width_mm: 590.6, thickness_mm: 19.1, grain: 'LENGTH', machining: true });
    expect(r.lines[1]!.line_kind).toBe('HARDWARE');
    expect(r.summary).toMatchObject({ parts: 1, sheets: 3, hardware: 4 });
    expect(r.issues).toHaveLength(1);
  });
  it('reads a Microvellum / imos style XML with declared units', () => {
    const xml = '<?xml version="1.0"?><Project Units="mm"><Product Name="Base 600" Qty="1"/><Part Name="Bottom" Qty="2" Material="MDF" Length="564" Width="560" Thickness="18"/><Hardware Name="Slide 500" Code="BL-500" Qty="2"/></Project>';
    const r = parseCadFile(xml, 'MICROVELLUM');
    expect(r.units).toBe('mm');
    expect(r.lines.map((l) => [l.line_kind, l.description, l.qty])).toEqual([['ASSEMBLY', 'Base 600', 1], ['PART', 'Bottom', 2], ['HARDWARE', 'Slide 500', 2]]);
    expect(r.lines[1]!.thickness_mm).toBe(18);
  });
  it('reads fractions and guesses units', () => {
    expect(fractionText('23 1/2"')).toBe(23.5);
    expect(fractionText('3/0')).toBeNull();
    expect(guessUnits({ thickness: [18, 19, 16], length: [] })).toBe('mm');
    expect(cadKind('Edge banding')).toBe('EDGEBAND');
  });
});

describe('kiosk offline queue', () => {
  const mem = (): KioskStorage & { m: Map<string, string> } => {
    const m = new Map<string, string>();
    return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  };
  it('keeps taps across a reload and sends them in order once the network is back', async () => {
    const s = mem();
    const q = new KioskQueue('loc', s);
    q.push({ session_token: 't', action: 'START', operation_id: 'op1' });
    q.push({ session_token: 't', action: 'COMPLETE', operation_id: 'op1', good_qty: 4 });
    const again = new KioskQueue('loc', s);
    expect(again.pending.map((e) => e.action)).toEqual(['START', 'COMPLETE']);
    const off = await again.flush(async () => null);
    expect(off).toMatchObject({ sent: 0, offline: true });
    expect(again.pending).toHaveLength(2);
    const seen: string[] = [];
    const on = await again.flush(async (ev) => { seen.push(...ev.map((e) => e.action)); return ev.map(() => ({ ok: true })); }, 1);
    expect(on).toMatchObject({ sent: 2, offline: false });
    expect(seen).toEqual(['START', 'COMPLETE']);
    expect(s.m.size).toBe(0);
  });
  it('survives broken storage and makes dedupable ids', () => {
    const bad: KioskStorage = { getItem: () => '{not json', setItem: () => { throw new Error('full'); }, removeItem: () => undefined };
    const q = new KioskQueue('loc', bad);
    expect(q.pending).toEqual([]);
    q.push({ session_token: 't', action: 'STOP' });
    expect(q.pending).toHaveLength(1);
    expect(newEventId(1, () => 0.5).length).toBeGreaterThanOrEqual(8);
    expect(minutesBetween('2026-10-25T10:00:00Z', '2026-10-25T10:47:59Z')).toBe(47);
  });
});

describe('measure import', () => {
  it('maps a MeasureSquare style CSV with square yards, stairs and base', () => {
    const csv = 'Room,Material,Sq Yd,LF,Steps,Waste %\nLiving room,Carpet,40,,,12%\nStairs,Carpet,,,13,\nKitchen base,LVP,,48,,\nHall,LVP,,,,\n';
    const r = parseMeasureFile(csv, 'MEASURESQUARE');
    expect(r.rooms).toHaveLength(3);
    expect(r.rooms[0]).toMatchObject({ room: 'Living room', area_kind: 'FLOOR', category: 'CARPET', sqft: 360, waste_pct: 0.12 });
    expect(r.rooms[1]).toMatchObject({ area_kind: 'STAIRS', each_count: 13 });
    expect(r.rooms[2]).toMatchObject({ area_kind: 'BASE', linear_ft: 48, category: 'LVP' });
    expect(r.totals).toEqual({ sqft: 360, linearFt: 48, steps: 13 });
    expect(r.issues.some((i) => /Hall/.test(i.message))).toBe(true);
  });
  it('reads an RFMS style XML', () => {
    const r = parseMeasureFile('<Measure><Room Name="Primary" Material="Hardwood" SqFt="212.5" Waste="1.08"/><Stair Name="Main stair" Steps="14" Material="Carpet"/></Measure>', 'RFMS');
    expect(r.rooms[0]).toMatchObject({ category: 'HARDWOOD', sqft: 212.5, waste_pct: 0.08 });
    expect(r.rooms[1]).toMatchObject({ area_kind: 'STAIRS', each_count: 14 });
  });
  it('reads waste and categories loosely', () => {
    expect([wasteOf('12'), wasteOf('0.1'), wasteOf('1.15'), wasteOf('')]).toEqual([0.12, 0.1, 0.15, null]);
    expect([categoryOf('Luxury vinyl plank'), categoryOf('porcelain tile'), categoryOf('sisal')]).toEqual(['LVP', 'TILE', 'OTHER']);
  });
});

describe('vendor inbox rules', () => {
  it('reads an acknowledgement: PO, sidemark, ship date, lead time, line prices, total', () => {
    const p = parseVendorEmail('Order Acknowledgement - Your PO# PO-2026-0141',
      'Thank you. Sidemark: SMITH / LIVING\nSKU: CH-2201 Lounge chair  qty 2  $1,450.00\nEstimated ship date: Nov 18, 2026\nLead time 6 weeks\nOrder total: $2,900.00', '2026-10-25');
    expect(p.kind).toBe('ACKNOWLEDGEMENT');
    expect(p.po_numbers).toContain('PO-2026-0141');
    expect(p.sidemarks).toEqual(['SMITH / LIVING']);
    expect(p.dates.ship_on).toBe('2026-11-18');
    expect(p.lead_time_days).toBe(42);
    expect(p.line_prices).toEqual([{ sku: 'CH-2201', unit_cents: 145000 }]);
    expect(p.total_cents).toBe(290000);
  });
  it('reads a ship notice with tracking and a backorder', () => {
    const s = parseVendorEmail('Your order has shipped', 'PO 88123 shipped via UPS tracking 1Z999AA10123456784. ETA 11/02/2026. Freight PRO # 12345678', '2026-10-25');
    expect(s.kind).toBe('SHIP_NOTICE');
    expect(s.tracking).toEqual(expect.arrayContaining(['1Z999AA10123456784', 'PRO 12345678']));
    expect(s.dates.delivery_on).toBe('2026-11-02');
    expect(parseVendorEmail('Backorder notice', 'Item delayed until Dec 3, 2026', '2026-10-25').kind).toBe('BACKORDER');
    expect(trackingNumbers('nothing here')).toEqual([]);
    expect(looseDate('3 March 2027', '2026-10-25')).toBe('2027-03-03');
    expect(looseDate('Smarch 3, 2027', '2026-10-25')).toBeNull();
  });
});

describe('draw continuation', () => {
  it('ties the continuation sheet in integer cents', () => {
    const c = continuation([
      { line_no: 2, description: 'Hard', scheduled_cents: 850_000_000, previous_cents: 200_000_000, this_period_cents: 150_000_000 },
      { line_no: 1, description: 'Land', scheduled_cents: 200_000_000, previous_cents: 200_000_000, this_period_cents: 0 },
    ], 0.1);
    expect(c.rows.map((r) => r.line_no)).toEqual([1, 2]);
    expect(c.rows[1]).toMatchObject({ completed_cents: 350_000_000, balance_cents: 500_000_000, pct_complete: 0.4118, retainage_cents: 35_000_000 });
    expect(c.totals).toMatchObject({ scheduled_cents: 1_050_000_000, this_period_cents: 150_000_000, balance_cents: 500_000_000 });
    expect(retainageCents(1005, 0.05)).toBe(50);
    expect(issueWords('OUT_OF_BALANCE')).toMatch(/out of balance/);
    expect(issueWords('NEW_THING')).toBe('New thing.');
  });
});


describe('flooring UoM and development returns (mirrors of the SQL)', () => {
  it('turns square feet into the sell unit with waste', () => {
    expect(materialQty({ uom: 'SF', sf: 1000, waste: 0.1 }).qty).toBe(1100);
    const sy = materialQty({ uom: 'SY', sf: 360, waste: 0.1, rollWidthFt: 12 });
    expect(sy.uom).toBe('SY');
    expect(sy.qty).toBeGreaterThanOrEqual(sfToSy(396));
    expect(materialQty({ uom: 'CARTON', sf: 500, waste: 0.05, cartonSf: 20 }).qty).toBe(27);
  });
  it('computes deterministic returns and the in-balance gap', () => {
    expect(irr([-100, 0, 121])).toBeCloseTo(0.1, 6);
    const r = computeProForma({ totalCostCents: 1_250_000_000, loanCents: 900_000_000, interestRate: 0.07, noiAnnualCents: 87_500_000, equityCashFlowsCents: [-350_000_000, 0, 0, 0, 0, 700_000_000] });
    expect([r.yieldOnCost, r.ltc, r.dscr, r.equityMultiple]).toEqual([0.07, 0.72, 1.389, 2]);
    expect(inBalance(980_000_000, 100_000_000, 950_000_000)).toMatchObject({ inBalance: true });
  });
});
