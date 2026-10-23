/**
 * The month-end WIP run end to end through the I/O service (FPB-rev-rec-wip AC 2, 5, 6, 7):
 * schedule → propose → the close task blocks → approve posts reclass + adjustment + reversal
 * on the 1st → the schedule ties to the GL → re-propose is "up to date" → a stale proposal is
 * refused and replaced → dismissal needs a reason → no reversal without next month open.
 *
 * Driven against a small in-memory PostgREST-style fake (tables + the filters the service
 * uses, the gl_entries!inner join, and the migration-064 unique key on gl_entries).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dismissWipRun, loadWipSchedule, postWipRun, proposeWipRun, WipRunError } from './wip-run-service';
import { loadWipCloseSignals } from './wip-close-signal';
import { evaluateCloseGraph, MANUAL_TASK_KEYS, type CloseTaskKey } from '@/lib/close/orchestration';

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

const ORG = '11111111-1111-1111-1111-111111111111';
const LOC = '22222222-2222-2222-2222-222222222222';
const JOB = '33333333-3333-3333-3333-333333333333';

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function makeDb(db: Db): SupabaseClient {
  const table = (schema: string, name: string) => {
    const key = schema === 'core' ? `core.${name}` : name;
    db[key] ??= [];
    return db[key];
  };

  const from = (schema: string) => (name: string) => {
    const rows = table(schema, name);
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let payload: Row | Row[] | null = null;
    let selectCols = '*';
    let mode: 'many' | 'single' | 'maybe' = 'many';
    let range: [number, number] | null = null;
    let limitN: number | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const joined = (r: Row): Row => {
      if (name === 'gl_entry_lines' && selectCols.includes('gl_entries!inner')) {
        return { ...r, gl_entries: (db.gl_entries ?? []).find((e) => e.id === r.gl_entry_id) ?? null };
      }
      return r;
    };
    const get = (r: Row, col: string): unknown => {
      if (col.includes('.')) {
        const [rel, c] = col.split('.');
        const j = joined(r)[rel] as Row | null;
        return j ? j[c] : undefined;
      }
      return r[col];
    };
    const matches = (r: Row) => filters.every((f) => f(r));

    const exec = (): { data: unknown; error: { message: string } | null } => {
      if (op === 'insert') {
        const list: Row[] = (Array.isArray(payload) ? payload : [payload!]).map((p): Row => ({ id: uid(), ...p }));
        for (const r of list) {
          if (name === 'gl_entries') {
            if (rows.some((x) => x.org_id === r.org_id && x.source_ref && x.source_ref === r.source_ref && x.entry_type === r.entry_type)) {
              return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
            }
            r.entry_number = `JE-${rows.length + 1}`;
          }
          if (name === 'rev_rec_wip_runs' && r.status === 'PROPOSED'
            && rows.some((x) => x.status === 'PROPOSED' && x.location_id === r.location_id && x.period_key === r.period_key)) {
            return { data: null, error: { message: 'uq_rev_rec_wip_runs_one_proposed' } };
          }
          rows.push({ reversal_pending: false, proposed_at: new Date().toISOString(), ...r });
        }
        const out = rows.slice(rows.length - list.length);
        return { data: mode === 'many' ? out : out[0], error: null };
      }
      if (op === 'update') {
        const hit = rows.filter(matches);
        for (const r of hit) Object.assign(r, payload);
        return { data: mode === 'many' ? hit : hit[0] ?? null, error: null };
      }
      if (op === 'delete') {
        for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i])) rows.splice(i, 1);
        return { data: null, error: null };
      }
      let out = rows.filter(matches).map(joined);
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN != null) out = out.slice(0, limitN);
      if (mode === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'not single' } };
      if (mode === 'maybe') return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };

    const q = {
      select: (cols = '*') => { selectCols = cols; return q; },
      insert: (p: Row | Row[]) => { op = 'insert'; payload = p; return q; },
      upsert: (p: Row) => { op = 'insert'; payload = p; return q; },
      update: (p: Row) => { op = 'update'; payload = p; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => get(r, c) === v); return q; },
      neq: (c: string, v: unknown) => { filters.push((r) => get(r, c) !== v); return q; },
      gt: (c: string, v: number) => { filters.push((r) => Number(get(r, c)) > v); return q; },
      lte: (c: string, v: string) => { filters.push((r) => String(get(r, c)) <= v); return q; },
      gte: (c: string, v: string) => { filters.push((r) => String(get(r, c)) >= v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(get(r, c))); return q; },
      or: () => q,
      order: () => q,
      limit: (n: number) => { limitN = n; return q; },
      range: (a: number, b: number) => { range = [a, b]; return Promise.resolve(exec()); },
      single: () => { mode = 'single'; return Promise.resolve(exec()); },
      maybeSingle: () => { mode = 'maybe'; return Promise.resolve(exec()); },
      then: (res: (v: ReturnType<typeof exec>) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return q;
  };
  return { from: from('public'), schema: (s: string) => ({ from: from(s) }) } as unknown as SupabaseClient;
}

const acct = (id: string, number: string, type: string) => ({ id, org_id: ORG, account_number: number, name: `Acct ${number}`, account_type: type, account_sub_type: 'X', is_active: true });
const period = (y: number, m: number) => {
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { id: uid(), org_id: ORG, location_id: LOC, start_date: start, end_date: end, period_year: y, period_month: m, status: 'OPEN' };
};

let store: Db;
let db: SupabaseClient;
const job = () => store['core.jobs'][0];
const gl = () => store.gl_entries ?? [];

beforeEach(() => {
  seq = 100;
  store = {
    'core.locations': [{ id: LOC, org_id: ORG, name: 'Heartland Heating', short_code: 'HHC', rev_rec_method: 'PCT_COSTS_INCURRED', is_active: true }],
    'core.jobs': [{
      id: JOB, org_id: ORG, location_id: LOC, job_number: 'J-100', name: 'Clinic remodel', job_type: null, archetype: null,
      status: 'ACTIVE', rev_rec_method: null, rev_rec_method_override: null, revenue_account_id: 'R4100',
      contract_amount_cents: 10_000_000, estimated_cost_cents: 8_000_000, actual_cost_cents: 4_800_000,
      billed_to_date_cents: 5_000_000, retainage_held_cents: 250_000, pct_complete: null, revenue_recognized_cents: 0,
      service_start_date: null, service_end_date: null, total_milestones: null, completed_milestones: null,
    }],
    accounts: [acct('A1180', '1180', 'ASSET'), acct('L2410', '2410', 'LIABILITY'), acct('L2450', '2450', 'LIABILITY'), acct('C5250', '5250', 'COGS'), acct('R4100', '4100', 'REVENUE')],
    account_roles: [
      { org_id: ORG, role_key: 'UNBILLED_RECEIVABLE', account_id: 'A1180', location_id: null },
      { org_id: ORG, role_key: 'DEFERRED_REVENUE', account_id: 'L2410', location_id: null },
      { org_id: ORG, role_key: 'CONTRACT_LOSS_PROVISION', account_id: 'L2450', location_id: null },
      { org_id: ORG, role_key: 'CONTRACT_LOSS_EXPENSE', account_id: 'C5250', location_id: null },
    ],
    fiscal_periods: [period(2026, 10), period(2026, 11), period(2026, 12)],
    gl_entries: [{ id: 'INV1', org_id: ORG, entry_date: '2026-10-15', status: 'POSTED', source_module: 'INVOICE', entry_type: 'STANDARD', source_ref: null }],
    gl_entry_lines: [
      { id: uid(), org_id: ORG, gl_entry_id: 'INV1', account_id: 'A1100', location_id: LOC, job_id: JOB, debit_cents: 5_000_000, credit_cents: 0 },
      { id: uid(), org_id: ORG, gl_entry_id: 'INV1', account_id: 'L2410', location_id: LOC, job_id: JOB, debit_cents: 0, credit_cents: 5_000_000 },
    ],
  };
  db = makeDb(store);
});

const closeTask = async (periodKey: string) => {
  const signals = await loadWipCloseSignals(db, ORG, periodKey, [LOC]);
  const ev = evaluateCloseGraph({
    uncodedBankCents: 0, reconciliationBlockers: 0, arVarianceCents: 0, apVarianceCents: 0, blockingLeakageCents: 0, leakageItems: 0,
    openExceptions: 0, unpostedDraftCount: 0, billsOnHoldCount: 0, unappliedPaymentCount: 0, unappliedPaymentCents: 0, pendingApprovalCount: 0,
    wipAccrual: signals.get(LOC),
  }, new Set<CloseTaskKey>(MANUAL_TASK_KEYS));
  return ev.tasks.find((t) => t.key === 'wip_accrual_reviewed')!;
};

describe('month-end WIP run through the service', () => {
  it('schedule → propose → close blocks → approve posts 3 entries → ties → up to date → close passes', async () => {
    const s = await loadWipSchedule(db, ORG, { locationId: LOC, periodKey: '2026-10' });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatchObject({ earnedCents: 6_000_000, underCents: 1_000_000, retainageCents: 250_000 });
    expect(s.tieOut?.unbilled.differenceCents).toBe(1_000_000);
    expect(s.tieOut?.deferred).toMatchObject({ scheduleCents: 0, glJobsCents: 5_000_000, differenceCents: -5_000_000 });

    expect((await closeTask('2026-10')).status).toBe('blocked'); // not run yet

    const p = await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: 'user_1', source: 'MANUAL' });
    expect(p.outcome).toBe('proposed');
    expect(p.run).toMatchObject({ status: 'PROPOSED', revision: 1, underbilled_cents: 1_000_000 });
    expect(store.rev_rec_wip_run_lines).toHaveLength(1);
    const blocked = await closeTask('2026-10');
    expect(blocked.status).toBe('blocked');
    expect(blocked.reason).toMatch(/underbilled \$10,000\.00/);

    const res = await postWipRun(db, ORG, { runId: p.run!.id, approvedBy: 'user_2' });
    expect(res.run.status).toBe('POSTED');
    expect(res.reversalPending).toBe(false);
    const posted = gl().filter((e) => e.id !== 'INV1').map((e) => [e.source_module, e.entry_type, e.entry_date]);
    expect(posted).toEqual([
      ['REV_REC_WIP_RECLASS', 'ADJUSTING', '2026-10-31'],
      ['REV_REC_WIP', 'ADJUSTING', '2026-10-31'],
      ['REV_REC_WIP', 'REVERSING', '2026-11-01'],
    ]);

    const after = await loadWipSchedule(db, ORG, { locationId: LOC, periodKey: '2026-10' });
    expect(after.tieOut?.tied).toBe(true);
    expect(after.entries.adjustment).toEqual([]);
    expect((await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: null, source: 'MANUAL' })).outcome).toBe('up_to_date');
    expect((await closeTask('2026-10')).status).toBe('pass');

    // November starts from billings again (the reversal unwound October) and books the full position.
    job().actual_cost_cents = 5_600_000; // 70% → earned 70k, billed 50k → underbilled 20k
    const nov = await loadWipSchedule(db, ORG, { locationId: LOC, periodKey: '2026-11' });
    expect(nov.lines[0]).toMatchObject({ underCents: 2_000_000, adjUnbilledCents: 2_000_000, reclassRevenueCents: 0 });
    expect(nov.lines[0].fadeGainCents).toBe(0); // est. GP unchanged vs October's run
  });

  it('refuses a stale proposal and replaces it with a fresh one', async () => {
    const p = await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: null, source: 'SCHEDULER' });
    job().actual_cost_cents = 6_400_000; // a cost landed after the proposal
    await expect(postWipRun(db, ORG, { runId: p.run!.id, approvedBy: 'user_2' })).rejects.toMatchObject({ status: 409 });
    const runs = store.rev_rec_wip_runs;
    expect(runs.map((r) => [r.revision, r.status])).toEqual([[1, 'SUPERSEDED'], [2, 'PROPOSED']]);
    expect(gl().filter((e) => e.id !== 'INV1')).toHaveLength(0);
  });

  it('dismissal needs a reason and clears the close task', async () => {
    const p = await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: null, source: 'MANUAL' });
    await expect(dismissWipRun(db, ORG, { runId: p.run!.id, reason: ' no ', dismissedBy: 'u' })).rejects.toBeInstanceOf(WipRunError);
    const d = await dismissWipRun(db, ORG, { runId: p.run!.id, reason: 'Estimates being re-forecast', dismissedBy: 'u' });
    expect(d).toMatchObject({ status: 'DISMISSED', dismiss_reason: 'Estimates being re-forecast' });
    expect((await closeTask('2026-10')).status).toBe('pass');
  });

  it('will not post a self-reversing entry when next month is not open', async () => {
    store.fiscal_periods = store.fiscal_periods.filter((f) => f.period_month !== 11);
    const p = await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: null, source: 'MANUAL' });
    await expect(postWipRun(db, ORG, { runId: p.run!.id, approvedBy: 'u' })).rejects.toMatchObject({ status: 409, code: 'NEXT_PERIOD_UNAVAILABLE' });
    expect(gl().filter((e) => e.id !== 'INV1')).toHaveLength(0);
  });

  it('a company with no jobs records nothing and the close task does not apply', async () => {
    store['core.jobs'] = [];
    store.gl_entry_lines = [];
    expect((await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: null, source: 'SCHEDULER' })).outcome).toBe('no_jobs');
    expect(store.rev_rec_wip_runs ?? []).toHaveLength(0);
    expect((await closeTask('2026-10')).status).toBe('pass');
  });

  it('two approvers at once: the run is claimed once, posted once, the other gets 409', async () => {
    const p = await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: 'user_1', source: 'MANUAL' });
    const results = await Promise.allSettled([
      postWipRun(db, ORG, { runId: p.run!.id, approvedBy: 'user_2' }),
      postWipRun(db, ORG, { runId: p.run!.id, approvedBy: 'user_3' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toMatchObject({ status: 409, code: 'NOT_PROPOSED' });
    expect(gl().filter((e) => e.id !== 'INV1')).toHaveLength(3); // reclass + adjustment + reversal, once
    expect(store.rev_rec_wip_runs.find((r) => r.id === p.run!.id)?.status).toBe('POSTED');
  });

  it('separation of duties: a refused approval claims nothing and posts nothing', async () => {
    const p = await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: 'user_1', source: 'MANUAL' });
    const sod = async () => ({ ok: false as const, status: 409, code: 'SOD_SELF_POST', error: 'You prepared this journal entry…' });
    await expect(postWipRun(db, ORG, { runId: p.run!.id, approvedBy: 'user_1', sod })).rejects.toMatchObject({ status: 409, code: 'SOD_SELF_POST' });
    expect(store.rev_rec_wip_runs.find((r) => r.id === p.run!.id)?.status).toBe('PROPOSED');
    expect(gl().filter((e) => e.id !== 'INV1')).toHaveLength(0);
    // the check receives the proposal (its proposer is the preparer)
    let seen: string | null = 'unset';
    await postWipRun(db, ORG, { runId: p.run!.id, approvedBy: 'user_2', sod: async (run) => { seen = run.requested_by; return { ok: true }; } });
    expect(seen).toBe('user_1');
  });

  it('a refusal before anything posts hands the claim back (PROPOSED); a claimed run cannot be dismissed', async () => {
    store.fiscal_periods = store.fiscal_periods.filter((f) => f.period_month !== 11);
    const p = await proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: null, source: 'MANUAL' });
    await expect(postWipRun(db, ORG, { runId: p.run!.id, approvedBy: 'u' })).rejects.toMatchObject({ code: 'NEXT_PERIOD_UNAVAILABLE' });
    expect(store.rev_rec_wip_runs.find((r) => r.id === p.run!.id)?.status).toBe('PROPOSED');

    // An approver's claim in flight: dismiss and a fresh proposal both refuse.
    store.rev_rec_wip_runs.find((r) => r.id === p.run!.id)!.status = 'POSTING';
    store.rev_rec_wip_runs.find((r) => r.id === p.run!.id)!.updated_at = new Date().toISOString();
    await expect(dismissWipRun(db, ORG, { runId: p.run!.id, reason: 'Not this month', dismissedBy: 'u' })).rejects.toMatchObject({ status: 409 });
    await expect(proposeWipRun(db, ORG, { locationId: LOC, periodKey: '2026-10', requestedBy: null, source: 'MANUAL' })).rejects.toMatchObject({ code: 'POSTING_IN_PROGRESS' });
  });
});
