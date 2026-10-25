import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeWipJob } from '../../../../../web/src/lib/jobcost/wip';
import { ADAPTERS, recipeFor } from '../adapters';
import { aiAssistMapping, validateAiAnswer } from '../ai-hook';
import { buildPreview, firstPass, isFailure, readUpload, stagePayload } from '../engine';
import { ENTITY_DEFS } from '../fields';
import { mapColumns } from '../mapping';
import { convertCell, normalizeRecords, parsePercent } from '../normalize';
import {
  buildAgreementHandoff, buildDealerUnitsHandoff, buildJobWipHandoff, buildOpenArHandoff, computeWipLine, toCsv, type CommittedRow,
} from '../opening';
import { agreementReconciliation, unitByUnit, unitSummary, wipPreview } from '../reports';
import { IMPORT_ENTITIES, SOURCE_SYSTEMS, type StagedRow } from '../types';
import { FIXTURES, inflate, JOB_TYPES, makeXlsx, preview, table } from './helpers';

const SQL = fs.readFileSync(path.resolve(__dirname, '../../../../../../packages/supabase/migrations/1121_pm_imports_onboarding.sql'), 'utf8');
const listIn = (constraint: string) => {
  const m = new RegExp(`constraint ${constraint} check \\([a-z_]+ in \\(([^)]*)\\)`, 's').exec(SQL);
  return (m?.[1] ?? '').split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
};

describe('contract with migration 1121', () => {
  it('source systems and entities equal the SQL CHECK lists', () => {
    expect([...SOURCE_SYSTEMS].sort()).toEqual(listIn('import_batches_source_chk').sort());
    expect([...IMPORT_ENTITIES].sort()).toEqual(listIn('import_batches_entity_chk').sort());
  });
  it('every entity has a disposition and SQL agrees on it', () => {
    for (const e of IMPORT_ENTITIES) {
      const d = ENTITY_DEFS[e].disposition;
      expect(['RECORD', 'ROSTER', 'FACT', 'REFERENCE']).toContain(d);
      const line = SQL.split('\n').find((l) => l.includes(`then '${d}'`) && l.includes(`'${e}'`));
      const block = SQL.slice(SQL.indexOf('create or replace function pm.import_entity_disposition'), SQL.indexOf('create or replace function pm._import_txt'));
      const re = new RegExp(`when p_entity (?:= '${e}'|in \\([^)]*'${e}'[^)]*\\)) then '${d}'`, 's');
      expect(re.test(block) || Boolean(line), `${e} → ${d}`).toBe(true);
    }
  });
});

