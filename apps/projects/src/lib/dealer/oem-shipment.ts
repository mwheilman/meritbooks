/**
 * OEM shipment files → unit lines for pm.dlr_create_shipment (DLR-03). Two formats:
 *
 *   X12 856 (advance ship notice): segments split on "~", elements on "*" (the separators are read
 *   from the ISA header when present). BSN02 is the shipment id, REF*IV the invoice, each HL with
 *   level code "I" (item) opens a unit: LIN pairs (VP / BP / MG / IN = model, SN = serial),
 *   REF*SE = serial, PID*F = description, CTP / IT1 price = cost (dollars → cents).
 *   CSV export: a header row; columns matched by name (serial, model, make, year, description,
 *   category, cost / invoice / dealer net).
 *
 * Pure and deterministic; the database validates every value again. Unknown columns are ignored.
 */

export interface ShipmentLine {
  make: string | null;
  model: string | null;
  model_year: number | null;
  serial_number: string | null;
  description: string | null;
  category: string | null;
  cost_cents: number | null;
}

export interface ParsedShipment {
  source: 'EDI_856' | 'CSV';
  ship_ref: string | null;
  invoice_ref: string | null;
  lines: ShipmentLine[];
  warnings: string[];
}

const blank = (): ShipmentLine => ({ make: null, model: null, model_year: null, serial_number: null, description: null, category: null, cost_cents: null });

/** "1,234.56" / "$1234.5" / "123456" (already cents when `cents`) → integer cents, or null. */
export function toCents(raw: string | null | undefined, cents = false): number | null {
  if (raw == null) return null;
  const s = raw.trim().replace(/[$,\s]/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  if (cents) return Math.round(Number(s));
  const [w = '0', f = ''] = s.replace('-', '').split('.');
  const v = Number(w) * 100 + Math.round(Number(`0.${f || '0'}`) * 100);
  return s.startsWith('-') ? -v : v;
}

function yearOf(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1900 && n <= 2200 ? n : null;
}

export function looksLikeX12(text: string): boolean {
  return /^\s*ISA[*|^~]/.test(text) || /(^|~)\s*ST\*856\b/.test(text);
}

/** Parse an X12 856. Lines without a model or a serial are kept (the yard scans the serial later). */
export function parseX12_856(text: string): ParsedShipment {
  const trimmed = text.replace(/\r?\n/g, '');
  // ISA is fixed width: element separator at 3, segment terminator at 105
  let el = '*';
  let seg = '~';
  if (trimmed.startsWith('ISA') && trimmed.length > 105) {
    el = trimmed[3]!;
    seg = trimmed[105]!;
  }
  const segments = trimmed.split(seg).map((s) => s.trim()).filter(Boolean).map((s) => s.split(el));
  const out: ParsedShipment = { source: 'EDI_856', ship_ref: null, invoice_ref: null, lines: [], warnings: [] };
  let cur: ShipmentLine | null = null;
  const flush = () => {
    if (cur && (cur.model || cur.serial_number || cur.description)) out.lines.push(cur);
    cur = null;
  };
  for (const s of segments) {
    const id = s[0];
    if (id === 'BSN') out.ship_ref = s[2]?.trim() || out.ship_ref;
    else if (id === 'HL') {
      if (s[3] === 'I') {
        flush();
        cur = blank();
      }
    } else if (id === 'REF' && s[1] === 'IV') out.invoice_ref = s[2]?.trim() || out.invoice_ref;
    else if (cur && id === 'LIN') {
      for (let i = 2; i + 1 < s.length; i += 2) {
        const q = s[i];
        const v = s[i + 1]?.trim() || null;
        if (!v) continue;
        if (q === 'SN') cur.serial_number = v.toUpperCase();
        else if (q === 'VP' || q === 'BP' || q === 'MG' || q === 'IN' || q === 'MN') cur.model = cur.model ?? v;
        else if (q === 'MF') cur.make = v;
      }
    } else if (cur && id === 'REF' && s[1] === 'SE') cur.serial_number = (s[2] ?? '').trim().toUpperCase() || cur.serial_number;
    else if (cur && id === 'PID' && s[1] === 'F') cur.description = s[5]?.trim() || cur.description;
    else if (cur && id === 'CTP') cur.cost_cents = toCents(s[3]) ?? cur.cost_cents;
    else if (cur && id === 'IT1') cur.cost_cents = toCents(s[4]) ?? cur.cost_cents;
    else if (cur && id === 'DTM' && s[1] === 'MFG') cur.model_year = yearOf(s[2]?.slice(0, 4)) ?? cur.model_year;
  }
  flush();
  if (out.lines.length === 0) out.warnings.push('No item (HL*…*I) loops were found in the file.');
  const noSerial = out.lines.filter((l) => !l.serial_number).length;
  if (noSerial) out.warnings.push(`${noSerial} unit(s) have no serial on the notice; scan them in the yard.`);
  return out;
}

/** Split one CSV line (quotes, doubled quotes, commas inside quotes). */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const COLS: Record<keyof ShipmentLine, RegExp> = {
  serial_number: /^(serial|serial ?(no|number|#)|s\/?n|pin|vin)$/i,
  model: /^(model|model ?(no|number|#)|item|product)$/i,
  make: /^(make|brand|manufacturer|mfr)$/i,
  model_year: /^(year|model ?year|yr)$/i,
  description: /^(description|desc|name)$/i,
  category: /^(category|class|type)$/i,
  cost_cents: /^(cost|dealer ?net|invoice ?(amount|price)?|unit ?cost|price)$/i,
};

export function parseShipmentCsv(text: string): ParsedShipment {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const out: ParsedShipment = { source: 'CSV', ship_ref: null, invoice_ref: null, lines: [], warnings: [] };
  if (rows.length < 2) { out.warnings.push('The file has no data rows.'); return out; }
  const head = splitCsv(rows[0]!);
  const idx = Object.fromEntries((Object.keys(COLS) as Array<keyof ShipmentLine>).map((k) => [k, head.findIndex((h) => COLS[k].test(h))])) as Record<keyof ShipmentLine, number>;
  if (idx.serial_number < 0 && idx.model < 0) { out.warnings.push('No serial or model column was found in the header row.'); return out; }
  const centsCol = idx.cost_cents >= 0 && /cents/i.test(head[idx.cost_cents] ?? '');
  for (const r of rows.slice(1)) {
    const c = splitCsv(r);
    const get = (k: keyof ShipmentLine) => (idx[k] >= 0 ? c[idx[k]] || null : null);
    out.lines.push({
      serial_number: get('serial_number')?.toUpperCase() ?? null,
      model: get('model'),
      make: get('make'),
      model_year: yearOf(get('model_year')),
      description: get('description'),
      category: get('category'),
      cost_cents: toCents(get('cost_cents'), centsCol),
    });
  }
  return out;
}

/** Pick the parser by content. */
export function parseShipmentFile(text: string): ParsedShipment {
  return looksLikeX12(text) ? parseX12_856(text) : parseShipmentCsv(text);
}
