import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import { rpcLoad } from '@/lib/fieldservice/completion';
import type { FinancingRecon } from '@/lib/fieldservice/completion-types';
import { Cents, Day, Text, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Financing funding reconciliation (FS-97) and agreement auto-pay consent (FS-96). Amounts financed
 * need contract value, dealer fees / expected net need job financials — both stripped in the DB.
 * The lender receivable and dealer-fee posting stay in Books.
 */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: false, query: z.object({ companyId: Uuid, asOf: Day.optional() }) }, async ({ db, tenant, query }) => {
  assertCompany(tenant, query.companyId);
  const r = await rpcLoad<FinancingRecon>(db, 'fs_financing_recon', { p_location: query.companyId, p_as_of: query.asOf ?? null }, { rows: [], unfunded: 0, chase: 0, unfunded_cents: null });
  return { ...r.data, error: r.error };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), financedId: Uuid, status: z.enum(['APPLIED', 'APPROVED', 'DOCS_SIGNED', 'FUNDING_REQUESTED', 'FUNDED', 'SHORT_FUNDED', 'CANCELLED']),
             applicationRef: Text(80).nullish(), fundedCents: Cents.nullish(), fundedOn: Day.nullish(), note: Text(2000).nullish() }),
  z.object({ op: z.literal('autopay'), agreementId: Uuid, contactId: Uuid.nullish(), methodLabel: z.string().trim().min(1).max(60), consentedBy: z.string().trim().min(2).max(120),
             consentText: Text(1000).nullish() }),
  z.object({ op: z.literal('autopay_cancel'), enrollmentId: Uuid }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  switch (body.op) {
    case 'update':
      return fsCall(db, 'fs_update_financing', { p_financed: body.financedId, p_status: body.status, p_application_ref: body.applicationRef ?? null,
        p_funded_cents: body.fundedCents ?? null, p_funded_on: body.fundedOn ?? null, p_note: body.note ?? null });
    case 'autopay':
      return { id: await fsCall<string>(db, 'fs_request_autopay', { p_agreement: body.agreementId, p_contact: body.contactId ?? null, p_method_label: body.methodLabel,
        p_consented_by_name: body.consentedBy, p_consent_text: body.consentText ?? null }) };
    case 'autopay_cancel':
      return { id: await fsCall<string>(db, 'fs_cancel_autopay', { p_enrollment: body.enrollmentId, p_reason: null }) };
  }
});
