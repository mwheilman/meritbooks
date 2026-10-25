/**
 * Electronic parts ordering adapters (DLR-34). One adapter per distributor / OEM. Where the trading
 * partner documents a file format, the adapter builds it (ANSI X12 850 purchase order, or the
 * partner's CSV order file) and parses its acknowledgment (X12 855 / CSV ack). Partners whose
 * ordering API needs a dealer agreement and credentials are stubbed: `submit` returns
 * `{ sent: false, channel: 'PORTAL' }` with the file to upload, so the counter is never blocked.
 * The database records every transmission and ack (pm.dlr_record_order_transmission /
 * pm.dlr_record_order_ack); nothing here talks to the network.
 */

export interface OrderLine {
  line_no: number;
  part_number: string;
  description?: string | null;
  qty: number;
  unit_cost_cents?: number | null;
  uom?: string | null;
}

export interface OrderHeader {
  po_number: string;
  dealer_account: string;
  ship_to_name: string;
  ship_to_code?: string | null;
  order_date: string; // YYYY-MM-DD
  kind: 'STOCK' | 'EMERGENCY' | 'SPECIAL';
}

export interface AckLine {
  line_no?: number;
  part_number?: string;
  qty_ack: number;
  qty_backorder: number;
  eta?: string | null;
}

export interface Ack {
  status?: 'ACKNOWLEDGED' | 'PARTIAL' | 'REJECTED';
  vendor_ref?: string | null;
  lines: AckLine[];
}

export type Channel = 'EDI_FILE' | 'API' | 'PORTAL' | 'EMAIL';
export type Format = 'X12_850' | 'CSV' | 'JSON' | 'PDF';

export interface Prepared {
  provider: string;
  channel: Channel;
  format: Format;
  file_name: string;
  payload: string;
  /** True when the adapter could deliver it itself; false = the counter uploads / emails the file. */
  sent: boolean;
  instructions: string;
}

export interface Provider {
  code: string;
  name: string;
  /** How orders go today: a documented file the dealer uploads, or a stub for an API that needs credentials. */
  mode: 'X12' | 'CSV' | 'API_STUB';
  ack: 'X12_855' | 'CSV' | 'MANUAL';
  notes: string;
}

export const PROVIDERS: readonly Provider[] = [
  { code: 'STENS', name: 'Stens', mode: 'CSV', ack: 'CSV', notes: 'Order file upload in the dealer portal (part number, quantity).' },
  { code: 'ROTARY', name: 'Rotary Corp', mode: 'CSV', ack: 'CSV', notes: 'Quick-order CSV upload; ack is a CSV export of the order.' },
  { code: 'OREGON', name: 'Oregon Tool', mode: 'X12', ack: 'X12_855', notes: 'EDI 850 / 855 through the dealer\'s VAN mailbox.' },
  { code: 'KUBOTA', name: 'Kubota (KubotaLink)', mode: 'API_STUB', ack: 'MANUAL', notes: 'Dealer-system API needs a Kubota DMS agreement; upload the CSV in the portal meanwhile.' },
  { code: 'TORO', name: 'Toro (myTurf)', mode: 'API_STUB', ack: 'MANUAL', notes: 'Toro dealer API needs credentials; portal upload until connected.' },
  { code: 'STIHL', name: 'STIHL (iCademy / STIHL Dealer Net)', mode: 'API_STUB', ack: 'MANUAL', notes: 'Distributor ordering; portal upload until connected.' },
  { code: 'HUSQVARNA', name: 'Husqvarna (SalesLink)', mode: 'API_STUB', ack: 'MANUAL', notes: 'SalesLink order import; portal upload until connected.' },
  { code: 'ECHO', name: 'ECHO (Echo Link)', mode: 'API_STUB', ack: 'MANUAL', notes: 'Portal upload until connected.' },
  { code: 'BRIGGS', name: 'Briggs & Stratton (PowerPortal)', mode: 'X12', ack: 'X12_855', notes: 'EDI 850 / 855 for dealers on the PowerPortal EDI program.' },
  { code: 'OTHER', name: 'Other distributor', mode: 'CSV', ack: 'MANUAL', notes: 'Generic CSV order file; email or upload it.' },
];

export function providerFor(code: string): Provider {
  return PROVIDERS.find((p) => p.code === code.toUpperCase()) ?? PROVIDERS[PROVIDERS.length - 1]!;
}

const clean = (s: string, max: number) => s.replace(/[~*^|\r\n]/g, ' ').trim().slice(0, max);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const money = (cents: number | null | undefined) => (cents == null ? '' : (cents / 100).toFixed(2));