describe('adapters: every recipe, its fixture, detection and mapping', () => {
  const all = ADAPTERS.flatMap((a) => a.entities.map((e) => ({ a, e })));
  it('covers the sources the panel asks for', () => {
    expect(ADAPTERS.map((a) => a.id)).toEqual(['BUILDERTREND', 'JOBTREAD', 'COCONSTRUCT', 'SERVICETITAN', 'FIELDEDGE', 'SIMPRO', 'HOUSECALL_PRO', 'JOBBER', 'CSYSTEMS', 'PROCORE', 'EXCEL', 'QUICKBOOKS']);
    const ents = (id: string) => ADAPTERS.find((a) => a.id === id)!.entities.map((e) => e.entity);
    for (const id of ['BUILDERTREND']) expect(ents(id)).toEqual(expect.arrayContaining(['customer', 'cost_item', 'job', 'budget', 'commitment', 'selection', 'change_order', 'file']));
    expect(ents('SERVICETITAN')).toEqual(expect.arrayContaining(['customer', 'site', 'equipment', 'service_history', 'open_ar', 'agreement', 'cost_item', 'employee']));
    expect(ents('CSYSTEMS')).toEqual(expect.arrayContaining(['customer', 'unit', 'part', 'repair_order', 'special_order', 'warranty_claim', 'rental_unit', 'rental_contract', 'service_history']));
    expect(ents('PROCORE')).toEqual(expect.arrayContaining(['job', 'sov_line', 'commitment', 'budget']));
    expect(ents('QUICKBOOKS')).toEqual(expect.arrayContaining(['customer', 'vendor', 'cost_item', 'job']));
    for (const id of ['FIELDEDGE', 'SIMPRO', 'HOUSECALL_PRO', 'JOBBER']) expect(ents(id)).toEqual(expect.arrayContaining(['customer', 'agreement', 'cost_item', 'employee']));
  });
  it.each(all.map(({ a, e }) => [a.id, e.entity, e.fixture] as const))('%s %s (%s)', (source, entity, fixture) => {
    expect(fs.existsSync(path.join(FIXTURES, fixture)), 'fixture exists').toBe(true);
    const r = recipeFor(source, entity)!;
    const keys = new Set(ENTITY_DEFS[entity].fields.map((f) => f.key));
    for (const field of Object.values(r.columns)) expect(keys.has(field), `${fixture}: ${field}`).toBe(true);
    const p = preview(fixture);
    expect([p.source, p.entity]).toEqual([source, entity]);
    expect(p.detection.confidence).toBeGreaterThanOrEqual(0.6);
    for (const f of ENTITY_DEFS[entity].fields.filter((x) => x.required && x.key !== 'name' && x.key !== 'external_ref')) {
      expect(p.mapping[f.key], `${fixture}: required ${f.key} mapped`).toBeTruthy();
    }
    expect(p.unsure.length).toBeLessThanOrEqual(3);
    expect(p.unsure.filter((u) => u.required)).toEqual([]);
    expect(p.report.total).toBeGreaterThanOrEqual(3);
    expect(p.report.valid + p.report.warn).toBeGreaterThanOrEqual(2);
    // a recipe's own headers are adapter-confident
    for (const m of Object.values(p.mapping)) expect(m.confidence).toBeGreaterThanOrEqual(m.source === 'adapter' ? 0.97 : 0);
  });
  it('a vendor file and a customer file from QuickBooks are told apart', () => {
    expect(preview('quickbooks-vendors.csv').entity).toBe('vendor');
    expect(preview('quickbooks-customers.csv').entity).toBe('customer');
  });
});

