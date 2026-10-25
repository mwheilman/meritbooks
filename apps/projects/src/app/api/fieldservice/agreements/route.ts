import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { fsCall, fsOwn } from '@/lib/fieldservice/rpc';
import type { AgreementImportReport } from '@/lib/fieldservice/types';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const ImportRow = z.object({
  customer_id: Uuid.optional(),
  customer_name: z.string().trim().max(200).optional(),
  plan_name: z.string().trim().min(1).max(120),
  tier: z.string().trim().max(60).optional(),
  starts_on: Day,
  ends_on: Day,
  price_cents: z.string().regex(/^\d{1,12}$/).optional(),
  billing_frequency: z.enum(['UPFRONT', 'MONTHLY', 'QUARTERLY', 'ANNUAL']).optional(),
  visits_per_term: z.string().regex(/^\d{1,3}$/).optional(),
  visits_remaining: z.string().regex(/^\d{1,3}$/).optional(),
  deferred_cents: z.string().regex(/^\d{1,12}$/).optional(),
  external_ref: z.string().trim().max(80).optional(),
  revenue_policy: z.enum(['PER_VISIT', 'STRAIGHT_LINE']).optional(),
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('billing'), agreementId: Uuid, through: Day.nullish() }),
  z.object({ op: z.literal('billing_all'), companyId: Uuid, through: Day.nullish() }),
  z.object({ op: z.literal('recognize'), companyId: Uuid, through: Day.nullish() }),
  z.object({ op: z.literal('dunning'), companyId: Uuid }),
  z.object({ op: z.literal('book_visits'), workOrderIds: z.array(Uuid).min(1).max(200), serviceDay: Day, arrivalWindowId: Uuid, businessUnitId: Uuid, overrideReason: Text(300).nullish() }),
  z.object({ op: z.literal('import'), companyId: Uuid, jobTypeKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/), rows: z.array(ImportRow).min(1).max(20_000), dryRun: z.boolean().default(true), sourceSystem: z.enum(['FIELDEDGE', 'SIMPRO', 'SERVICETITAN', 'HOUSECALL_PRO', 'JOBBER', 'CSV']).default('CSV') }),
  z.object({ op: z.literal('from_template'), companyId: Uuid, templateId: Uuid, customerId: Uuid, siteId: Uuid.nullish(), startsOn: Day.nullish() }),
  z.object({ op: z.literal('renew'), agreementId: Uuid, priceCents: z.number().int().min(0).nullish() }),
]);

/**
 * Agreements end to end (FS-60–65): recurring billing requests to Books (existing JOB_BILLING
 * RECURRING seam), straight-line recognition facts, dunning read-back, bulk booking owed visits,
 * import with a reconciliation report, sell from a template, renew at the uplift price.
 * Each op is guarded again in its definer RPC.
 */
export const POST = route({ access: { cap: 'projects.customers', action: 'view' }, mask: ['agreement', 'billing'], body: Body }, async ({ db, body, tenant }) => {
  switch (body.op) {
    case 'billing': {
      const a = await fsOwn<{ id: string; location_id: string }>(db, 'service_agreements', 'id, location_id', body.agreementId, 'That agreement was not found.');
      assertCompany(tenant, a.location_id);
      return { requested: await fsCall<number>(db, 'fs_generate_agreement_billing', { p_agreement: a.id, p_through: body.through ?? null }) };
    }
    case 'billing_all': {
      assertCompany(tenant, body.companyId);
      const list = await db.schema('pm').from('service_agreements').select('id').eq('location_id', body.companyId).in('status', ['ACTIVE', 'SUSPENDED']).limit(5000);
      if (list.error) throw new HttpError(500, 'The agreements did not load.', 'LOAD_FAILED');
      let n = 0;
      const failed: string[] = [];
      for (const a of (list.data ?? []) as Array<{ id: string }>) {
        try {
          n += await fsCall<number>(db, 'fs_generate_agreement_billing', { p_agreement: a.id, p_through: body.through ?? null });
        } catch (e) {
          if (e instanceof HttpError && e.status === 403) throw e;
          failed.push(a.id);
        }
      }
      return { requested: n, failed: failed.length };
    }
    case 'recognize':
      assertCompany(tenant, body.companyId);
      return { facts: await fsCall<number>(db, 'fs_recognize_straight_line', { p_location: body.companyId, p_through: body.through ?? null }) };
    case 'dunning':
      assertCompany(tenant, body.companyId);
      return { result: await fsCall<{ paid: number; failed: number; suspended: number }>(db, 'fs_run_dunning', { p_location: body.companyId }) };
    case 'book_visits': {
      const r = await fsCall<{ booked: unknown[]; failed: Array<{ number: string; error: string }> }>(db, 'fs_bulk_book_visits', {
        p_wo_ids: body.workOrderIds, p_service_day: body.serviceDay, p_arrival_window: body.arrivalWindowId, p_business_unit: body.businessUnitId,
        p_override_reason: body.overrideReason || null,
      });
      return { booked: r.booked.length, failed: r.failed };
    }
    case 'import': {
      assertCompany(tenant, body.companyId);
      const report = await fsCall<AgreementImportReport>(db, 'fs_import_agreements', {
        p_location: body.companyId, p_job_type_key: body.jobTypeKey, p_rows: body.rows, p_dry_run: body.dryRun, p_source_system: body.sourceSystem,
      });
      return { report: { ...report, location_id: body.companyId } };
    }
    case 'from_template': {
      assertCompany(tenant, body.companyId);
      const id = await fsCall<string>(db, 'fs_create_agreement_from_template', {
        p_template: body.templateId, p_customer: body.customerId, p_location: body.companyId, p_job: null, p_starts_on: body.startsOn ?? null, p_site: body.siteId ?? null,
      });
      return { agreementId: id };
    }
    case 'renew': {
      const a = await fsOwn<{ id: string; location_id: string }>(db, 'service_agreements', 'id, location_id', body.agreementId, 'That agreement was not found.');
      assertCompany(tenant, a.location_id);
      return { agreementId: await fsCall<string>(db, 'renew_agreement', { p_agreement: a.id, p_price_cents: body.priceCents ?? null }) };
    }
  }
});
