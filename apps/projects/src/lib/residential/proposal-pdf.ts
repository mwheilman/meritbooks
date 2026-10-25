/**
 * The branded residential proposal / contract (RES-26): scope narrative, the priced scope by room,
 * options (alternates and add-ons, chosen ones marked), the allowance schedule, inclusions and
 * exclusions, the payment schedule, terms, the state cancellation notice and one signature block per
 * signer (both spouses). Pure rendering on the lib/templates Writer (pdf-lib, standard fonts); the
 * caller stores the bytes and sends them through lib/esign. Lines a company marks not client-visible
 * are rolled into their room's total instead of being listed.
 */
import { Writer, type Brand, type SignatureAnchor } from '@/lib/templates/layout';
import type { PaymentScheduleRow, ProposalLineRow, ProposalOptionRow, ProposalRow } from './types';

const usd = (c: number): string => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d: string | null | undefined): string => (d ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '-');

export const CONTRACT_WORDS: Record<ProposalRow['contract_type'], string> = {
  FIXED_PRICE: 'Fixed price', COST_PLUS_PCT: 'Cost plus a percentage fee', COST_PLUS_FEE: 'Cost plus a fixed fee',
  COST_PLUS_GMP: 'Cost plus fee with a guaranteed maximum price', TIME_MATERIALS: 'Time and materials', DESIGN_AGREEMENT: 'Design agreement',
  PURCHASE_AGREEMENT: 'Purchase agreement',
};

export interface ProposalDoc {
  proposal: ProposalRow;
  options: ProposalOptionRow[];
  lines: ProposalLineRow[];
  schedule: PaymentScheduleRow[];
  customerName: string | null;
  jobLabel: string | null;
  signers: Array<{ position: number; name: string }>;
}

export interface RenderedProposal { bytes: Uint8Array; anchors: SignatureAnchor[]; fileName: string; pageCount: number }

