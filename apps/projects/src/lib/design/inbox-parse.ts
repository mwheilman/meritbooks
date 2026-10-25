/**
 * The vendor inbox (ID make-or-break: acknowledgements, ship notices and tracking from dozens of
 * vendors land in one place and update the right item). Rules only, no model: a forwarded vendor
 * email is read for PO numbers, sidemarks, dates, tracking numbers, a total and per-SKU prices,
 * producing the p_parsed pm.vi_ingest takes:
 *   { kind, po_numbers, sidemarks, dates: {ship_on, delivery_on, acknowledged_on}, tracking,
 *     total_cents, line_prices: [{sku, unit_cents}], lead_time_days }
 * The database proposes the item changes; a person applies or rejects each one. Pure; unit-tested.
 */
import { dateText, dollarsToCentsText } from '@/lib/dealer/tabular';

export const INBOX_KINDS = ['ACKNOWLEDGEMENT', 'SHIP_NOTICE', 'BACKORDER', 'INVOICE', 'DELIVERY', 'OTHER'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface ParsedVendorEmail {
  kind: InboxKind;
  po_numbers: string[];
  sidemarks: string[];
  dates: { ship_on: string | null; delivery_on: string | null; acknowledged_on: string | null };
  tracking: string[];
  total_cents: number | null;
  line_prices: Array<{ sku: string; unit_cents: number }>;
  lead_time_days: number | null;
}

const MONTHS: Readonly<Record<string, number>> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** "Oct 25, 2026", "25 October 2026", "10/25/2026", "2026-10-25" → ISO. */
export function looseDate(raw: string, today: string): string | null {
  const s = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  const iso = dateText(s);
  if (iso) return iso;
  let m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    return mo == null ? null : dateText(`${m[3]}-${mo}-${m[2]}`);
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2]!.slice(0, 3).toLowerCase()] != null) return dateText(`${m[3]}-${MONTHS[m[2]!.slice(0, 3).toLowerCase()]}-${m[1]}`);
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) {
    const y = Number(today.slice(0, 4));
    const d = dateText(`${y}-${m[1]}-${m[2]}`);
    return d && d < today ? dateText(`${y + 1}-${m[1]}-${m[2]}`) : d;
  }
  return null;
}

const DATE_RE = String.raw`(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4})`;

function firstDate(text: string, labels: string, today: string): string | null {
  const re = new RegExp(`(?:${labels})\\s*(?:date|on|by|:|-|is|of)*\\s*[:\\-]?\\s*${DATE_RE}`, 'i');
  const m = re.exec(text);
  return m ? looseDate(m[1]!, today) : null;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

/** Carrier tracking shapes: UPS 1Z…, FedEx 12/15/20 digits, USPS 20–22 digits / 2 letters + 9 digits + US, freight PRO numbers after "PRO". */
export function trackingNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b1Z[0-9A-Z]{16}\b/g)) out.push(m[0]);
  for (const m of text.matchAll(/\b[A-Z]{2}\d{9}US\b/g)) out.push(m[0]);
  for (const m of text.matchAll(/(?:tracking|track|fedex|usps|ups|waybill)[^\n\d]{0,30}((?:\d[ -]?){12,22})\b/gi)) out.push(m[1]!.replace(/[ -]/g, ''));
  for (const m of text.matchAll(/\bPRO\s*(?:#|no\.?|number)?\s*[:\-]?\s*(\d{7,12})\b/gi)) out.push(`PRO ${m[1]}`);
  return uniq(out).slice(0, 10);
}

export function kindOf(subject: string, body: string): InboxKind {
  const s = `${subject}\n${body.slice(0, 2000)}`.toLowerCase();
  if (/back[\s-]?order|backordered|out of stock|delayed until/.test(s)) return 'BACKORDER';
  if (/\b(shipped|ship notice|has shipped|shipment|in transit|tracking)\b/.test(s)) return 'SHIP_NOTICE';
  if (/\b(delivered|delivery confirmation|received at)\b/.test(s)) return 'DELIVERY';
  if (/\b(acknowledg\w*|order confirmation|confirming your order|order received|sales order)\b/.test(s)) return 'ACKNOWLEDGEMENT';
  if (/\b(invoice|amount due|balance due|proforma|pro forma)\b/.test(s)) return 'INVOICE';
  return 'OTHER';
}

/**
 * Read a forwarded vendor email. `poPrefixes` are the studio's own PO number shapes
 * (e.g. ["PO-", "DS-"]) so a bare "PO-2026-0141" is found even without the word "PO".
 */
export function parseVendorEmail(subject: string, body: string, today: string, poPrefixes: ReadonlyArray<string> = ['PO-']): ParsedVendorEmail {
  const text = `${subject}\n${body}`;
  const pos: string[] = [];
  for (const m of text.matchAll(/\b(?:P\.?O\.?|purchase order|your order|customer po|cust po|reference)\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{2,24})\b/gi)) {
    if (/\d/.test(m[1]!)) pos.push(m[1]!.toUpperCase());
  }
  for (const p of poPrefixes) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of text.matchAll(new RegExp(`\\b(${esc}[A-Z0-9-]{2,20})\\b`, 'gi'))) pos.push(m[1]!.toUpperCase());
  }
  const sidemarks: string[] = [];
  for (const m of text.matchAll(/\b(?:side\s?mark|sidemark|tag|mark for)\s*[:\-#]?\s*([^\n,;]{2,60})/gi)) sidemarks.push(m[1]!.trim().replace(/\s+/g, ' '));
  const lineprices: Array<{ sku: string; unit_cents: number }> = [];
  for (const m of text.matchAll(/\b(?:sku|item|style|model)\s*(?:#|no\.?)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9.\-/]{2,30})\b[^\n$]{0,60}\$\s?([\d,]+(?:\.\d{1,2})?)/gi)) {
    const c = dollarsToCentsText(m[2]!);
    if (c != null && c > 0) lineprices.push({ sku: m[1]!.toUpperCase(), unit_cents: c });
  }
  const totalM = /\b(?:order total|total due|grand total|invoice total|total)\s*[:\-]?\s*(?:USD\s*)?\$\s?([\d,]+(?:\.\d{1,2})?)/i.exec(text);
  const leadM = /\b(?:lead time|ships in|ship in|allow)\s*(?:of|is|:)?\s*(\d{1,3})\s*(?:-\s*\d{1,3}\s*)?(business days|days|weeks|wks)\b/i.exec(text);
  const lead = leadM ? Number(leadM[1]) * (/w/i.test(leadM[2]!) ? 7 : 1) : null;
  return {
    kind: kindOf(subject, body),
    po_numbers: uniq(pos).slice(0, 10),
    sidemarks: uniq(sidemarks).slice(0, 10),
    dates: {
      ship_on: firstDate(text, 'ship(?:ped|s|ping)?|est(?:imated)?\\.? ship|ready to ship', today),
      delivery_on: firstDate(text, 'deliver(?:y|ed)?|est(?:imated)?\\.? deliver(?:y)?|eta|arriv(?:e|al)', today),
      acknowledged_on: firstDate(text, 'order date|acknowledg(?:ed|ement)|confirmed', today),
    },
    tracking: trackingNumbers(text),
    total_cents: totalM ? dollarsToCentsText(totalM[1]!) : null,
    line_prices: lineprices.slice(0, 50),
    lead_time_days: lead != null && lead > 0 && lead < 400 ? lead : null,
  };
}
