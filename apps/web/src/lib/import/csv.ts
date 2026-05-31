/**
 * Self-contained CSV utilities — no external dependency.
 * RFC-4180-ish: handles quoted fields, embedded commas/newlines, and "" escapes.
 */

import type { ImportFieldDef } from './definitions';

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Parse CSV text into headers + row objects keyed by header. */
export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^\uFEFF/, ''); // strip BOM
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (record.some((f) => f.trim() !== '')) records.push(record);
      record = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    if (record.some((f) => f.trim() !== '')) records.push(record);
  }

  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] ?? '').trim();
    });
    return obj;
  });

  return { headers, rows };
}

/**
 * Auto-map CSV headers to field keys using each field's aliases.
 * Returns { [fieldKey]: csvHeader | '' }.
 */
export function autoMap(
  headers: string[],
  fields: ImportFieldDef[]
): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const normHeaders = headers.map((h) => ({ raw: h, n: norm(h) }));
  const mapping: Record<string, string> = {};

  for (const field of fields) {
    const candidates = [field.key, field.label, ...(field.aliases ?? [])].map(norm);
    let match = normHeaders.find((h) => candidates.includes(h.n));
    if (!match) {
      match = normHeaders.find((h) =>
        candidates.some((c) => c.length >= 3 && (h.n.includes(c) || c.includes(h.n)))
      );
    }
    mapping[field.key] = match ? match.raw : '';
  }
  return mapping;
}

export interface CoerceResult {
  ok: boolean;
  value: string | number | boolean | null;
  error?: string;
}

/** Coerce a raw cell string to the DB value for a field, applying its default. */
export function coerceValue(raw: string, field: ImportFieldDef): CoerceResult {
  const v = (raw ?? '').trim();

  if (v === '') {
    if (field.required) return { ok: false, value: null, error: `${field.label} is required` };
    if (field.default !== undefined) return { ok: true, value: field.default };
    return { ok: true, value: null };
  }

  switch (field.type) {
    case 'text':
    case 'enum': {
      if (field.type === 'enum' && field.enumValues) {
        const up = v.toUpperCase().replace(/[\s-]+/g, '_');
        if (!field.enumValues.includes(up)) {
          return { ok: false, value: null, error: `${field.label} must be one of ${field.enumValues.join(', ')}` };
        }
        return { ok: true, value: up };
      }
      return { ok: true, value: v };
    }
    case 'number': {
      const n = Number(v.replace(/,/g, ''));
      if (!Number.isFinite(n)) return { ok: false, value: null, error: `${field.label} must be a number` };
      return { ok: true, value: Math.round(n) };
    }
    case 'money': {
      const n = Number(v.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
      if (!Number.isFinite(n)) return { ok: false, value: null, error: `${field.label} must be an amount` };
      return { ok: true, value: Math.round(n * 100) };
    }
    case 'boolean': {
      const t = v.toLowerCase();
      const truthy = ['true', 'yes', 'y', '1', 'x', 't'];
      const falsy = ['false', 'no', 'n', '0', 'f', ''];
      if (truthy.includes(t)) return { ok: true, value: true };
      if (falsy.includes(t)) return { ok: true, value: false };
      return { ok: false, value: null, error: `${field.label} must be yes/no` };
    }
    case 'date': {
      const iso = toIsoDate(v);
      if (!iso) return { ok: false, value: null, error: `${field.label} is not a valid date` };
      return { ok: true, value: iso };
    }
    default:
      return { ok: true, value: v };
  }
}

/** Parse common date formats to YYYY-MM-DD; returns null if unparseable. */
export function toIsoDate(v: string): string | null {
  const s = v.trim();
  // already ISO
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // M/D/Y or M-D-Y (US)
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    let [, m, d, y] = us;
    if (y.length === 2) y = Number(y) > 50 ? `19${y}` : `20${y}`;
    const mm = Number(m), dd = Number(d);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }
  return null;
}