describe('engine details', () => {
  it('finds the header row under a report title block (c-Systems)', () => {
    const t = table('csystems-units.csv');
    expect(t.headerRow).toBe(4);
    expect(t.headers[0]).toBe('Stock #');
    expect(t.rowCount).toBe(4);
  });
  it('reads the same file as .xlsx', () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, 'servicetitan-memberships.csv'), 'utf8');
    const grid = bytes.trim().split(/\r?\n/).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
    const x = readUpload('memberships.xlsx', null, makeXlsx(grid), inflate);
    if (isFailure(x)) throw new Error(x.message);
    const p = buildPreview(x, { fileHash: 'a'.repeat(64), jobTypes: JOB_TYPES });
    expect([p.source, p.entity]).toEqual(['SERVICETITAN', 'agreement']);
    expect(p.rows.map((r) => r.data.plan_name)).toEqual(['Comfort Club Gold', 'Comfort Club Silver', 'Commercial PM']);
  });
  it('a value guard keeps date columns out of % complete (Buildertrend "Projected Completion")', () => {
    const p = preview('buildertrend-jobs.csv');
    expect(p.mapping.pct_complete).toBeUndefined();
    expect(p.unmappedHeaders).toContain('Projected Completion');
  });
  it('the user’s choice beats the adapter, and null means "no column"', () => {
    const t = table('buildertrend-jobs.csv');
    const p = buildPreview(t, { fileHash: 'b'.repeat(64), jobTypes: JOB_TYPES, overrides: { billed_to_date_cents: null, contract_cents: 'Deposits Received' } });
    expect(p.mapping.billed_to_date_cents).toBeUndefined();
    expect(p.mapping.contract_cents).toEqual({ header: 'Deposits Received', confidence: 1, source: 'user' });
  });
  it('a saved mapping for the source re-applies', () => {
    const t = table('jobtread-jobs.csv');
    const saved = [{ source_system: 'JOBTREAD' as const, entity: 'job' as const, header_signature: 'x', mapping: { site_address: 'Location Name' } }];
    const p = buildPreview(t, { fileHash: 'c'.repeat(64), jobTypes: JOB_TYPES, saved });
    expect(p.mapping.site_address).toEqual({ header: 'Location Name', confidence: 1, source: 'saved' });
  });
  it('an unknown spreadsheet maps by generic names and lists the unsure columns (≤ 3)', () => {
    const csv = 'Client,Work,Amount Sold,Kickoff\nPat,Deck,"$9,000",3/1/2026\nLee,Fence,"$4,200",4/2/2026\n';
    const t = readUpload('my jobs.csv', 'text/csv', new TextEncoder().encode(csv), inflate);
    if (isFailure(t)) throw new Error(t.message);
    const p = buildPreview(t, { fileHash: 'd'.repeat(64), jobTypes: JOB_TYPES, entity: 'job' });
    expect(p.source).toBe('CSV');
    expect(p.mapping.customer_name?.header).toBe('Client');
    expect(p.unsure.length).toBeGreaterThan(0);
    expect(p.unsure.length).toBeLessThanOrEqual(3);
    expect(p.unsure[0]!.field).toBe('name');
  });
  it('job numbers stay unique, refs that restart per job are scoped to their job', () => {
    const co = preview('buildertrend-change-orders.csv');
    expect(co.rows.map((r) => r.external_ref)).toEqual(['BT-1043|CO-001', 'BT-1043|CO-002', 'BT-1044|CO-001']);
    expect(co.report.duplicates).toBe(0);
    const dup = 'Job Number,Job Name\n1,A\n1,B\n';
    const t = readUpload('x.csv', 'text/csv', new TextEncoder().encode(dup), inflate);
    if (isFailure(t)) throw new Error(t.message);
    const p = buildPreview(t, { fileHash: 'e'.repeat(64), jobTypes: JOB_TYPES, entity: 'job' });
    expect(p.rows[1]!.validation).toBe('INVALID');
    expect(p.rows[1]!.issues[0]!.message).toBe('Same as row 2');
  });
  it('open work only: finished jobs are not brought in unless asked', () => {
    expect(preview('buildertrend-jobs.csv').rows.find((r) => r.external_ref === 'BT-0990')!.validation).toBe('INVALID');
    expect(preview('buildertrend-jobs.csv', { openOnly: false }).rows.find((r) => r.external_ref === 'BT-0990')!.validation).not.toBe('INVALID');
  });
  it('typed cells: cents from text, ISO dates, percents, bad emails dropped with a warning', () => {
    const p = preview('excel-wip.csv');
    const j = p.rows[0]!.data;
    expect(j).toMatchObject({ original_contract_cents: 310_000_000, approved_co_cents: 4_500_000, contract_cents: 314_500_000, cost_to_date_cents: 139_000_000, start_date: '2026-01-05', last_pay_app_number: 5 });
    expect(parsePercent('45%')).toBe(0.45);
    expect(parsePercent('45')).toBe(0.45);
    expect(parsePercent('0.45')).toBe(0.45);
    const bt = preview('buildertrend-contacts.csv');
    expect(bt.rows[2]!.data.email).toBeUndefined();
    expect(bt.rows[2]!.validation).toBe('WARN');
    const f = ENTITY_DEFS.job.fields.find((x) => x.key === 'approved_co_cents')!;
    expect(convertCell('($24,000.00)', f)[0]).toBe(-2_400_000);
  });
  it('the staged payload is exactly the preview rows', () => {
    const p = preview('csystems-parts.csv');
    expect(stagePayload(p).map((r) => r.external_ref)).toEqual(['KUB-HH150-32094', 'EXM-103-4302', 'KUB-W9501-21202']);
  });
});

