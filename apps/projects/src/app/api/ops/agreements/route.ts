import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { write } from '@/lib/pm/ops/rpc';
import { resolveJob } from '@/lib/pm/ops/jobs';
import { Cents, Day, Fraction, Need, NewJobZ, SkillCode, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z
  .object({
    jobId: Uuid.nullish(),
    newJob: NewJobZ.nullish(),
    customerId: Uuid,
    planName: Need(120, 'Name the plan'),
    tier: Text(60).nullish(),
    startsOn: Day,
    endsOn: Day,
    cadence: z.enum(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'CUSTOM']).default('SEMIANNUAL'),
    intervalMonths: z.number().int().min(1).max(60).nullish(),
    firstVisitOn: Day.nullish(),
    visitsPerTerm: z.number().int().min(0).max(120).nullish(),
    visitWindowDays: z.number().int().min(1).max(366).default(30),
    visitMinutes: z.number().int().min(1).max(1440).default(60),
    requiredSkills: z.array(SkillCode).max(12).default([]),
    priceCents: Cents.default(0),
    billingFrequency: z.enum(['UPFRONT', 'MONTHLY', 'QUARTERLY', 'ANNUAL']).default('ANNUAL'),
    memberDiscountPct: Fraction.nullish(),
    autoRenew: z.boolean().default(true),
    assetIds: z.array(Uuid).max(50).default([]),
  })
  .refine((b) => b.endsOn > b.startsOn, { message: 'The term ends before it starts', path: ['endsOn'] })
  .refine((b) => b.cadence !== 'CUSTOM' || !!b.intervalMonths, { message: 'A custom cadence needs the months between visits', path: ['intervalMonths'] })
  .refine((b) => !b.firstVisitOn || (b.firstVisitOn >= b.startsOn && b.firstVisitOn < b.endsOn), { message: 'The first visit must fall inside the term', path: ['firstVisitOn'] });

/** A draft agreement (membership). It is activated, billed and renewed through pm functions. */
export const POST = route({ access: { cap: 'projects.customers', action: 'create' }, mask: 'agreement', body: Body }, async ({ db, body, tenant }) => {
  const job = await resolveJob(db, tenant, body.jobId, body.newJob);
  const pm = db.schema('pm');
  const created = await write<Array<{ id: string; number: string | null }>>(
    pm.from('service_agreements').insert({
      location_id: job.location_id, job_id: job.job_id, customer_id: body.customerId, plan_name: body.planName, tier: body.tier || null,
      starts_on: body.startsOn, ends_on: body.endsOn, cadence: body.cadence, interval_months: body.intervalMonths ?? null,
      first_visit_on: body.firstVisitOn ?? null, visits_per_term: body.visitsPerTerm ?? null, visit_window_days: body.visitWindowDays,
      visit_minutes: body.visitMinutes, required_skills: body.requiredSkills, price_cents: body.priceCents, billing_frequency: body.billingFrequency,
      member_discount_pct: body.memberDiscountPct ?? null, auto_renew: body.autoRenew,
    }).select('id, number'),
    'create agreement',
  );
  const a = created[0];
  if (!a) throw new HttpError(500, 'The agreement was not created. Try again.', 'CREATE_FAILED');
  if (body.assetIds.length) {
    await write(pm.from('agreement_assets').insert(body.assetIds.map((id) => ({ agreement_id: a.id, asset_id: id }))).select('asset_id'), 'cover equipment');
  }
  return { agreementId: a.id, number: a.number };
});
