export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { dwrite } from '@/lib/pm/dealer/rpc';
import { xrows } from '@/lib/dealer/rpc';
import { CompanyOnlyQ, IsoDate, PosCents, Req, Text, Uuid } from '@/lib/dealer/schemas';

/** OEM finance programs (promo rate, standard rate, cash rebate) and the store's standard fees. Masked views: subvention and fee cost are financials. */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'dealer_deal', query: CompanyOnlyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  const [programs, fees] = await Promise.all([
    xrows<Record<string, unknown>>(pm.from('v_dlr_finance_programs_masked').select('id, code, name, kind, brand, lender_vendor_id, apr, term_months, subvention_pct, rebate_cents, min_amount_cents, categories, model_pattern, starts_on, ends_on, claim_deadline_days, is_active').eq('location_id', query.company).order('is_active', { ascending: false }).order('ends_on', { ascending: true, nullsFirst: false }), 'programs'),
    xrows<Record<string, unknown>>(pm.from('v_dlr_fee_schedule_masked').select('id, code, label, kind, amount_cents, cost_cents, taxable, categories, auto_apply, is_active').eq('location_id', query.company).order('code'), 'fees'),
  ]);
  return { programs, fees };
});

const Program = z.object({
  code: Req(40, 'The program code'), name: Req(120, 'The name'), kind: z.enum(['PROMO_RATE', 'STANDARD_RATE', 'CASH_REBATE']), brand: Text(30).nullish(),
  apr: z.number().min(0).max(1), termMonths: z.number().int().min(1).max(120).nullish(), subventionPct: z.number().min(0).max(0.5).default(0),
  rebateCents: PosCents.default(0), minAmountCents: PosCents.default(0), modelPattern: Text(120).nullish(), startsOn: IsoDate.nullish(), endsOn: IsoDate.nullish(),
  claimDeadlineDays: z.number().int().min(0).max(365).nullish(), lenderVendorId: Uuid.nullish(),
});
const Fee = z.object({ code: z.string().regex(/^[A-Z0-9_]{2,24}$/, 'Codes are 2–24 capitals, digits or _'), label: Req(80, 'The label'), kind: z.enum(['DOC', 'SETUP', 'FREIGHT', 'PDI', 'ENVIRONMENTAL', 'OTHER']), amountCents: PosCents, costCents: PosCents.default(0), taxable: z.boolean().default(true), autoApply: z.boolean().default(true) });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_program'), companyId: Uuid, program: Program }),
  z.object({ op: z.literal('end_program'), programId: Uuid }),
  z.object({ op: z.literal('add_fee'), companyId: Uuid, fee: Fee }),
  z.object({ op: z.literal('end_fee'), feeId: Uuid }),
]);

export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, ops: { add_program: { cap: 'projects.financials', action: 'edit' }, add_fee: { cap: 'projects.financials', action: 'edit' } }, mask: 'dealer_deal', body: Op }, async ({ db, body, tenant }) => {
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_program': {
      assertCompany(tenant, body.companyId);
      const p = body.program;
      if (p.kind !== 'CASH_REBATE' && !p.termMonths) throw new HttpError(422, 'A rate program needs a term in months.', 'VALIDATION');
      const r = await dwrite<Array<{ id: string }>>(pm.from('dlr_finance_programs').insert({
        location_id: body.companyId, code: p.code, name: p.name, kind: p.kind, brand: p.brand ?? null, apr: p.apr, term_months: p.termMonths ?? null,
        subvention_pct: p.subventionPct, rebate_cents: p.rebateCents, min_amount_cents: p.minAmountCents, model_pattern: p.modelPattern ?? null,
        starts_on: p.startsOn ?? null, ends_on: p.endsOn ?? null, claim_deadline_days: p.claimDeadlineDays ?? null, lender_vendor_id: p.lenderVendorId ?? null,
      }).select('id'), 'add program');
      return { id: r[0]?.id ?? null };
    }
    case 'end_program':
      await dwrite(pm.from('dlr_finance_programs').update({ is_active: false }).eq('id', body.programId).select('id'), 'end program');
      return { ok: true };
    case 'add_fee': {
      assertCompany(tenant, body.companyId);
      const f = body.fee;
      const r = await dwrite<Array<{ id: string }>>(pm.from('dlr_fee_schedule').insert({ location_id: body.companyId, code: f.code, label: f.label, kind: f.kind, amount_cents: f.amountCents, cost_cents: f.costCents, taxable: f.taxable, auto_apply: f.autoApply }).select('id'), 'add fee');
      return { id: r[0]?.id ?? null };
    }
    case 'end_fee':
      await dwrite(pm.from('dlr_fee_schedule').update({ is_active: false }).eq('id', body.feeId).select('id'), 'end fee');
      return { ok: true };
  }
});
