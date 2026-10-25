/**
 * Electronic parts catalogs (DLR parts lookup): deep links into the catalog the counter already uses
 * (ARI PartSmart, ARI PartStream, the OEM's own lookup) for a model / serial, from the address the
 * dealer saved, and the pick list the
 * catalog hands back (pasted text, PartSmart's cart export, or a PartStream cart URL) parsed into
 * the [{part_number, qty}] lines pm.dlr_add_pick_list puts on a counter ticket.
 * Pure; unit-tested.
 */
import { headerIndex, numText, parseDelimited } from './tabular';

export const CATALOG_ADAPTERS = ['PARTSMART', 'PARTSTREAM', 'OEM_WEB'] as const;
export type CatalogAdapter = (typeof CATALOG_ADAPTERS)[number];

export interface CatalogConfig {
  adapter: CatalogAdapter;
  /**
   * The lookup URL the dealer's catalog answers, saved on the integration (pm.dlr_integrations
   * config.url_template), with tokens {brand} {model} {serial} {part} {q} (q = part, else model).
   * PartSmart runs on the counter PC (http://localhost:…); PartStream and OEM lookups are web
   * pages whose address the dealer copies from their catalog account. No address is guessed here.
   */
  urlTemplate?: string | null;
}

export interface CatalogLookup {
  brand: string | null;
  model: string | null;
  serial: string | null;
  partNumber?: string | null;
}

const TOKENS = ['brand', 'model', 'serial', 'part', 'q'] as const;

/** Is this a usable catalog address (http/https, at least one lookup token)? */
export function validTemplate(t: string | null | undefined): boolean {
  const s = (t ?? '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) && TOKENS.some((k) => s.includes(`{${k}}`));
}

/** A link the counter opens in a new tab; null when the catalog is not set up or there is nothing to look up. */
export function catalogLink(cfg: CatalogConfig, l: CatalogLookup): string | null {
  if (!validTemplate(cfg.urlTemplate)) return null;
  const part = (l.partNumber ?? '').trim();
  const model = (l.model ?? '').trim();
  const serial = (l.serial ?? '').trim();
  if (!part && !model && !serial) return null;
  const vals: Record<(typeof TOKENS)[number], string> = {
    brand: (l.brand ?? '').trim().toUpperCase(), model, serial, part, q: part || model,
  };
  return cfg.urlTemplate!.trim().replace(/\{(brand|model|serial|part|q)\}/g, (_m, k: (typeof TOKENS)[number]) => encodeURIComponent(vals[k]));
}

export interface PickLine {
  part_number: string;
  qty: number;
  description?: string | null;
}

const PICK_ALIASES = {
  part_number: ['part number', 'part no', 'part #', 'part', 'sku', 'item', 'item number'],
  qty: ['qty', 'quantity', 'order qty', 'qty ordered'],
  description: ['description', 'desc', 'name'],
} as const;

function merge(lines: PickLine[]): PickLine[] {
  const by = new Map<string, PickLine>();
  for (const l of lines) {
    const k = l.part_number.toUpperCase();
    const prev = by.get(k);
    if (prev) prev.qty += l.qty; else by.set(k, { ...l, part_number: k });
  }
  return [...by.values()];
}

/**
 * A pick list in any of the shapes catalogs hand back:
 *   · a PartStream cart URL (…?sku=ABC&qty=2&sku=DEF&qty=1)
 *   · a delimited export with Part / Qty headings (PartSmart cart, spreadsheet)
 *   · pasted lines: "ABC-123 2", "2 x ABC-123", "ABC-123" (qty 1), "ABC-123, 2"
 * Same part twice adds up. At most 200 lines (the database's limit).
 */
export function parsePickList(text: string): PickLine[] {
  const s = text.trim();
  if (!s) return [];
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const skus = u.searchParams.getAll('sku').concat(u.searchParams.getAll('part'));
      const qtys = u.searchParams.getAll('qty');
      return merge(skus.map((p, i) => ({ part_number: p.trim(), qty: Math.max(1, numText(qtys[i]) ?? 1) })).filter((l) => l.part_number)).slice(0, 200);
    } catch {
      return [];
    }
  }
  const cells = parseDelimited(s);
  const idx = cells.length > 1 ? headerIndex(cells[0]!, PICK_ALIASES) : null;
  if (idx && idx.part_number >= 0) {
    const out: PickLine[] = [];
    for (const r of cells.slice(1)) {
      const pn = (r[idx.part_number] ?? '').trim();
      if (!pn) continue;
      const q = idx.qty >= 0 ? numText(r[idx.qty]) : 1;
      out.push({ part_number: pn, qty: q && q > 0 ? q : 1, description: idx.description >= 0 ? (r[idx.description] ?? '').trim() || null : null });
    }
    return merge(out).slice(0, 200);
  }
  const out: PickLine[] = [];
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^(\d+(?:\.\d+)?)\s*(?:x|\*|@)?\s+([A-Za-z0-9][\w./-]*)\b/i.exec(line);
    if (m) { out.push({ part_number: m[2]!, qty: Number(m[1]) }); continue; }
    m = /^([A-Za-z0-9][\w./-]*)[\s,;\t]+(?:qty\s*)?(\d+(?:\.\d+)?)\b/i.exec(line);
    if (m) { out.push({ part_number: m[1]!, qty: Number(m[2]) }); continue; }
    m = /^([A-Za-z0-9][\w./-]*)$/.exec(line);
    if (m) out.push({ part_number: m[1]!, qty: 1 });
  }
  return merge(out.filter((l) => l.qty > 0)).slice(0, 200);
}

/**
 * Scanner input at the counter: a UPC / EAN (digits, 8–14), a part number, or a unit's serial /
 * stock number. Scanners send the code then Enter; the box answers on Enter. Returns the cleaned
 * code, or null for a stray keystroke.
 */
export function cleanScan(raw: string): string | null {
  const s = raw.replace(/[\r\n\t]/g, '').trim();
  if (s.length < 2 || s.length > 60) return null;
  return s.toUpperCase();
}