describe('AI-assisted mapping degrades to rules only (AI is paused)', () => {
  const csv = 'Patron,Work,Amount Sold\nPat,Deck,"$9,000"\n';
  const t = readUpload('x.csv', 'text/csv', new TextEncoder().encode(csv), inflate);
  if (isFailure(t)) throw new Error('bad');
  const fp = firstPass(t, { entity: 'job' });
  it('no runner → paused, nothing guessed, preview still builds', async () => {
    const r = await aiAssistMapping({ entity: 'job', unmappedHeaders: fp.unmappedHeaders, unmappedFields: fp.unmappedFields, records: t.records, runner: null });
    expect(r).toMatchObject({ outcome: 'paused', mapping: {} });
    const p = buildPreview(t, { fileHash: '1'.repeat(64), entity: 'job', jobTypes: JOB_TYPES, ai: r });
    expect(p.ai.outcome).toBe('paused');
    expect(p.rows).toHaveLength(1);
  });
  it('a runner that is unavailable or throws → paused', async () => {
    const unavailable = async () => ({ status: 'unavailable' as const, reason: 'provider' as const, message: 'AI assist is paused right now.', correlationId: null, modelRequested: 'm', modelUsed: null, tokens: { input: 0, output: 0 }, costCents: 0 });
    expect((await aiAssistMapping({ entity: 'job', unmappedHeaders: fp.unmappedHeaders, unmappedFields: fp.unmappedFields, records: t.records, runner: unavailable })).outcome).toBe('paused');
    const boom = async () => { throw new Error('x'); };
    expect((await aiAssistMapping({ entity: 'job', unmappedHeaders: fp.unmappedHeaders, unmappedFields: fp.unmappedFields, records: t.records, runner: boom })).outcome).toBe('paused');
  });
  it('a clean answer is validated against the closed header / field lists and lands as 0.6 guesses', async () => {
    const ok = async () => ({ status: 'ok' as const, input: { mappings: [{ header: 'Patron', field: 'customer_name' }, { header: 'Nope', field: 'name' }, { header: 'Work', field: 'not_a_field' }] }, message: null, correlationId: null, modelRequested: 'm', modelUsed: 'm', tokens: { input: 1, output: 1 }, costCents: 0 });
    const r = await aiAssistMapping({ entity: 'job', unmappedHeaders: fp.unmappedHeaders, unmappedFields: fp.unmappedFields, records: t.records, runner: ok });
    expect(r.outcome).toBe('used');
    expect(r.mapping).toEqual({ customer_name: { header: 'Patron', confidence: 0.6, source: 'ai' } });
    const p = buildPreview(t, { fileHash: '2'.repeat(64), entity: 'job', jobTypes: JOB_TYPES, ai: r });
    expect(p.unsure.map((u) => u.field)).toContain('customer_name');
    expect(validateAiAnswer({ mappings: [{ header: 'Work', field: 'name' }, { header: 'Work', field: 'job_type' }] }, ['Work'], ['name', 'job_type'])).toEqual({ name: { header: 'Work', confidence: 0.6, source: 'ai' } });
  });
});

describe('reconciliation reports', () => {
  it('FS-65 agreements: count, deferred dollars, visits owed, no-billing / no-visits', () => {
    const st = agreementReconciliation(preview('servicetitan-memberships.csv').rows, '2026-10-25', 150_000);
    expect(st).toMatchObject({ agreements: 3, deferredCents: 146_950, visitsOwed: 6, differenceCents: -3_050 });
    const fe = agreementReconciliation(preview('fieldedge-agreements.csv').rows, '2026-10-25');
    expect(fe.noBilling.map((x) => x.ref)).toEqual(['A-5503']);
    expect(fe.noVisits.map((x) => x.ref)).toEqual(['A-5503']);
    expect(fe.deferredCents).toBe(10_500);
  });
  it('DLR-81 units: cost, floor plan by lender, exceptions', () => {
    const u = unitSummary(preview('csystems-units.csv').rows);
    expect(u).toMatchObject({ units: 4, costCents: 6_418_000, flooredUnits: 3, floorCents: 5_249_600 });
    expect(u.byLender.map((l) => [l.lender, l.units])).toEqual([['Kubota Credit Corp', 2], ['Sheffield Financial', 1]]);
    expect(u.flooredWithoutLender).toEqual([]);
  });
  it('unit-by-unit tie-out statuses', () => {
    const t = unitByUnit(
      [{ serial_number: 'A1', cost_cents: 100_000, floor_balance_cents: 0, floor_lender: null }, { serial_number: 'B2', cost_cents: 200_000, floor_balance_cents: 150_000, floor_lender: 'Kubota Credit Corp' },
       { serial_number: 'C3', cost_cents: 300_000, floor_balance_cents: 300_000, floor_lender: 'Sheffield Financial' }, { serial_number: 'D4', cost_cents: 50_000, floor_balance_cents: 50_000, floor_lender: 'Kubota Credit' }],
      [{ serial_number: 'a1', cost_cents: 100_050, floor_cents: 0, lender: null }, { serial_number: 'B2', cost_cents: 210_000, floor_cents: 150_000, lender: 'Kubota Credit Corp' },
       { serial_number: 'D4', cost_cents: 50_000, floor_cents: 50_000, lender: 'Kubota Credit Corporation' }, { serial_number: 'Z9', cost_cents: 9, floor_cents: 0, lender: null }],
    );
    expect(Object.fromEntries(t.lines.map((l) => [l.serial, l.status]))).toEqual({ A1: 'ok', B2: 'cost_differs', C3: 'missing_in_books', D4: 'lender_differs', Z9: 'missing_in_import' });
    expect(t.tied).toBe(false);
  });
  it('WIP preview of the Excel template', () => {
    const w = wipPreview(preview('excel-wip.csv').rows);
    expect(w.jobs).toBe(2);
    expect(w.contractCents).toBe(400_500_000);
  });
});

