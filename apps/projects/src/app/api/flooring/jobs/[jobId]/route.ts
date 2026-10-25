export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { MEASURE_SOURCES, parseMeasureFile } from '@/lib/flooring/measure-import';
import { IsoDate, Pct, Req, Text, Uuid } from '@/lib/dealer/schemas';

const SITE_CHECKS = ['MOISTURE', 'OLD_FLOOR_REMOVED', 'FURNITURE_MOVED', 'HVAC_RUNNING', 'SUBFLOOR_FLAT', 'OTHER'] as const;

/**
 * A flooring job in one read: the job's tax / price settings, its measures and areas, the quote
 * lines the builder made, readiness (deposit, material, lots, site checks), lot mix, cut tickets,
 * and install bookings.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['estimate', 'billing'] }, async ({ db, params }) => {
  const job = params.jobId!;
  const pm = db.schema('pm');
  const measures = await xrows<{ id: string; source: string; measured_on: string; created_at: string }>(pm.from('measures').select('id, source, measured_on, created_at').eq('job_id', job).order('created_at', { ascending: false }).limit(20), 'measures');
  const [settings, areas, quoteLines, readiness, lots, tickets, bookings] = await Promise.all([
    pm.from('flr_job_settings').select('tax_mode, exemption_ref, exemption_expires_on, price_level, deposit_pct, required_site_checks').eq('job_id', job).maybeSingle().then((r) => r.data),
    measures.length ? xrows<Record<string, unknown>>(pm.from('measure_areas').select('id, measure_id, room_name, area_kind, product_category, sqft, linear_ft, each_count, waste_pct').eq('measure_id', measures[0]!.id).order('sort'), 'areas') : Promise.resolve([]),
    xrows<Record<string, unknown>>(pm.from('flr_quote_lines').select('id, estimate_id, estimate_line_id, area_id, room, line_class, tax_class, tier, product_id, labor_code, measured_qty, uom, waste_pct').in('estimate_id', (await xrows<{ id: string }>(pm.from('v_estimates_masked').select('id').eq('job_id', job), 'estimates')).map((e) => e.id).concat(['00000000-0000-0000-0000-000000000000'])), 'quote lines'),
    xcall<Record<string, unknown>>(db, 'flr_job_readiness', { p_job: job }),
    xcall<Record<string, unknown>>(db, 'flr_lot_check', { p_job: job }),
    xrows<Record<string, unknown>>(pm.from('flr_cut_tickets').select('id, number, status, due_on, warnings, created_at').eq('job_id', job).order('created_at', { ascending: false }), 'cut tickets'),
    xrows<Record<string, unknown>>(pm.from('flr_install_bookings').select('id, crew_id, install_on, days, sf, status, readiness_override_reason, capacity_override_reason, notes').eq('job_id', job).order('install_on'), 'bookings'),
  ]);
  const cuts = tickets.length
    ? await xrows<Record<string, unknown>>(pm.from('flr_cuts').select('id, ticket_id, roll_id, seq, room, planned_len_in, actual_len_in, status, cut_at').in('ticket_id', tickets.map((t) => t.id as string)).order('seq'), 'cuts')
    : [];
  return { settings, measures, areas, quoteLines, readiness, lots, tickets, cuts, bookings };
});

const Choice = z.object({ area_id: Uuid, product_id: Uuid, pad_product_id: Uuid.nullish(), tier: z.enum(['GOOD', 'BETTER', 'BEST']).nullish(), prep: z.boolean().default(false), demo: z.boolean().default(false), moving: z.boolean().default(false) });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('import_measure'), source: z.enum(MEASURE_SOURCES), fileName: Req(200, 'The file name'), text: z.string().min(1).max(5_000_000) }),
  z.object({ op: z.literal('settings'), taxMode: z.enum(['RETAIL', 'REAL_PROPERTY', 'EXEMPT']), priceLevel: z.enum(['RETAIL', 'BUILDER', 'CONTRACT']).default('RETAIL'), exemptionRef: Text(60).nullish(), exemptionExpiresOn: IsoDate.nullish(), depositPct: Pct.nullish(), requiredSiteChecks: z.array(z.enum(SITE_CHECKS)).max(6).nullish() }),
  z.object({ op: z.literal('build_quote'), measureId: Uuid, choices: z.array(Choice).min(1).max(500), estimateId: Uuid.nullish(), title: Text(200).nullish() }),
  z.object({ op: z.literal('site_check'), check: z.enum(SITE_CHECKS), passed: z.boolean(), reading: z.number().min(-1e6).max(1e6).nullish(), notes: Text(1000).nullish(), photoIds: z.array(Uuid).max(20).default([]) }),
  z.object({ op: z.literal('cut_ticket'), cuts: z.array(z.object({ roll_id: Uuid, room: Text(120).nullish(), length_in: z.number().positive().max(100_000) })).min(1).max(100), dueOn: IsoDate.nullish() }),
  z.object({ op: z.literal('book_install'), installOn: IsoDate, sf: z.number().min(0).max(1e7), days: z.number().int().min(1).max(60).default(1), crewId: Uuid.nullish(), overrideReason: Text(500).nullish(), notes: Text(1000).nullish() }),
]);

export const POST = route({
  access: { cap: 'projects.jobs', action: 'view' },
  ops: {
    import_measure: { cap: 'projects.estimates', action: 'edit' }, settings: { cap: 'projects.estimates', action: 'edit' }, build_quote: { cap: 'projects.estimates', action: 'edit' },
    book_install: { cap: 'projects.dispatch', action: 'edit' },
  },
  mask: ['estimate', 'billing'],
  body: Op,
}, async ({ db, params, body }) => {
  const job = params.jobId!;
  switch (body.op) {
    case 'import_measure': {
      const parsed = parseMeasureFile(body.text, body.source);
      if (!parsed.rooms.length) throw new HttpError(422, parsed.issues[0]?.message ?? 'No rooms were found in that file.', 'VALIDATION');
      const r = await xcall<Record<string, unknown>>(db, 'flr_import_measure', { p_job: job, p_source: body.source === 'GENERIC' ? 'IMPORT' : body.source, p_rooms: parsed.rooms, p_source_ref: body.fileName });
      return { ...r, totals: parsed.totals, issues: parsed.issues };
    }
    case 'settings':
      return { id: await xcall<string>(db, 'flr_set_job_settings', { p_job: job, p_tax_mode: body.taxMode, p_price_level: body.priceLevel, p_exemption_ref: body.exemptionRef ?? null, p_exemption_expires_on: body.exemptionExpiresOn ?? null, p_deposit_pct: body.depositPct ?? null, p_required_site_checks: body.requiredSiteChecks ?? null }) };
    case 'build_quote':
      return xcall(db, 'flr_build_quote', { p_job: job, p_measure: body.measureId, p_choices: body.choices, p_estimate: body.estimateId ?? null, p_title: body.title ?? null });
    case 'site_check':
      return { id: await xcall<string>(db, 'flr_record_site_check', { p_job: job, p_check: body.check, p_passed: body.passed, p_reading: body.reading ?? null, p_notes: body.notes ?? null, p_photos: body.photoIds }) };
    case 'cut_ticket':
      return xcall(db, 'flr_create_cut_ticket', { p_job: job, p_cuts: body.cuts, p_due_on: body.dueOn ?? null });
    case 'book_install':
      return xcall(db, 'flr_book_install', { p_job: job, p_install_on: body.installOn, p_sf: body.sf, p_days: body.days, p_crew: body.crewId ?? null, p_override_reason: body.overrideReason || null, p_notes: body.notes ?? null });
  }
});