export async function renderProposal(doc: ProposalDoc, brand: Brand): Promise<RenderedProposal> {
  const p = doc.proposal;
  const w = await Writer.create(brand, { title: `${p.title} — proposal`, subtitle: [p.number, p.version > 1 ? `v${p.version}` : null].filter(Boolean).join(' ') });
  w.kv([
    ['Prepared for', doc.customerName ?? '-'], ['Project', doc.jobLabel ?? p.title],
    ['Contract form', CONTRACT_WORDS[p.contract_type]], ['Valid until', date(p.valid_until)],
    ...(p.planned_start ? [['Planned start', date(p.planned_start)] as const] : []),
  ]);
  if (p.scope_narrative) { w.heading('Scope of work'); w.text(p.scope_narrative); }

  const included = (l: ProposalLineRow) => !l.option_id || doc.options.find((o) => o.id === l.option_id)?.is_selected;
  const base = doc.lines.filter((l) => !l.option_id && !l.is_allowance);
  const rooms = new Map<string, ProposalLineRow[]>();
  for (const l of base) rooms.set(l.room ?? 'General', [...(rooms.get(l.room ?? 'General') ?? []), l]);
  w.heading('Scope and price');
  const rowsOut: string[][] = [];
  for (const [room, ls] of rooms) {
    const visible = ls.filter((l) => l.client_visible);
    const hidden = ls.filter((l) => !l.client_visible).reduce((s, l) => s + l.price_cents, 0);
    for (const l of visible) rowsOut.push([room, l.description, `${trim(l.qty)} ${l.uom}`, usd(l.price_cents)]);
    if (hidden) rowsOut.push([room, 'Labor, materials and supervision', '', usd(hidden)]);
  }
  w.table([{ label: 'Area', width: 0.18 }, { label: 'Description', width: 0.52 }, { label: 'Qty', width: 0.12, align: 'right' }, { label: 'Price', width: 0.18, align: 'right' }], rowsOut);

  if (doc.options.length) {
    w.heading('Options');
    w.table([{ label: 'Option', width: 0.5 }, { label: 'Kind', width: 0.2 }, { label: 'Chosen', width: 0.12 }, { label: 'Price', width: 0.18, align: 'right' }],
      doc.options.map((o) => [o.label + (o.description ? ` — ${o.description}` : ''), o.kind === 'ALTERNATE' ? `Pick one (${o.tier ?? o.group_key ?? ''})` : 'Add-on',
        o.is_selected ? 'Yes' : '', usd(doc.lines.filter((l) => l.option_id === o.id).reduce((s, l) => s + l.price_cents, 0))]));
  }
  const allowances = doc.lines.filter((l) => l.is_allowance && included(l));
  if (allowances.length) {
    w.heading('Allowance schedule');
    w.text('An allowance is the amount included in the price for an item you choose later. If your choice costs more, the difference is a change order you approve before it is ordered; if it costs less, you receive a credit.', { muted: true, size: 8.5 });
    w.table([{ label: 'Allowance', width: 0.5 }, { label: 'Category', width: 0.3 }, { label: 'Amount', width: 0.2, align: 'right' }],
      allowances.map((l) => [l.description, l.allowance_category ?? '-', usd(l.price_cents)]));
  }
  const totals: Array<readonly [string, string, boolean?]> = [
    ['Base scope', usd(p.base_price_cents)],
    ...(p.options_price_cents ? [['Chosen options', usd(p.options_price_cents)] as const] : []),
    ...(p.contingency_cents ? [['Contingency', usd(p.contingency_cents)] as const] : []),
    ...(p.fee_total_cents ? [['Builder fee', usd(p.fee_total_cents)] as const] : []),
    ['Contract price', usd(p.total_cents), true],
    ...(p.tax_cents ? [['Sales tax (on invoices)', usd(p.tax_cents)] as const, ['Total with tax', usd(p.grand_total_cents), true] as const] : []),
  ];
  w.table([{ label: '', width: 1 }], [], totals);

  if (p.inclusions.length) { w.heading('Included'); for (const s of p.inclusions) w.text(`• ${s}`); }
  if (p.exclusions.length) { w.heading('Not included'); for (const s of p.exclusions) w.text(`• ${s}`); }

  if (doc.schedule.length) {
    w.heading('Payment schedule');
    w.table([{ label: 'Payment', width: 0.55 }, { label: 'When', width: 0.25 }, { label: 'Amount', width: 0.2, align: 'right' }],
      doc.schedule.map((s) => [s.label, s.kind === 'DEPOSIT' ? 'At signing' : s.kind === 'FINAL' ? 'At completion' : 'When reached',
        s.amount_cents != null ? usd(s.amount_cents) : s.pct != null ? `${Math.round(s.pct * 10000) / 100}%` : '-']));
    if (p.retainer_credit_cents) w.text(`Your design retainer of ${usd(p.retainer_credit_cents)} is credited toward the deposit.`, { muted: true });
  }
  if (p.terms) { w.heading('Terms'); w.text(p.terms, { size: 8.5 }); }
  if (p.cancellation_notice) w.notice(`Your right to cancel (${p.cancel_days ?? 3} business days)`, p.cancellation_notice);
  w.heading('Acceptance');
  w.text('By signing, you accept this proposal, the payment schedule and the terms above.', { muted: true });
  w.signatures([...doc.signers.map((s) => ({ position: s.position, role: 'Homeowner', name: s.name })), { position: doc.signers.length + 1, role: brand.companyName }]);
  const bytes = await w.finish(`${brand.companyName} · ${p.title}${p.number ? ` · ${p.number}` : ''}`);
  const safe = p.title.replace(/[^\w .-]+/g, '').trim().slice(0, 80) || 'Proposal';
  return { bytes, anchors: w.anchors, fileName: `${safe}${p.version > 1 ? ` v${p.version}` : ''}.pdf`, pageCount: w.pageNo };
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}
