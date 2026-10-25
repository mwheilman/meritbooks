/**
 * Flooring price files (FLR-14): fcB2B / X12 832 price catalogs and mill spreadsheets → the lines
 * pm.flr_stage_price_import diffs against the product file. Money is exact cents from text.
 *
 * 832: separators come from the ISA header (element = 4th char, segment = the 106th, falling back
 * to "~" / newline). Per item: LIN (…*SK*{sku}* / VN / UP), PID*F (description; 73 = style,
 * 74 = color when tagged), CTP (price id NET / DIS / WHL / CON = cost; MSR / RES / RTL / SLP =
 * retail; CTP03 the unit price, CTP05 the unit), DTM*007 the effective date.
 * Pure; unit-tested.
 */
import { dateText, dollarsToCentsText, headerIndex, parseDelimited } from '@/lib/dealer/tabular';

export const PRICE_SOURCES = ['FCB2B_832', 'MILL_SHEET'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface PriceLine {
  sku: string;
  style: string | null;
  color: string | null;
  uom: string | null;
  cost_cents: number | null;
  retail_cents: number | null;
}

export interface PriceParse {
  source: PriceSource;
  effectiveOn: string | null;
  lines: PriceLine[];
  issues: Array<{ row: number; message: string }>;
}

const COST_IDS = new Set(['NET', 'DIS', 'WHL', 'CON', 'CHG', 'PRP']);
const RETAIL_IDS = new Set(['MSR', 'RES', 'RTL', 'SLP', 'CAT']);
const UOM: Readonly<Record<string, string>> = { SY: 'SY', YD: 'SY', SF: 'SF', FT: 'SF', SQ: 'SF', CT: 'CARTON', CA: 'CARTON', BX: 'CARTON', LF: 'LF', LN: 'LF', EA: 'EA', RL: 'ROLL' };

export function is832(text: string): boolean {
  return /^\s*ISA[*|^~]/.test(text) || /(^|[~\n])ST[*|]832[*|]/.test(text);
}

function separators(text: string): { el: string; seg: string } {
  const t = text.replace(/^\s+/, '');
  if (t.startsWith('ISA') && t.length > 106) {
    const el = t[3]!;
    const seg = t[105]!;
    return { el, seg: /[\r\n]/.test(seg) ? '\n' : seg };
  }
  return { el: '*', seg: t.includes('~') ? '~' : '\n' };
}

export function parse832(text: string): PriceParse {
  const { el, seg } = separators(text);
  const segments = text.split(seg).map((s) => s.replace(/[\r\n]/g, '').trim()).filter(Boolean);
  const lines: PriceLine[] = [];
  const issues: PriceParse['issues'] = [];
  let effective: string | null = null;
  let cur: PriceLine | null = null;
  const flush = () => {
    if (!cur) return;
    if (cur.cost_cents == null && cur.retail_cents == null) issues.push({ row: lines.length + 1, message: `${cur.sku}: no price in the file` });
    else lines.push(cur);
    cur = null;
  };
  segments.forEach((s, i) => {
    const e = s.split(el);
    const id = e[0];
    if (id === 'DTM' && e[1] === '007') effective = dateText(e[2] ?? '') ?? effective;
    if (id === 'LIN') {
      flush();
      let sku: string | null = null;
      for (let k = 2; k + 1 < e.length; k += 2) {
        if (['SK', 'VN', 'MG', 'UP', 'BP'].includes(e[k] ?? '')) { sku = (e[k + 1] ?? '').trim(); if (e[k] === 'SK' || e[k] === 'VN') break; }
      }
      if (!sku) { issues.push({ row: i + 1, message: 'An item (LIN) has no SKU' }); return; }
      cur = { sku: sku.slice(0, 80), style: null, color: null, uom: null, cost_cents: null, retail_cents: null };
    } else if (id === 'PID' && cur) {
      const text5 = (e[5] ?? '').trim();
      const code = (e[2] ?? '').trim();
      if (code === '73') cur.style = text5 || cur.style;
      else if (code === '74' || code === '75') cur.color = text5 || cur.color;
      else if (!cur.style && text5) cur.style = text5;
    } else if (id === 'CTP' && cur) {
      const priceId = (e[2] ?? '').trim().toUpperCase();
      const cents = dollarsToCentsText(e[3]);
      const unit = (e[5] ?? '').trim().toUpperCase().split(/[>:^]/)[0] ?? '';
      if (cents == null) { issues.push({ row: i + 1, message: `${cur.sku}: price "${e[3] ?? ''}" is not a number` }); return; }
      if (RETAIL_IDS.has(priceId)) cur.retail_cents = cents;
      else if (COST_IDS.has(priceId) || cur.cost_cents == null) cur.cost_cents = cents;
      if (unit && !cur.uom) cur.uom = UOM[unit] ?? unit;
    } else if ((id === 'SE' || id === 'CTT') && cur) {
      flush();
    }
  });
  flush();
  return { source: 'FCB2B_832', effectiveOn: effective, lines, issues };
}

type Key = 'sku' | 'style' | 'color' | 'uom' | 'cost' | 'retail' | 'effective';
const ALIASES: Readonly<Record<Key, readonly string[]>> = {
  sku: ['sku', 'item', 'item #', 'item number', 'product code', 'style number', 'style #', 'catalog number'],
  style: ['style', 'style name', 'product', 'product name', 'description'],
  color: ['color', 'colour', 'color name'],
  uom: ['uom', 'unit', 'sell unit', 'price unit'],
  cost: ['cost', 'net', 'net price', 'dealer cost', 'dealer net', 'price', 'roll price', 'cut price'],
  retail: ['retail', 'msrp', 'suggested retail', 'list'],
  effective: ['effective', 'effective date', 'start date'],
};

export function parseMillSheet(text: string): PriceParse {
  const rows = parseDelimited(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim() !== ''));
  const h = rows.findIndex((r) => headerIndex(r, ALIASES).sku >= 0);
  if (h < 0) return { source: 'MILL_SHEET', effectiveOn: null, lines: [], issues: [{ row: 1, message: 'No SKU column was found' }] };
  const ix = headerIndex(rows[h]!, ALIASES);
  const lines: PriceLine[] = [];
  const issues: PriceParse['issues'] = [];
  let effective: string | null = null;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const sku = (r[ix.sku] ?? '').trim();
    if (!sku) continue;
    const cost = ix.cost >= 0 ? dollarsToCentsText(r[ix.cost]) : null;
    const retail = ix.retail >= 0 ? dollarsToCentsText(r[ix.retail]) : null;
    if (cost == null && retail == null) { issues.push({ row: i + 1, message: `${sku}: no price` }); continue; }
    if (ix.effective >= 0 && !effective) effective = dateText(r[ix.effective]);
    const unit = ix.uom >= 0 ? (r[ix.uom] ?? '').trim().toUpperCase() : '';
    lines.push({
      sku: sku.slice(0, 80),
      style: ix.style >= 0 ? (r[ix.style] ?? '').trim() || null : null,
      color: ix.color >= 0 ? (r[ix.color] ?? '').trim() || null : null,
      uom: unit ? UOM[unit] ?? unit.slice(0, 12) : null,
      cost_cents: cost,
      retail_cents: retail,
    });
  }
  return { source: 'MILL_SHEET', effectiveOn: effective, lines, issues };
}

export function parsePriceFile(text: string): PriceParse {
  return is832(text) ? parse832(text) : parseMillSheet(text);
}
