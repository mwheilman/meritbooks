/**
 * Warranty claim submission (DLR warranty, make-or-break: claims filed on time, every field the OEM
 * asks for, credits matched). One interface per OEM; the database decides the channel
 * (pm.dlr_prepare_claim_submission: DIRECT only when that brand's integration is CONNECTED,
 * otherwise PORTAL_ASSIST) and builds the packet. The direct adapters are stubs until each OEM
 * grants API access: they answer NOT_CONNECTED and the clerk files from the portal-assist packet
 * (copy each field, then record the claim number). Nothing here holds a credential; the
 * integration row stores only non-secret config. Pure; unit-tested.
 */

import { dollarsToCentsText, headerIndex, parseDelimited } from './tabular';

export const WARRANTY_BRANDS = ['KUBOTA', 'TORO', 'EXMARK', 'STIHL', 'HUSQVARNA', 'ECHO', 'BRIGGS'] as const;
export type WarrantyBrand = (typeof WARRANTY_BRANDS)[number];

export interface CopyField {
  label: string;
  value: string | number | null;
}

export interface ClaimPacket {
  claim_number?: string | null;
  unit?: { make: string | null; model: string | null; model_year: number | null; serial_number: string | null } & Record<string, unknown>;
  failure?: Record<string, unknown>;
  labor?: { labor_op: string | null; requested_hours: number | null; labor_cents: number | null };
  parts?: Array<{ part_number: string; description: string | null; qty: number; unit_price_cents: number | null; is_causal?: boolean }>;
  copy_fields: CopyField[];
  submit_by: string | null;
}

export interface PreparedSubmission {
  submission_id: string;
  attempt_no: number;
  channel: 'DIRECT' | 'PORTAL_ASSIST';
  packet: ClaimPacket;
}

export type SubmitResult =
  | { status: 'SENT' | 'ACKNOWLEDGED'; externalRef: string; claimNumber: string | null; response: Record<string, unknown> }
  | { status: 'FAILED'; message: string; response: Record<string, unknown> }
  | { status: 'NOT_CONNECTED'; message: string };

export interface ClaimSubmitter {
  brand: WarrantyBrand;
  /** The OEM's dealer portal, for the portal-assist hand-off (opened in a new tab). */
  portalName: string;
  /** Sends the packet to the OEM. Stubs answer NOT_CONNECTED. */
  submit(p: PreparedSubmission): Promise<SubmitResult>;
}

const PORTALS: Readonly<Record<WarrantyBrand, string>> = {
  KUBOTA: 'Kubota dealer portal',
  TORO: 'Toro dealer portal',
  EXMARK: 'Exmark dealer portal',
  STIHL: 'STIHL dealer portal',
  HUSQVARNA: 'Husqvarna dealer portal',
  ECHO: 'ECHO dealer portal',
  BRIGGS: 'Briggs & Stratton dealer portal',
};

function stub(brand: WarrantyBrand): ClaimSubmitter {
  return {
    brand,
    portalName: PORTALS[brand],
    async submit() {
      return { status: 'NOT_CONNECTED', message: `Direct filing with ${brand.charAt(0)}${brand.slice(1).toLowerCase()} is not connected yet. File on the ${PORTALS[brand]} from the packet, then record the claim number.` };
    },
  };
}

/** The adapter registry: one stub per OEM until a direct interface is certified. */
export const SUBMITTERS: Readonly<Record<WarrantyBrand, ClaimSubmitter>> = Object.fromEntries(
  WARRANTY_BRANDS.map((b) => [b, stub(b)]),
) as Record<WarrantyBrand, ClaimSubmitter>;

export function submitterFor(brand: string | null | undefined): ClaimSubmitter | null {
  const b = (brand ?? '').toUpperCase();
  return (WARRANTY_BRANDS as readonly string[]).includes(b) ? SUBMITTERS[b as WarrantyBrand] : null;
}

/** Field keys pm.dlr_claim_readiness reports missing → the label the claim builder shows. */
export const CLAIM_FIELD_LABELS: Readonly<Record<string, string>> = {
  oem_brand: 'Manufacturer',
  serial_number: 'Unit serial number',
  claimed_amount: 'Claimed amount',
  pre_auth_ref: 'Pre-authorization number (over the OEM’s limit)',
  causal_part: 'Causal part',
  causal_part_number: 'Causal part number',
  failure_on: 'Failure date',
  repair_on: 'Repair date',
  purchase_on: 'Purchase / delivery date',
  machine_hours: 'Machine hours',
  engine_hours: 'Engine hours',
  engine_serial: 'Engine serial',
  symptom_code: 'Symptom code',
  defect_code: 'Defect code',
  remedy_code: 'Remedy code',
  complaint: 'Complaint',
  cause: 'Cause',
  correction: 'Correction',
  requested_hours: 'Requested labor hours',
};

export function missingLabels(keys: ReadonlyArray<string>): string[] {
  return keys.map((k) => CLAIM_FIELD_LABELS[k] ?? k.replace(/_/g, ' '));
}

/** The packet as plain text, one "Label: value" per line, for pasting into a portal notes box or an email. */
export function packetText(p: ClaimPacket): string {
  const lines = p.copy_fields.filter((f) => f.value != null && String(f.value).trim() !== '').map((f) => `${f.label}: ${f.value}`);
  for (const part of p.parts ?? []) lines.push(`Part ${part.part_number}${part.is_causal ? ' (causal)' : ''} × ${part.qty}${part.description ? ` — ${part.description}` : ''}`);
  return lines.join('\n');
}

/** Days left to file (negative = late), from an ISO date and today's ISO date. */
export function daysLeft(submitBy: string | null, today: string): number | null {
  if (!submitBy) return null;
  const a = Date.parse(`${submitBy}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 86_400_000) : null;
}

export interface CreditMemoLine {
  claim_number: string | null;
  serial_number: string | null;
  reference: string | null;
  description: string | null;
  amount_cents: number;
}

const MEMO_ALIASES = {
  claim_number: ['claim number', 'claim no', 'claim #', 'claim', 'warranty claim'],
  serial_number: ['serial number', 'serial', 'serial no', 'vin', 'pin'],
  reference: ['reference', 'ref', 'invoice', 'document', 'ro number', 'repair order'],
  description: ['description', 'memo', 'comment', 'detail'],
  amount: ['amount', 'credit', 'credit amount', 'paid', 'paid amount', 'total'],
} as const;

/** An OEM credit memo statement (CSV / tab) → lines pm.dlr_import_credit_memo matches to claims. */
export function parseCreditMemo(text: string): { lines: CreditMemoLine[]; issues: string[] } {
  const cells = parseDelimited(text);
  if (cells.length < 2) return { lines: [], issues: ['The statement has no lines.'] };
  const idx = headerIndex(cells[0]!, MEMO_ALIASES);
  if (idx.amount < 0) return { lines: [], issues: ['No amount column. Expected a heading such as “Credit Amount”.'] };
  const lines: CreditMemoLine[] = [];
  const issues: string[] = [];
  cells.slice(1).forEach((c, i) => {
    const at = (k: keyof typeof idx) => (idx[k] >= 0 ? (c[idx[k]] ?? '').trim() || null : null);
    const amt = dollarsToCentsText(at('amount'));
    if (amt == null) { if (c.some((x) => x.trim())) issues.push(`Row ${i + 2}: no readable amount.`); return; }
    lines.push({ claim_number: at('claim_number'), serial_number: at('serial_number'), reference: at('reference'), description: at('description'), amount_cents: amt });
  });
  return { lines: lines.slice(0, 2000), issues };
}
