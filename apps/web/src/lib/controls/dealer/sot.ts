/**
 * DL-1 — Sold out of trust (FPB §6, AC 6). Reuses D1's read model
 * (`loadSotFindings` → pure `detectSoldOutOfTrust`): a live floor-plan note on a unit
 * that is sold by ANY signal (Books sale, dealer-system deal, manufacturer warranty
 * registration, lender audit). Severity comes from the finding (CRITICAL past payoff
 * due + grace or sale not in Books; HIGH payoff pending). Paying the note off makes it
 * non-live → the finding disappears → the open exception is EXPIRED.
 */

import type { SotFinding } from '@/lib/dealer/engine/sot';
import { loadSotFindings } from '@/lib/dealer/service/insights';
import { SOLD_DETECTED_BY } from '@/lib/dealer/ui/labels';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { dateLabel } from '@/lib/dealer/ui/format';
import { DEALER_FEATURES, money, plural, type ClientScan, type DealerDetectorDef, type DealerFinding } from './shared';

export function sotExceptions(findings: SotFinding[]): DealerFinding[] {
  return findings.map((f) => {
    const evidence = f.evidence
      .map((e) => `${SOLD_DETECTED_BY[e.source] ?? 'Sale signal'} on ${dateLabel(e.date)}${e.ref ? ` (${e.ref})` : ''}`)
      .join('; ');
    const days = Math.max(0, f.daysSinceSale);
    const critical = f.severity === 'CRITICAL';
    const title = critical
      ? `Sold out of trust: serial ${f.serialNumber} · ${money(f.principalCents)} unpaid ${plural(days, 'day')}`
      : `Floor-plan payoff pending: serial ${f.serialNumber} · ${money(f.principalCents)} due ${dateLabel(f.payoffDueDate)}`;
    const reason = f.saleMissingInBooks
      ? `This unit shows as sold (${evidence}) but the sale is not recorded in Books, and the floor-plan note still owes ${money(f.principalCents)}. The lender treats it as sold from ${dateLabel(f.earliestSaleDate)}.`
      : critical
        ? `The unit was sold on ${dateLabel(f.earliestSaleDate)} and the payoff of ${money(f.principalCents)} was due ${dateLabel(f.payoffDueDate)} — ${plural(f.daysPastDue, 'day')} ago, past the grace period. Evidence: ${evidence}.`
        : `The unit was sold on ${dateLabel(f.earliestSaleDate)}; the ${money(f.principalCents)} payoff is due ${dateLabel(f.payoffDueDate)}. Evidence: ${evidence}.`;
    const question = f.saleMissingInBooks
      ? 'Record the sale in Books, then release the floor-plan payoff — the lender already treats this unit as sold.'
      : 'Release the floor-plan payoff for this unit (a second person approves the release).';
    return {
      control: 'DL-1',
      kind: f.saleMissingInBooks ? 'sale_not_recorded' : critical ? 'payoff_past_due' : 'payoff_pending',
      dedupKey: f.dedupKey,
      severity: f.severity,
      amountAtRiskCents: f.principalCents,
      title,
      reason,
      question,
      href: dealerLinks.note(f.noteId),
      subjects: { note_id: f.noteId, unit_id: f.unitId, line_id: f.lineId },
      subjectTable: 'floor_plan_notes',
      subjectId: f.noteId,
      facts: {
        serial_number: f.serialNumber,
        detected_by: f.detectedBy,
        sale_missing_in_books: f.saleMissingInBooks,
        earliest_sale_date: f.earliestSaleDate,
        payoff_due_date: f.payoffDueDate,
        days_past_due: f.daysPastDue,
      },
    };
  });
}

export const SOT_DETECTOR: DealerDetectorDef = {
  key: 'dealer_sot',
  feature: DEALER_FEATURES.SOT,
  control: 'DL-1',
  label: 'Sold out of trust',
  collect: async (c: ClientScan) => sotExceptions(await loadSotFindings({ db: c.db, orgId: c.orgId, locationId: c.locationId }, c.asOf)),
};