/** ANSI X12 850 (version 004010) with ISA / GS envelopes; segment terminator "~", element "*". */
export function buildX12_850(h: OrderHeader, lines: readonly OrderLine[], ids: { sender: string; receiver: string; control: number }): string {
  const ymd = h.order_date.replace(/-/g, '');
  const ctl = String(ids.control).padStart(9, '0');
  const segs: string[] = [];
  segs.push(['ISA', '00', pad('', 10), '00', pad('', 10), 'ZZ', pad(clean(ids.sender, 15), 15), 'ZZ', pad(clean(ids.receiver, 15), 15),
    ymd.slice(2), '1200', 'U', '00401', ctl, '0', 'P', '>'].join('*'));
  segs.push(['GS', 'PO', clean(ids.sender, 15), clean(ids.receiver, 15), ymd, '1200', String(ids.control), 'X', '004010'].join('*'));
  const body: string[] = [];
  body.push(['ST', '850', '0001'].join('*'));
  body.push(['BEG', '00', h.kind === 'EMERGENCY' ? 'RE' : h.kind === 'SPECIAL' ? 'SA' : 'SA', clean(h.po_number, 22), '', ymd].join('*'));
  body.push(['REF', 'IA', clean(h.dealer_account, 30)].join('*'));
  body.push(['N1', 'ST', clean(h.ship_to_name, 60), ...(h.ship_to_code ? ['92', clean(h.ship_to_code, 20)] : [])].join('*'));
  for (const l of lines) {
    body.push(['PO1', String(l.line_no), String(l.qty), clean(l.uom ?? 'EA', 2), money(l.unit_cost_cents), '', 'VP', clean(l.part_number, 48)].join('*'));
    if (l.description) body.push(['PID', 'F', '', '', '', clean(l.description, 80)].join('*'));
  }
  body.push(['CTT', String(lines.length), String(lines.reduce((a, l) => a + l.qty, 0))].join('*'));
  body.push(['SE', String(body.length + 1), '0001'].join('*'));
  segs.push(...body);
  segs.push(['GE', '1', String(ids.control)].join('*'));
  segs.push(['IEA', '1', ctl].join('*'));
  return segs.join('~') + '~';
}

/** Generic CSV order file (part number, quantity, description, PO). */
export function buildOrderCsv(h: OrderHeader, lines: readonly OrderLine[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ['part_number,qty,description,po_number,account', ...lines.map((l) => [l.part_number, String(l.qty), l.description ?? '', h.po_number, h.dealer_account].map(q).join(','))].join('\n');
}

/** Parse an X12 855 acknowledgment: BAK (status, vendor order), PO1 + ACK (accepted / backordered + ETA). */
export function parseX12_855(text: string): Ack {
  const segs = text.replace(/\r?\n/g, '').split('~').map((s) => s.trim()).filter(Boolean).map((s) => s.split('*'));
  const out: Ack = { lines: [] };
  let cur: AckLine | null = null;
  const flush = () => { if (cur) out.lines.push(cur); cur = null; };
  for (const s of segs) {
    if (s[0] === 'BAK') {
      out.status = s[2] === 'AC' || s[2] === 'AD' ? 'ACKNOWLEDGED' : s[2] === 'RJ' ? 'REJECTED' : 'PARTIAL';
      out.vendor_ref = s[8] || s[3] || null;
    } else if (s[0] === 'PO1') {
      flush();
      const vp = s.indexOf('VP');
      cur = { line_no: Number(s[1]) || undefined, part_number: vp > 0 ? s[vp + 1] : undefined, qty_ack: 0, qty_backorder: 0 };
    } else if (s[0] === 'ACK' && cur) {
      const qty = Number(s[2]) || 0;
      // IA accepted, IB backordered, IR rejected; DTM-style date in ACK05 when present (YYYYMMDD)
      if (s[1] === 'IB' || s[1] === 'BP') {
        cur.qty_backorder += qty;
        const d = s[5];
        if (d && /^\d{8}$/.test(d)) cur.eta = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      } else if (s[1] !== 'IR' && s[1] !== 'R2') cur.qty_ack += qty;
    }
  }
  flush();
  if (!out.status) out.status = out.lines.some((l) => l.qty_backorder > 0) ? 'PARTIAL' : 'ACKNOWLEDGED';
  return out;
}

/** Parse a CSV ack (part_number, qty_shipped|qty_ack, qty_backorder, eta). */
export function parseAckCsv(text: string): Ack {
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  if (rows.length < 2) return { lines: [] };
  const head = rows[0]!.split(',').map((h) => h.trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const pn = col(/^(part|part.?number|item)$/);
  const ack = col(/^(qty.?(ack|shipped|confirmed)|shipped)$/);
  const bo = col(/^(qty.?back.?order(ed)?|backorder(ed)?|bo)$/);
  const eta = col(/^(eta|due|expected)$/);
  const lines: AckLine[] = rows.slice(1).map((r) => {
    const c = r.split(',').map((x) => x.trim());
    return { part_number: pn >= 0 ? c[pn] : undefined, qty_ack: Number(c[ack] ?? 0) || 0, qty_backorder: Number(c[bo] ?? 0) || 0, eta: eta >= 0 && c[eta] ? c[eta] : null };
  });
  return { lines, status: lines.some((l) => l.qty_backorder > 0) ? 'PARTIAL' : 'ACKNOWLEDGED' };
}

/** Prepare the order for a provider: the file (or stub payload) and what the counter does next. */
export function prepareOrder(providerCode: string, h: OrderHeader, lines: readonly OrderLine[], control = 1): Prepared {
  const p = providerFor(providerCode);
  if (p.mode === 'X12') {
    return { provider: p.code, channel: 'EDI_FILE', format: 'X12_850', file_name: `${h.po_number}.850.edi`, sent: false,
      payload: buildX12_850(h, lines, { sender: h.dealer_account, receiver: p.code, control }),
      instructions: `Drop the 850 file in your ${p.name} EDI mailbox; load the 855 they return to record the acknowledgment.` };
  }
  return { provider: p.code, channel: p.mode === 'API_STUB' ? 'PORTAL' : 'PORTAL', format: 'CSV', file_name: `${h.po_number}.csv`, sent: false,
    payload: buildOrderCsv(h, lines),
    instructions: p.mode === 'API_STUB' ? `${p.name} ordering is not connected yet: upload this file in the ${p.name} dealer portal, then mark it sent.`
      : `Upload this file in the ${p.name} portal, then mark it sent.` };
}

export function parseAck(text: string): Ack {
  return /(^|~)\s*(ISA|ST\*855|BAK)\*/.test(text) ? parseX12_855(text) : parseAckCsv(text);
}
