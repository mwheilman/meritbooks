/**
 * Onboarding v2 part 1 — the services end-to-end on a REAL Postgres (PGlite replay of every
 * migration, incl. 193): staged source → 24 checks → facts/stage → the five ties read from the
 * posted GL AT THE CUTOVER → the balance proof → sign-off by a DIFFERENT person → go-live.
 *
 *   • ties read posted lines dated on/before the cutover only (a later entry never changes the proof);
 *   • a difference blocks the proof; the gate names it in dollars;
 *   • the preparer can't sign off their own proof (gate + DB CHECK); the named reviewer can;
 *   • sign-off hard-closes the months up to the cutover and archives the ledger source;
 *   • go-live is refused without a signed-off certificate; the stored stage follows the facts.
 *
 * serviceWriter() is pointed at the same PGlite client (the service role in production).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { monthRange, postEntry, seedReportTenant, type ReportTenant } from './report-engine-fixture';

let sbRef: SupabaseClient | null = null;
vi.mock('@/lib/db/scoped-writer', async (orig) => {
  const real = await orig<typeof import('@/lib/db/scoped-writer')>();
  return { ...real, serviceWriter: () => sbRef!, writerFor: () => sbRef! };
});

import { computeProjectTies, certificateView, goLive, signOff, signProof } from '@/lib/onboarding/migration/server/certificate';
import { gatherFacts, refreshProject } from '@/lib/onboarding/migration/server/projects';
import { buildPreflightInput, runAndStore, decideFinding } from '@/lib/onboarding/migration/server/preflight';
import { loadProject } from '@/lib/onboarding/migration/server/store';
import { MigrationError } from '@/lib/onboarding/migration/server/guard';

let db: PGlite;
let sb: SupabaseClient;
let t: ReportTenant;
let A = '';
let PROJ = '';
let SRC = '';

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function stage(entity: string, rows: Array<{ name: string; amount: number; payload: Record<string, unknown> }>): Promise<string> {
  const [run] = await q<{ id: string }>(
    `insert into public.migration_runs (org_id, location_id, project_id, source_id, run_kind, status, entity, parser, label, file_name, file_sha256)
     values ($1, $2, $3, $4, 'file_parse', 'staged', $5, 'generic test v1', $6, $7, $8) returning id`,
    [t.org, A, PROJ, SRC, entity, `${entity} fixture`, `${entity}.xlsx`, 'b'.repeat(64)],
  );
  for (const r of rows) {
    await q(
      `insert into public.staged_records (org_id, location_id, project_id, run_id, entity, display_name, amount_cents, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [t.org, A, PROJ, run.id, entity, r.name, r.amount, JSON.stringify(r.payload)],
    );
  }
  return run.id;
}

beforeAll(async () => {
  ({ db } = await createTestDb());
  sb = pgSupabase(db);
  sbRef = sb;
  t = await seedReportTenant(db, { slug: 'mig', companies: 2, months: monthRange('2026-01', 12) });
  A = t.companies[0];
  const [p] = await q<{ id: string }>(
    `insert into public.migration_projects (org_id, location_id, cutover_date, preparer_user_id, reviewer_user_id, systems_confirmed, lead_user_id)
     values ($1, $2, '2026-09-30', 'user_prep', 'user_rev', true, 'user_lead') returning id`,
    [t.org, A],
  );
  PROJ = p.id;
  const [s] = await q<{ id: string }>(
    `insert into public.migration_sources (org_id, location_id, project_id, system_id, role, tier, status)
     values ($1, $2, $3, 'spreadsheets', 'ledger_source', 'recipe', 'pulled') returning id`,
    [t.org, A, PROJ],
  );
  SRC = s.id;
  // Old books at Sep 30: cash 50,000.00 and 1,250.00 of equipment against owner's capital 51,250.00.
  await stage('tb_line', [
    { name: '1000 Operating Bank', amount: 5000000, payload: { number: '1000', name: 'Operating Bank', debitCents: 5000000, creditCents: 0, type: 'ASSET', sourceType: 'Bank', detailType: 'Checking' } },
    { name: '1500 Equipment', amount: 125000, payload: { number: '1500', name: 'Equipment', debitCents: 125000, creditCents: 0, type: 'ASSET' } },
    { name: '3000 Owner capital', amount: -5125000, payload: { number: '3000', name: "Owner's Capital", debitCents: 0, creditCents: 5125000, type: 'EQUITY' } },
  ]);
  await stage('bank_balance', [
    { name: 'Operating', amount: 5012000, payload: { label: 'Operating', glAccountNumber: '1000', statementBalanceCents: 5012000, statementDate: '2026-09-30', lastReconciledDate: '2026-09-30', unclearedTotalCents: -12000, unclearedCount: 1 } },
  ]);
  for (const [num, acct] of [['1000', t.acct.cash], ['1500', t.acct.fixed], ['3000', t.acct.capital]] as const) {
    await q(
      `insert into public.client_mappings (org_id, location_id, project_id, source_account_key, source_number, source_name, balance_cents, target_account_id, proposal_source, confidence, band, status, decided_by, decided_at)
       values ($1, $2, $3, $4, $4, $5, $6, $7, 'number', 0.99, 'ready', 'accepted', 'user_prep', now())`,
      [t.org, A, PROJ, num, num === '3000' ? "Owner's Capital" : num === '1500' ? 'Equipment' : 'Operating Bank', num === '1000' ? 5000000 : num === '1500' ? 125000 : -5125000, acct],
    );
  }
  // The historical-conversion session (the existing opening path) — staged then posted.
  const session = {
    kind: 'ONBOARDING_CONVERSION', companyId: A, companyShortCode: 'C0', asOfDate: '2026-09-30',
    sourceLines: [], mapping: {},
    openingBalances: [
      { targetAccountNumber: '1000', targetName: 'Operating Bank', debitCents: 5000000, creditCents: 0, sourceAccounts: ['1000'] },
      { targetAccountNumber: '1500', targetName: 'Equipment', debitCents: 125000, creditCents: 0, sourceAccounts: ['1500'] },
      { targetAccountNumber: '3000', targetName: "Owner's Capital", debitCents: 0, creditCents: 5125000, sourceAccounts: ['3000'] },
    ],
    balance: { balanced: true, totalDebitCents: 5125000, totalCreditCents: 5125000, differenceCents: 0 },
    balanceSheet: { assetsCents: 5125000, liabilitiesCents: 0, equityCents: 5125000, plNetCents: 0, identityDiffCents: 0, standalone: true, untyped: [] },
    unmapped: [], unknownTargets: [], sourceTotals: { debitCents: 5125000, creditCents: 5125000 },
    tiedOut: true, tiedOutBy: 'user_prep', tiedOutAt: '2026-10-01T00:00:00Z',
  };
  const opening = await postEntry(db, t, { location: A, date: '2026-09-30', lines: [
    { account: t.acct.cash, debit: 5000000 }, { account: t.acct.fixed, debit: 125000 }, { account: t.acct.capital, credit: 5125000 },
  ] });
  const [ai] = await q<{ id: string }>(
    `insert into public.ai_decisions (org_id, location_id, feature, input_summary, proposed_output, status, posted_gl_entry_id)
     values ($1, $2, 'CONVERSION_MAP', 'test', $3::jsonb, 'APPROVED', $4) returning id`,
    [t.org, A, JSON.stringify(session), opening],
  );
  await q(`update public.migration_projects set conversion_session_id = $1 where id = $2`, [ai.id, PROJ]);
  // Activity AFTER the cutover must never move the proof.
  await postEntry(db, t, { location: A, date: '2026-10-05', lines: [{ account: t.acct.cash, debit: 99900 }, { account: t.acct.revenue, credit: 99900 }] });
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('preflight input is built from what is staged', () => {
  it('merges the TB into accounts and carries the bank reconciliation', async () => {
    const p = await loadProject(sb, t.org, PROJ);
    const input = await buildPreflightInput(sb, t.org, p);
    expect(input.tbAvailable).toBe(true);
    expect(input.accounts.map((a) => [a.number, a.balanceCents])).toEqual([['1000', 5000000], ['1500', 125000], ['3000', -5125000]]);
    expect(input.bank).toEqual([{ label: 'Operating', glAccountNumber: '1000', statementBalanceCents: 5012000, lastReconciledDate: '2026-09-30', unclearedTotalCents: -12000, oldestUnclearedDate: null }]);
    expect(input.openInvoices).toBeNull();
  });

  it('runs and stores all 24 checks; the TB check passes', async () => {
    const p = await loadProject(sb, t.org, PROJ);
    const findings = await runAndStore(sb, t.org, p, 'user_prep');
    expect(findings).toHaveLength(24);
    expect(findings.find((f) => f.check_id === 'PF-07')!.severity).toBe('passed');
    // Decide every warning so the stage can move on.
    for (const f of findings.filter((x) => x.severity === 'warning' && x.disposition === 'open')) {
      await decideFinding(sb, t.org, p, 'user_prep', { checkId: f.check_id, disposition: 'accepted_with_note', note: 'Reviewed with the client; fine for cutover.' });
    }
    await expect(decideFinding(sb, t.org, p, 'user_prep', { checkId: 'PF-07', disposition: 'accepted_with_note', note: 'Nothing to decide here at all' })).rejects.toBeInstanceOf(MigrationError);
  });
});

describe('the five ties read the book AT the cutover', () => {
  it('everything ties; the October entry is ignored; the bank ties to the statement after outstanding items', async () => {
    const p = await loadProject(sb, t.org, PROJ);
    const r = await computeProjectTies(sb, t.org, p);
    const by = new Map(r.ties.map((x) => [x.key, x]));
    expect(by.get('tb')!.status).toBe('tied');
    expect(by.get('ar')!.status).toBe('not_applicable');
    expect(by.get('bank')).toMatchObject({ status: 'tied', evidence: 'evidenced' });
    expect(by.get('equity')).toMatchObject({ status: 'tied' });
  });

  it('the proof gate is open for the preparer, closed for the reviewer', async () => {
    const p = await loadProject(sb, t.org, PROJ);
    expect((await certificateView(sb, t.org, p, 'user_prep')).proof).toEqual({ ready: true, blockers: [] });
    expect((await certificateView(sb, t.org, p, 'user_rev')).proof.ready).toBe(false);
  });

  it('the stage machine is honest: a required recipe file still missing keeps the client in Connect systems', async () => {
    const p = await loadProject(sb, t.org, PROJ);
    const { facts } = await gatherFacts(sb, t.org, p, { withTies: true });
    expect(facts).toMatchObject({ sourcesPulled: 1, preflightRan: true, openBlockers: 0, undecidedWarnings: 0, balanceAccounts: 3, balanceAccountsMatched: 3, openingPosted: true, tieDifferences: 0 });
    expect(facts.filesMissing).toBeGreaterThan(0);
    const { project } = await refreshProject(sb, t.org, p, { withTies: true });
    expect(project.stage).toBe('connect');
    expect((project.blocker_summary as { next?: { label: string } }).next?.label).toMatch(/^Drop \d+ files?$/);
  });
});

describe('sign, sign off, go live', () => {
  it('a difference before the cutover blocks the proof, in dollars', async () => {
    const extra = await postEntry(db, t, { location: A, date: '2026-09-15', lines: [{ account: t.acct.cash, debit: 1570_00 }, { account: t.acct.capital, credit: 1570_00 }] });
    const p = await loadProject(sb, t.org, PROJ);
    const v = await certificateView(sb, t.org, p, 'user_prep');
    expect(v.proof.ready).toBe(false);
    expect(v.proof.blockers.join(' ')).toMatch(/\$1,570\.00/);
    await expect(signProof(sb, t.org, p, 'user_prep')).rejects.toBeInstanceOf(MigrationError);
    await q(`update public.gl_entries set status = 'VOIDED' where id = $1`, [extra]);
  });

  it('go-live is refused before sign-off', async () => {
    const p = await loadProject(sb, t.org, PROJ);
    await expect(goLive(sb, t.org, p, 'user_rev')).rejects.toThrow(/signed-off certificate/);
  });

  it('the preparer signs; the preparer cannot sign off; the reviewer signs off and the months lock', async () => {
    let p = await loadProject(sb, t.org, PROJ);
    const cert = await signProof(sb, t.org, p, 'user_prep');
    expect(cert).toMatchObject({ number: 'CC-0001', status: 'prepared', preparedBy: 'user_prep' });
    expect(cert.contentHash).toMatch(/^[0-9a-f]{64}$/);
    p = await loadProject(sb, t.org, PROJ);
    expect(p.stage).toBe('certified');
    expect(p.certificate_id).toBe(cert.id);

    const canClose = { canManageClose: async () => true };
    await expect(signOff(sb, t.org, p, 'user_prep', canClose)).rejects.toThrow(/someone else must sign off/);
    // Even straight at the database, the preparer can't be the approver.
    await expect(q(`update public.conversion_certificates set approved_by = 'user_prep', approved_at = now(), status = 'issued' where id = $1`, [cert.id])).rejects.toThrow(/conversion_certificates_values_chk/);

    // M4: sign-off locks months, so it needs close management too — refused, nothing issued.
    await expect(signOff(sb, t.org, p, 'user_rev', { canManageClose: async () => false })).rejects.toMatchObject({ code: 'CLOSE_PERMISSION' });
    // M4: a lock that fails fails the sign-off — the certificate stays prepared (no certificate issued).
    await expect(signOff(sb, t.org, p, 'user_rev', { ...canClose, setStatus: async () => { throw new Error('period lock refused'); } }))
      .rejects.toMatchObject({ code: 'LOCK_FAILED' });
    const still = await q<{ status: string }>(`select status from public.conversion_certificates where id = $1`, [cert.id]);
    expect(still[0].status).toBe('prepared');

    const r = await signOff(sb, t.org, p, 'user_rev', canClose);
    expect(r.certificate.status).toBe('issued');
    expect(r.periodsLocked).toBe(9);
    const open = await q<{ n: number }>(`select count(*)::int as n from public.fiscal_periods where location_id = $1 and end_date <= '2026-09-30' and status <> 'HARD_CLOSE'`, [A]);
    expect(open[0].n).toBe(0);
    const oct = await q<{ status: string }>(`select status::text from public.fiscal_periods where location_id = $1 and period_month = 10`, [A]);
    expect(oct[0].status).toBe('OPEN');
    // closed_by is a uuid column: never the Clerk id (the actor is in the event trail instead).
    const closers = await q<{ closed_by: string | null; reason: string | null }>(
      `select closed_by::text as closed_by, close_override_reason as reason from public.fiscal_periods where location_id = $1 and end_date <= '2026-09-30'`, [A]);
    expect(closers.every((c) => c.closed_by === null && /CC-0001/.test(c.reason ?? ''))).toBe(true);
    const src = await q<{ status: string }>(`select status from public.migration_sources where id = $1`, [SRC]);
    expect(src[0].status).toBe('archived');
  });

  it('then goes live; the trail recorded every step', async () => {
    const p = await loadProject(sb, t.org, PROJ);
    const next = await goLive(sb, t.org, p, 'user_rev');
    expect(next.stage).toBe('live');
    expect(next.live_at).not.toBeNull();
    const ev = await q<{ kind: string }>(`select kind from public.migration_events where project_id = $1 order by created_at`, [PROJ]);
    const kinds = ev.map((e) => e.kind);
    for (const k of ['preflight_run', 'finding_decided', 'proof_signed', 'certificate_issued', 'went_live']) expect(kinds).toContain(k);
  });
});
