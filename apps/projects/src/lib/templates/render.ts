/**
 * Render a document template to a branded PDF (company brand from public.brand_profiles via
 * pm.doc_brand, the pack's vocabulary, the company's template text). Returns the bytes and the
 * signature anchors, which travel with the version (doc_versions.meta.anchors) so the e-sign
 * stamp lands on the signature lines.
 */
import { Writer } from './layout';
import { lower } from '@/lib/pm/vocab';
import type {
  BuyersOrderData, ChangeOrderData, ContractData, DailyReportData, DrawRequestData, InstallTicketData, LienWaiverData,
  MoneyLine, Party, PayAppCoverData, ProposalData, PurchaseOrderData, RenderedDocument, TemplateContext, TemplateDataMap,
  TemplateKey, WorkOrderData,
} from './types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10-24" (or an ISO timestamp) → "October 24, 2026", without time-zone drift. */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
}

/** Integer cents → "$12,345.67" / "($1,200.00)"; null → "-". */
export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '-';
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const s = `$${whole}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `(${s})` : s;
}

function qty(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function party(p: Party): string {
  return [p.name, ...(p.lines ?? []), p.email, p.phone].filter((x): x is string => !!x && x.trim() !== '').join('\n');
}

function lineTable(w: Writer, lines: ReadonlyArray<MoneyLine>, showPrices: boolean, totals: Array<readonly [string, string, boolean?]>): void {
  if (showPrices) {
    w.table(
      [{ label: 'Description', width: 0.52 }, { label: 'Qty', width: 0.1, align: 'right' }, { label: 'Unit', width: 0.08 }, { label: 'Rate', width: 0.14, align: 'right' }, { label: 'Amount', width: 0.16, align: 'right' }],
      lines.map((l) => [l.note ? `${l.description}\n${l.note}` : l.description, qty(l.qty), l.uom ?? '', l.unitCents == null ? '' : usd(l.unitCents), usd(l.amountCents)]),
      totals,
    );
  } else {
    w.table([{ label: 'Description', width: 0.74 }, { label: 'Qty', width: 0.14, align: 'right' }, { label: 'Unit', width: 0.12 }],
      lines.map((l) => [l.description, qty(l.qty), l.uom ?? '']));
  }
}

function signers(names: ReadonlyArray<string | null> | undefined, role: string): Array<{ position: number; role: string; name: string | null }> {
  const list = names && names.length ? names : [null];
  return list.map((n, i) => ({ position: i + 1, role: list.length > 1 ? `${role} ${i + 1}` : role, name: n }));
}

type Renderer<K extends TemplateKey> = (w: Writer, d: TemplateDataMap[K], c: TemplateContext) => void;

const proposal: Renderer<'proposal'> = (w, d, c) => {
  w.kv([[c.vocab.customer, party(d.customer)], ['Prepared by', c.brand.companyName], [c.vocab.job, d.jobName], ['Site', d.site ?? '-'],
        ['Date', fmtDate(d.date)], ['Valid until', fmtDate(d.validUntil)]]);
  if (c.settings.intro || d.intro) w.text(c.settings.intro ?? d.intro ?? '');
  w.heading('Scope and price');
  lineTable(w, d.lines, true, [
    ...(d.allowanceCents ? [['Includes allowances', usd(d.allowanceCents)] as const] : []),
    ['Total', usd(d.totalCents), true] as const,
  ]);
  if (d.retainagePct) w.text(`Retainage of ${Math.round(d.retainagePct * 1000) / 10}% is held on each invoice until completion.`, { muted: true });
  if (d.notes) { w.heading('Notes'); w.text(d.notes); }
  w.heading('Terms');
  w.text(c.settings.terms ?? `This ${lower(c.vocab.estimate)} is valid until the date shown. Work not listed above is excluded and is added only by a signed ${lower(c.vocab.change_order)}. Allowances are budgets; selections above an allowance are billed as the difference.`);
  w.heading('Acceptance');
  w.text(`By signing, you accept this ${lower(c.vocab.estimate)} and its terms and authorize ${c.brand.companyName} to schedule the work.`, { muted: true });
  w.signatures([...signers(d.customerSigners, c.vocab.customer), { position: (d.customerSigners?.length || 1) + 1, role: c.brand.companyName }]);
};

const contract: Renderer<'contract'> = (w, d, c) => {
  w.kv([['Owner', party(d.customer)], ['Contractor', c.brand.companyName], [c.vocab.job, d.jobName], ['Site', d.site ?? '-'],
        ['Contract type', d.contractType ?? 'Fixed price'], ['Contract date', fmtDate(d.date)],
        ['Start', fmtDate(d.startOn)], ['Substantial completion', fmtDate(d.finishOn)]]);
  w.heading('1. Work');
  w.text(d.intro ?? `The Contractor will furnish the labor, materials and supervision for the work described below and in ${d.number}${d.version ? ` version ${d.version}` : ''}.`);
  lineTable(w, d.lines, true, [['Contract sum', usd(d.totalCents), true]]);
  if (d.paymentSchedule?.length) {
    w.heading('2. Payment schedule');
    w.table([{ label: 'Milestone', width: 0.62 }, { label: 'Percent', width: 0.14, align: 'right' }, { label: 'Amount', width: 0.24, align: 'right' }],
      d.paymentSchedule.map((p) => [p.label, p.pct == null ? '' : `${Math.round(p.pct * 1000) / 10}%`, usd(p.amountCents)]));
  }
  w.heading(d.paymentSchedule?.length ? '3. Changes' : '2. Changes');
  w.text(`Changes to the work, price or time are made only by a written ${lower(c.vocab.change_order)} signed by both parties before the changed work starts, except emergency work needed to protect people or property.`);
  w.heading('Terms');
  w.text(c.settings.terms ?? 'Payment is due within 10 days of each invoice. The Contractor warrants its workmanship for one year from substantial completion. Concealed or unknown conditions found during the work are handled as a change. Either party may end this contract for the other\'s material breach not cured within 7 days of written notice.');
  w.notice(c.settings.noticeTitle ?? 'Notice of right to cancel',
    c.settings.notice ?? 'You, the buyer, may cancel this transaction at any time before midnight of the third business day after the date of this transaction. Send or deliver a signed and dated copy of a cancellation notice, or any other written notice, to the Contractor at the address above.');
  w.signatures([...signers(d.customerSigners, 'Owner'), { position: (d.customerSigners?.length || 1) + 1, role: 'Contractor', name: c.brand.companyName }]);
};

const changeOrder: Renderer<'change_order'> = (w, d, c) => {
  w.kv([[c.vocab.customer, party(d.customer)], [c.vocab.job, d.jobName], [`${c.vocab.change_order} no.`, d.number], ['Date', fmtDate(d.date)]]);
  w.heading('Change');
  w.text(d.title, { bold: true });
  if (d.description) w.text(d.description);
  if (d.reason) w.text(`Reason: ${d.reason}`, { muted: true });
  if (d.lines?.length) lineTable(w, d.lines, d.amountCents !== null, []);
  w.heading('Effect on the contract');
  const prior = (d.originalContractCents ?? 0) + (d.previousChangesCents ?? 0);
  w.kv([
    ['Original contract', usd(d.originalContractCents)],
    ['Previous changes', usd(d.previousChangesCents)],
    ['This change', usd(d.amountCents)],
    ['New contract sum', d.amountCents === null || d.originalContractCents == null ? '-' : usd(prior + d.amountCents)],
    ['Schedule', d.scheduleDays ? `${d.scheduleDays > 0 ? '+' : ''}${d.scheduleDays} working days` : 'No change'],
  ]);
  w.text(`Work under this ${lower(c.vocab.change_order)} proceeds only after it is signed.`, { muted: true });
  w.signatures([...signers(d.customerSigners, c.vocab.customer), { position: (d.customerSigners?.length || 1) + 1, role: c.brand.companyName }]);
};

const payApp: Renderer<'pay_app_cover'> = (w, d, c) => {
  w.kv([['To (owner)', party(d.owner)], ['From (contractor)', c.brand.companyName], [c.vocab.job, d.jobName],
        ['Application no.', d.applicationNo == null ? '-' : String(d.applicationNo)], ['Period to', fmtDate(d.periodEnd)], ['Date', fmtDate(d.date)]]);
  w.heading("Contractor's application for payment");
  const sumToDate = (d.originalContractCents ?? 0) + (d.changeOrdersCents ?? 0);
  const earnedLessRet = d.totalCompletedCents - d.retainageCents;
  w.table([{ label: 'Line', width: 0.08 }, { label: 'Description', width: 0.62 }, { label: 'Amount', width: 0.3, align: 'right' }], [
    ['1', 'Original contract sum', usd(d.originalContractCents)],
    ['2', `Net change by ${lower(c.vocab.change_orders)}`, usd(d.changeOrdersCents)],
    ['3', 'Contract sum to date (1 + 2)', usd(sumToDate)],
    ['4', 'Total completed and stored to date', usd(d.totalCompletedCents)],
    ['5', 'Retainage', usd(d.retainageCents)],
    ['6', 'Total earned less retainage (4 - 5)', usd(earnedLessRet)],
    ['7', 'Less previous certificates for payment', usd(d.previousCertificatesCents)],
    ['8', 'Current payment due', usd(d.currentDueCents)],
    ['9', 'Balance to finish, including retainage (3 - 6)', usd(sumToDate - earnedLessRet)],
  ]);
  w.text('The undersigned Contractor certifies that, to the best of its knowledge, the work covered by this application has been completed in accordance with the contract documents, that all amounts have been paid by the Contractor for work for which previous certificates were issued, and that the current payment shown is now due.', { muted: true });
  w.signatures([{ position: 1, role: 'Owner / architect' }, { position: 2, role: 'Contractor', name: c.brand.companyName }]);
};

const workOrder: Renderer<'work_order'> = (w, d, c) => {
  w.kv([[c.vocab.customer, party(d.customer)], ['Site', d.site ?? '-'], [`${c.vocab.work_order} no.`, d.number], ['Type', d.kindLabel],
        ['Date', fmtDate(d.date)], ['Scheduled', d.scheduled ? fmtDate(d.scheduled) : '-']]);
  w.heading('Work');
  w.text(d.summary, { bold: true });
  if (d.description) w.text(d.description);
  if (d.complaint || d.cause || d.resolution) w.kv([['Complaint', d.complaint ?? '-'], ['Cause', d.cause ?? '-'], ['Correction', d.resolution ?? '-']], 1);
  if (d.lines.length) {
    w.heading('Parts and labor');
    lineTable(w, d.lines, d.showPrices, d.showPrices && d.totalCents != null ? [['Total', usd(d.totalCents), true]] : []);
  }
  w.heading('Authorization');
  w.text(`I authorize the work above${d.showPrices ? ' at the prices shown' : ''} and confirm it was completed to my satisfaction.`, { muted: true });
  w.signatures([{ position: 1, role: c.vocab.customer }, { position: 2, role: 'Technician' }]);
};

const installTicket: Renderer<'install_ticket'> = (w, d, c) => {
  workOrder(w, { ...d, lines: d.lines }, c);
  if (d.checklist?.length) {
    w.heading('Completion checklist');
    for (const item of d.checklist) w.text(`[ ] ${item}`);
  }
};

const dailyReport: Renderer<'daily_report'> = (w, d, c) => {
  w.kv([[c.vocab.job, d.jobName], ['Date', fmtDate(d.date)], ['Report', d.kindLabel], ['By', d.author ?? '-'],
        ['Weather', d.weather ?? '-'], ['Crew', `${d.crewCount ?? '-'} people · ${d.hours ?? '-'} hours`]]);
  w.heading('Work performed and notes');
  w.text(d.body || 'No notes recorded.');
  if (d.photos) w.text(`${d.photos} photo${d.photos === 1 ? '' : 's'} attached to this report in Merit Projects.`, { muted: true });
  w.signatures([{ position: 1, role: c.vocab.superintendent }]);
};

const purchaseOrder: Renderer<'purchase_order'> = (w, d, c) => {
  w.kv([['Vendor', party(d.vendor)], ['Bill to', c.brand.companyName], [c.vocab.job, d.jobName], ['Ship to', d.shipTo ?? '-'],
        ['PO number', d.number], ['Date', fmtDate(d.date)]]);
  if (d.title) w.text(d.title, { bold: true });
  w.heading('Items');
  lineTable(w, d.lines, true, [['Total', usd(d.totalCents), true]]);
  w.heading('Terms');
  w.text(d.terms ?? c.settings.terms ?? 'Reference the PO number on every invoice, packing slip and delivery. Prices are firm. Changes need a written PO change from the buyer.');
  w.signatures([{ position: 1, role: 'Vendor acceptance', name: d.vendor.name }, { position: 2, role: 'Authorized buyer', name: c.brand.companyName }]);
};

const buyersOrder: Renderer<'buyers_order'> = (w, d, c) => {
  w.kv([['Purchaser', party(d.customer)], ['Dealer', c.brand.companyName], ['Order no.', d.number], ['Date', fmtDate(d.date)], ['Price good until', fmtDate(d.validUntil)]]);
  w.heading('Equipment and items');
  lineTable(w, d.lines, true, []);
  if (d.trades.length) {
    w.heading('Trade-ins');
    w.table([{ label: 'Trade', width: 0.56 }, { label: 'Allowance', width: 0.22, align: 'right' }, { label: 'Payoff', width: 0.22, align: 'right' }],
      d.trades.map((t) => [t.description, usd(t.allowanceCents), usd(t.payoffCents)]));
  }
  if (d.products.length) {
    w.heading('Protection products');
    w.table([{ label: 'Product', width: 0.76 }, { label: 'Price', width: 0.24, align: 'right' }], d.products.map((p) => [p.description, usd(p.priceCents)]));
  }
  w.heading('Totals');
  const t = d.totals;
  w.table([{ label: '', width: 0.7 }, { label: '', width: 0.3, align: 'right' }], [
    ['Sale price', usd(t.saleCents)], ['Fees', usd(t.feesCents)], ['Protection products', usd(t.productsCents)], ['Sales tax (estimate)', usd(t.taxCents)],
    ['Cash price', usd(t.cashPriceCents)], ['Less trade allowance', usd(-t.tradeAllowanceCents)], ['Plus trade payoff', usd(t.tradePayoffCents)],
    ['Less deposits', usd(-t.depositsCents)],
  ], [['Balance due', usd(t.balanceDueCents), true]]);
  w.text(c.settings.terms ?? 'Equipment is sold as described. Title passes on payment in full. Warranty coverage is the manufacturer\'s, as stated in its written warranty; the dealer makes no other warranty unless written here.', { muted: true });
  w.signatures([{ position: 1, role: 'Purchaser', name: d.customer.name }, { position: 2, role: 'Dealer', name: c.brand.companyName }]);
};

const drawRequest: Renderer<'draw_request'> = (w, d, c) => {
  w.kv([['Lender', party(d.lender)], ['Borrower', c.brand.companyName], [c.vocab.job, d.jobName], ['Loan no.', d.loanNumber ?? '-'],
        ['Draw no.', d.drawNo == null ? '-' : String(d.drawNo)], ['Period to', fmtDate(d.periodEnd)]]);
  if (d.lines?.length) { w.heading('Costs this draw'); lineTable(w, d.lines, true, []); }
  w.heading('Request');
  w.table([{ label: '', width: 0.7 }, { label: '', width: 0.3, align: 'right' }], [
    ['Amount requested', usd(d.requestedCents)], ['Retainage held', usd(d.retainageHeldCents ?? null)], ['Equity applied', usd(d.equityAppliedCents ?? null)],
  ]);
  if (d.notes) w.text(d.notes);
  w.text('The borrower certifies that the costs above were incurred for the project, that the work is in place as represented, and that no default exists under the loan.', { muted: true });
  w.signatures([{ position: 1, role: 'Borrower', name: c.brand.companyName }, { position: 2, role: 'Lender approval', name: d.lender.name }]);
};

const WAIVER_TITLE: Record<LienWaiverData['waiverType'], string> = {
  conditional_progress: 'Conditional waiver and release on progress payment',
  unconditional_progress: 'Unconditional waiver and release on progress payment',
  conditional_final: 'Conditional waiver and release on final payment',
  unconditional_final: 'Unconditional waiver and release on final payment',
};

const lienWaiver: Renderer<'lien_waiver'> = (w, d) => {
  w.text(WAIVER_TITLE[d.waiverType].toUpperCase(), { bold: true, size: 11 });
  w.kv([['Claimant', party(d.claimant)], ['Customer', party(d.customer)], ['Job', d.jobName], ['Job location', d.jobAddress ?? '-'],
        ['Through date', fmtDate(d.throughDate)], ['Amount', usd(d.amountCents)]]);
  const conditional = d.waiverType.startsWith('conditional');
  const final = d.waiverType.endsWith('final');
  w.heading('Waiver and release');
  w.text(conditional
    ? `This document waives and releases lien, stop payment notice and payment bond rights the claimant has for labor and service provided, and equipment and material delivered, to the customer on this job${final ? '' : ` through the through date`}. This waiver is effective only on the claimant's receipt of payment of ${usd(d.amountCents)}.`
    : `The claimant has been paid ${usd(d.amountCents)} and hereby waives and releases lien, stop payment notice and payment bond rights for labor and service provided, and equipment and material delivered, to the customer on this job${final ? '' : ' through the through date'}.`);
  w.text(`Exceptions: ${d.exceptions?.trim() || 'none'}.`);
  if (!conditional) w.notice('Notice to claimant', 'This document waives and releases lien rights unconditionally and states that you have been paid for giving up those rights. It is prohibited to require you to sign this document if you have not been paid the amount stated. If you have not been paid, use a conditional release form.');
  w.signatures([{ position: 1, role: 'Claimant', name: d.claimant.name }]);
};