const committed = (p: ReturnType<typeof preview>, ids: string[]): CommittedRow[] =>
  p.rows.filter((r) => r.validation !== 'INVALID').map((r: StagedRow, i) => ({ row_number: r.row_number, entity: p.entity, external_ref: r.external_ref, data: r.data, outcome: 'CREATED', target_id: ids[i] ?? null }));

describe('opening positions for Books', () => {
  it('computeWipLine is Books’ computeWipJob, cent for cent', () => {
    const cases = [
      { contract: 443_640_000, eac: 390_500_000, costToDate: 223_050_000, billed: 266_184_000, pctOverride: null },
      { contract: 295_600_000, eac: 261_000_000, costToDate: 51_230_000, billed: 59_120_000, pctOverride: null },
      { contract: 1_000_001, eac: 333_333, costToDate: 111_111, billed: 0, pctOverride: null },
      { contract: 86_450_00, eac: 60_000_00, costToDate: 70_000_00, billed: 43_225_00, pctOverride: null },
      { contract: 5_000_000, eac: 4_000_000, costToDate: 1_000_000, billed: 3_000_000, pctOverride: 0.62 },
      { contract: 5_000_000, eac: 0, costToDate: 1_000_000, billed: 3_000_000, pctOverride: null },
    ];
    for (const c of cases) {
      const ours = computeWipLine(c);
      const books = computeWipJob({ jobId: 'j', jobNumber: 'j', jobName: 'j', contractValueCents: c.contract, estimatedCostCents: c.eac, costsToDateCents: c.costToDate, billedToDateCents: c.billed, pctCompleteOverride: c.pctOverride });
      expect([ours.earnedRevenueCents, ours.overBillingCents, ours.underBillingCents, ours.pctComplete]).toEqual([books.earnedRevenueCents, books.overBillingCents, books.underBillingCents, books.pctComplete]);
    }
  });
  it('CGC-08 mid-stream: Procore prime contracts + SOV + commitments → JOB_WIP facts, Books ProposedJob[] and job-dimension lines', () => {
    const jobs = committed(preview('procore-prime-contracts.csv'), ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']);
    const sov = committed(preview('procore-sov.csv'), []);
    const cmt = committed(preview('procore-commitments.csv'), []);
    const h = buildJobWipHandoff({ asOf: '2026-09-30', jobs, sov, commitments: cmt });
    expect(h.facts).toHaveLength(3);
    const w = h.facts[0]!;
    expect(w).toMatchObject({ external_ref: '2026-014', original_contract_cents: 425_000_000, approved_co_cents: 18_640_000, revised_contract_cents: 443_640_000,
      billed_to_date_cents: 266_184_000, cost_to_date_cents: 223_050_000, estimated_cost_cents: 390_500_000, retainage_receivable_cents: 13_309_200 });
    expect(w.sov).toHaveLength(3);
    expect(w.retainage_payable_cents).toBe(3_502_500); // no column on the job row → Σ retainage held on its open commitments
    const books = computeWipJob({ jobId: 'j', jobNumber: 'j', jobName: 'j', contractValueCents: w.revised_contract_cents, estimatedCostCents: w.estimated_cost_cents, costsToDateCents: w.cost_to_date_cents, billedToDateCents: w.billed_to_date_cents });
    expect(w.earned_revenue_cents).toBe(books.earnedRevenueCents);
    expect(h.payload.totals.cost_to_date_cents).toBe(223_050_000 + 51_230_000 + 59_800_000);
    expect(h.payload.blockers).toEqual([]);
    const proposed = (h.payload.books_wip_jobs as { jobNumber: string; contractValueCents: number; costsToDateCents: number }[])[1]!;
    expect(proposed).toMatchObject({ jobNumber: '2026-019', contractValueCents: 295_600_000, costsToDateCents: 51_230_000 });
    const lines = h.payload.job_dimension_lines as { role: string; job_ref: string; debit_cents: number; credit_cents: number }[];
    expect(lines.filter((l) => l.job_ref === '2026-014').map((l) => l.role)).toEqual(['JOB_WIP', 'DEFERRED_REVENUE', 'RETAINAGE_RECEIVABLE', 'RETAINAGE_PAYABLE']);
    expect(h.payload.warnings.some((x) => /Schedule of values totals/.test(x.message))).toBe(false);
  });
  it('jobs with no EAC block the handoff (Books’ WIP gate)', () => {
    const jobs = committed(preview('jobtread-jobs.csv'), ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013']);
    jobs[0]!.data = { ...jobs[0]!.data, estimated_cost_cents: null };
    const h = buildJobWipHandoff({ asOf: '2026-09-30', jobs });
    expect(h.payload.blockers.map((b) => b.ref)).toEqual(['1201']);
  });
  it('dealer units → one Books OPENING file per lender', () => {
    const units = committed(preview('csystems-units.csv'), ['a1', 'a2', 'a3', 'a4']);
    const h = buildDealerUnitsHandoff('2026-10-24', units);
    expect(h.payload.totals).toMatchObject({ units: 4, cost_cents: 6_418_000, floor_cents: 5_249_600, floored_units: 3 });
    const files = h.payload.books_opening_files as { lender: string | null; rows: Record<string, string>[] }[];
    expect(files.map((f) => [f.lender, f.rows.length])).toEqual([['Kubota Credit Corp', 2], ['Sheffield Financial', 1], [null, 1]]);
    expect(files[0]!.rows[0]).toMatchObject({ serialNumber: 'KBT3100A55012', principalCents: '21480.00', unitCostCents: '21480.00', lenderInvoiceNumber: 'KCC-889120' });
    expect(toCsv(files[0]!.rows).split('\r\n')[0]).toContain('serialNumber,stockNumber');
  });
  it('agreements and open AR', () => {
    const ag = buildAgreementHandoff('2026-10-24', committed(preview('simpro-contracts.csv'), ['x', 'y', 'z']), 1_415_667);
    expect(ag.payload.totals).toEqual({ agreements: 3, deferred_cents: 1_415_667, visits_owed: 4 });
    expect(ag.payload.warnings).toEqual([]);
    const ar = buildOpenArHandoff('2026-10-24', committed(preview('servicetitan-open-ar.csv'), []));
    expect(ar.payload.totals).toMatchObject({ customers: 2, invoices: 3, open_ar_cents: 167_350 });
  });
});

describe('normalizeRecords contract', () => {
  it('every staged data key is a field of the entity (plus derived keys)', () => {
    const derived = new Set(['status_raw', 'job_type_key']);
    for (const a of ADAPTERS) for (const e of a.entities) {
      const p = preview(e.fixture);
      const keys = new Set(ENTITY_DEFS[e.entity].fields.map((f) => f.key));
      for (const r of p.rows) for (const k of Object.keys(r.data)) expect(keys.has(k) || derived.has(k), `${e.fixture}: ${k}`).toBe(true);
    }
  });
  it('mapColumns never maps one header to two fields', () => {
    for (const a of ADAPTERS) for (const e of a.entities) {
      const t = table(e.fixture);
      const m = mapColumns({ entity: e.entity, source: a.id, headers: t.headers });
      const headers = Object.values(m).map((x) => x.header);
      expect(new Set(headers).size, e.fixture).toBe(headers.length);
    }
  });
  it('rows are numbered as in the file', () => {
    const t = table('csystems-units.csv');
    const rows = normalizeRecords(t.records, t.rowNumbers, mapColumns({ entity: 'unit', source: 'CSYSTEMS', headers: t.headers }), { entity: 'unit', jobTypes: [], openOnly: true });
    expect(rows.map((r) => r.row_number)).toEqual([5, 6, 7, 8]);
  });
});