const RENDERERS: { [K in TemplateKey]: Renderer<K> } = {
  proposal, contract, change_order: changeOrder, pay_app_cover: payApp, work_order: workOrder, daily_report: dailyReport,
  install_ticket: installTicket, purchase_order: purchaseOrder, buyers_order: buyersOrder, draw_request: drawRequest, lien_waiver: lienWaiver,
};

export function templateTitle(key: TemplateKey, c: TemplateContext): string {
  if (c.settings.title) return c.settings.title;
  switch (key) {
    case 'proposal': return c.vocab.estimate === 'Estimate' ? 'Proposal' : c.vocab.estimate;
    case 'contract': return 'Contract';
    case 'change_order': return c.vocab.change_order;
    case 'pay_app_cover': return 'Application for payment';
    case 'work_order': return c.vocab.work_order;
    case 'daily_report': return c.vocab.daily_log;
    case 'install_ticket': return 'Install ticket';
    case 'purchase_order': return 'Purchase order';
    case 'buyers_order': return "Buyer's order";
    case 'draw_request': return 'Draw request';
    case 'lien_waiver': return 'Lien waiver';
  }
}

function subtitleOf<K extends TemplateKey>(key: K, d: TemplateDataMap[K]): string {
  const x = d as unknown as Record<string, unknown>;
  const num = typeof x.number === 'string' ? x.number : key === 'pay_app_cover' && x.applicationNo != null ? `No. ${String(x.applicationNo)}` : key === 'draw_request' && x.drawNo != null ? `Draw ${String(x.drawNo)}` : '';
  const date = typeof x.date === 'string' ? fmtDate(x.date) : '';
  return [num, date].filter(Boolean).join(' · ');
}

export async function renderTemplate<K extends TemplateKey>(key: K, data: TemplateDataMap[K], ctx: TemplateContext): Promise<RenderedDocument> {
  const title = templateTitle(key, ctx);
  const subtitle = subtitleOf(key, data);
  const w = await Writer.create({ ...ctx.brand, headerLines: ctx.settings.headerLines ?? ctx.brand.headerLines }, { title, subtitle });
  (RENDERERS[key] as Renderer<K>)(w, data, ctx);
  const bytes = await w.finish(ctx.settings.footer ?? `${ctx.brand.companyName} · ${title}${subtitle ? ` · ${subtitle}` : ''}`);
  const safe = `${title}${subtitle ? ` ${subtitle.split(' · ')[0]}` : ''}`.replace(/[^A-Za-z0-9 ._-]+/g, '').trim().slice(0, 80) || key;
  return { key, title, fileName: `${safe}.pdf`, bytes, pageCount: w.doc.getPageCount(), anchors: w.anchors };
}
