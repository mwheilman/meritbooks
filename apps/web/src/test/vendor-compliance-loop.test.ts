/**
 * Migration 180 + lib/vendor-compliance — the W-9 / COI closed loop against a REAL
 * Postgres (PGlite migration replay with hosted Supabase's default grants).
 * FPB-vendor-compliance-chase §19.3.
 *
 *   locks     members read only their org's 180 rows and write none; anon reads nothing;
 *             the TIN ciphertext column is member-unreadable; the audit trail stays
 *             append-only
 *   loop      requirement set → pay-time hold naming the failed rule → portal COI upload
 *             read by (fake) AI and checked → reject re-requests quoting the reason →
 *             AI-down upload lands for manual keying → accept lifts the hold, fulfils
 *             the request, releases the held bill, logs DOC_ACCEPTED + HOLD_LIFTED
 *   W-9       fill-here form: TIN encrypted, last 4 only elsewhere, bad input refused
 *   VN-10     bank change blocks payment (override does not lift it); call-back with the
 *             request's number / by the maker refused; valid call-back clears it;
 *             a payment-profile change opens one by trigger
 *   portal    token scope (own vendor only; revoked → refused), view model
 *   chase     switch off → nothing; per-company switch on → requests for what the set
 *             needs (incl. a W-9 with no doc row) and a due-anchored renewal; the preview
 *             lists the same vendors
 *   legacy    a tenant with no requirement set keeps the doc-row hold
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { ComplianceHoldError, enforcePaymentAllowed, evaluateVendorCompliance, grantOverride } from '@/lib/services/vendor-compliance';
import { saveRequirementSet, setChaseSwitch, setVendorProfile, type RequirementInput } from '@/lib/vendor-compliance/admin';
import { acceptSubmission, recordSubmission, rejectSubmission, runAiCheck, ReviewError, MAX_AI_ATTEMPTS, type SubmissionRow } from '@/lib/vendor-compliance/review';
import { consumePortalAiRead, PORTAL_AI_READS_PER_DAY } from '@/lib/portal/vendor/ai-budget';
import { runVendorAiRecheckJob } from '@/lib/scheduler/jobs/vendor-compliance-recheck';
import type { JobContext } from '@/lib/scheduler/types';
import { submitW9Form, W9FormError } from '@/lib/vendor-compliance/w9-form';
import { openBankChange, verifyBankChange, BankChangeError } from '@/lib/vendor-compliance/bank-change';
import { buildPortalView } from '@/lib/vendor-compliance/portal';
import { buildDashboard, vendorTimeline } from '@/lib/vendor-compliance/dashboard';
import { createVendorDocRequest, planVendorChase, syncVendorComplianceRequests } from '@/lib/requests/vendor-compliance';
import { loadPolicyContext } from '@/lib/requests/policy';
import { validatePortalToken } from '@/lib/portal/vendor/tokens';
import type { ParseCoiResult, ProposedCoi } from '@/lib/vendors/coi-parse';
import type { W9FormBody } from '@/lib/validations/vendor-compliance';

const ORG_A = '18000000-0000-0000-0000-00000000000a';
const ORG_B = '18000000-0000-0000-0000-00000000000b';
const LOC_ART = '18000000-0000-0000-0000-0000000000c1';
const LOC_CLIVE = '18000000-0000-0000-0000-0000000000c2';
const LOC_B = '18000000-0000-0000-0000-0000000000c3';
const V_SUB = '18000000-0000-0000-0000-0000000000a1'; // Prairie Drywall — the loop
const V_NEW = '18000000-0000-0000-0000-0000000000a2'; // Cedar Electric — nothing on file (chase)
const V_RENEW = '18000000-0000-0000-0000-0000000000a3'; // Oak Roofing — renewal
const V_B = '18000000-0000-0000-0000-0000000000b1';
const TOKEN_SUB = 'tok_prairie_0123456789abcdefghijklmnopqrstuv';
const TOKEN_REVOKED = 'tok_revoked_0123456789abcdefghijklmnopqrstu';

const T0 = new Date('2026-10-23T15:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * 86_400_000);

let db: PGlite;
let svc: SupabaseClient;
let BILL = '';

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function as<T>(sub: string | null, org: string | null, fn: () => Promise<T>): Promise<T> {
  const claims = sub ? { sub, org_id: org, role: 'authenticated' } : {};
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${sub ? 'authenticated' : 'anon'}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function events(vendorId: string): Promise<string[]> {
  return (await db.query<{ event_type: string }>(`select event_type from public.vendor_compliance_events where vendor_id = $1 order by created_at, event_type`, [vendorId])).rows.map((r) => r.event_type);
}

function req(over: Partial<RequirementInput> = {}): RequirementInput {
  return {
    name: 'Artistry subcontractors',
    locationId: LOC_ART,
    vendorType: 'subcontractor',
    tax1099: 'any',
    workType: null,
    w9Required: true,
    coiRequired: true,
    minGlEachOccurrenceCents: 100_000_000,
    minGlAggregateCents: 200_000_000,
    minAutoCents: null,
    wcRequired: false,
    minWcEachAccidentCents: null,
    minUmbrellaCents: null,
    requireAdditionalInsured: true,
    requireWaiverOfSubrogation: false,
    certificateHolderName: 'Artistry Homes LLC',
    expiryLeadDays: 30,
    blockPayment: true,
    graceDays: 0,
    ...over,
  };
}

function fakeCoi(coi: Partial<ProposedCoi>): () => Promise<ParseCoiResult> {
  return async () => ({
    ok: true,
    model: 'test-model',
    correlationId: null,
    extractionMs: 1,
    documentNote: null,
    coi: { carrier: 'Acme Mutual', policy_number: 'GL-1', named_insured: 'Prairie Drywall', certificate_holder: null, additional_insured: null, waiver_of_subrogation: null, coverages: [], ...coi },
  });
}

const W9: W9FormBody = {
  legal_name: 'Prairie Drywall LLC',
  business_name: '',
  entity_type: 'LLC',
  llc_tax_class: 'P',
  exempt_payee_code: '',
  address_line1: '100 Grand Ave',
  address_line2: '',
  city: 'Des Moines',
  state: 'IA',
  zip: '50309',
  tin_type: 'EIN',
  tin: '42-1234567',
  tin_confirm: '421234567',
  signer_name: 'Pat Lee',
  signature: 'Pat Lee',
  certify: true,
  esign_consent: true,
};

async function insertDoc(sub: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.documents (org_id, storage_path, file_name, doc_type, entity_type, entity_id, notes) values ($1, $2, 'coi.pdf', 'COI', 'vendor', $3, 'Vendor portal submission · COI · pending review') returning id`,
    [ORG_A, `org/${sub}.pdf`, V_SUB],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  svc = pgSupabase(db);
  process.env.TIN_ENCRYPTION_KEY = 'b'.repeat(64);
  await db.exec(`
    insert into core.organizations (id, name, slug, timezone) values
      ('${ORG_A}', 'Merit Test Firm', 'merit-test', 'America/Chicago'),
      ('${ORG_B}', 'Tenant B', 'tenant-b-180', 'America/New_York');
    insert into core.locations (id, org_id, name, short_code) values
      ('${LOC_ART}', '${ORG_A}', 'Artistry Homes', 'ART'),
      ('${LOC_CLIVE}', '${ORG_A}', 'Clive Power Equipment', 'CPE'),
      ('${LOC_B}', '${ORG_B}', 'B Co', 'BCO');
    insert into core.vendors (id, org_id, name, email, phone) values
      ('${V_SUB}', '${ORG_A}', 'Prairie Drywall', 'ap@prairie.test', '515-555-0199'),
      ('${V_NEW}', '${ORG_A}', 'Cedar Electric', 'office@cedar.test', null),
      ('${V_RENEW}', '${ORG_A}', 'Oak Roofing', 'office@oak.test', null),
      ('${V_B}', '${ORG_B}', 'Other Vendor', 'x@other.test', null);
    insert into public.vendor_portal_tokens (org_id, vendor_id, token, status, requested_docs, expires_at) values
      ('${ORG_A}', '${V_SUB}', '${TOKEN_SUB}', 'ACTIVE', array['W9','COI','BANKING'], now() + interval '30 days'),
      ('${ORG_A}', '${V_SUB}', '${TOKEN_REVOKED}', 'REVOKED', array['W9'], now() + interval '30 days');
  `);
  const b = await db.query<{ id: string }>(
    `insert into public.bills (org_id, location_id, vendor_id, bill_number, bill_date, due_date, total_cents, status, payment_hold_reason)
     values ($1, $2, $3, 'PD-100', '2026-10-01', '2026-10-31', 1250000, 'ON_HOLD', 'Vendor compliance documents missing or expired') returning id`,
    [ORG_A, LOC_ART, V_SUB],
  );
  BILL = b.rows[0].id;
  await db.query(`insert into public.bills (org_id, location_id, vendor_id, bill_number, bill_date, due_date, total_cents, status) values ($1, $2, $3, 'CE-1', '2026-10-01', '2026-10-31', 50000, 'APPROVED'), ($1, $2, $4, 'OR-1', '2026-10-01', '2026-10-31', 70000, 'APPROVED')`, [ORG_A, LOC_ART, V_NEW, V_RENEW]);
  await db.query(`insert into core.users (clerk_user_id) values ('user_bk')`);
  const u = await db.query<{ id: string }>(`select id from core.users where clerk_user_id = 'user_bk'`);
  await db.query(`insert into core.memberships (user_id, org_id, role, status) values ($1, $2, 'accounting_specialist', 'active')`, [u.rows[0].id, ORG_A]);

  await saveRequirementSet(ORG_A, req(), 'user_ctl', svc, T0);
  for (const v of [V_SUB, V_NEW, V_RENEW]) await setVendorProfile(ORG_A, v, { vendorType: 'subcontractor', workType: null }, 'user_ctl', svc, T0);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 180 — RLS, write locks, masks (criterion 11)', () => {
  const T = ['vendor_requirements', 'vendor_compliance_profiles', 'vendor_document_submissions', 'vendor_coverages', 'vendor_bank_change_verifications'];
  it('members cannot write any 180 table; anon cannot read them', async () => {
    for (const t of T) {
      expect(await as('user_bk', ORG_A, () => errorOf(`insert into public.${t} (org_id) values ('${ORG_A}')`)), t).toMatch(/permission denied|row-level security|violates not-null/i);
      expect(await as('user_bk', ORG_A, () => errorOf(`update public.${t} set org_id = org_id`)), t).toMatch(/permission denied/i);
      expect(await as('user_bk', ORG_A, () => errorOf(`delete from public.${t}`)), t).toMatch(/permission denied/i);
      expect(await as(null, null, () => errorOf(`select 1 from public.${t}`)), t).toMatch(/permission denied/i);
    }
  });

  it('members read only their own org', async () => {
    await saveRequirementSet(ORG_B, req({ locationId: LOC_B, name: 'B set' }), 'user_b', svc, T0);
    const seen = await as('user_bk', ORG_A, async () => (await db.query<{ org_id: string }>(`select org_id from public.vendor_requirements`)).rows);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.org_id === ORG_A)).toBe(true);
  });

  it('CHECKs hold (no subqueries): bad vendor type, negative cents, bad lead days', async () => {
    expect(await errorOf(`insert into public.vendor_requirements (org_id, name, vendor_type) values ('${ORG_A}', 'x', 'pirate')`)).toMatch(/vendor_requirements_values_chk/);
    expect(await errorOf(`insert into public.vendor_requirements (org_id, name, min_auto_cents) values ('${ORG_A}', 'x', -1)`)).toMatch(/vendor_requirements_values_chk/);
    expect(await errorOf(`insert into public.vendor_requirements (org_id, name, expiry_lead_days) values ('${ORG_A}', 'x', 400)`)).toMatch(/vendor_requirements_values_chk/);
    expect(await errorOf(`insert into public.vendor_document_submissions (org_id, vendor_id, doc_kind, source, status) values ('${ORG_A}', '${V_SUB}', 'COI', 'portal_upload', 'rejected')`)).toMatch(/vendor_document_submissions_values_chk/);
  });
});

describe('the closed loop (criteria 1, 5, 6, 7)', () => {
  let coiReqId = '';
  let first: SubmissionRow;

  it('pay-time hold names the failed rule and logs PAYMENT_BLOCKED', async () => {
    const st = await evaluateVendorCompliance(svc, ORG_A, V_SUB, { locationId: LOC_ART, now: T0 });
    expect(st.requirementSet?.name).toBe('Artistry subcontractors');
    expect(st.onHold).toBe(true);
    await expect(enforcePaymentAllowed(svc, ORG_A, V_SUB, BILL, 'user_ap')).rejects.toBeInstanceOf(ComplianceHoldError);
    await expect(enforcePaymentAllowed(svc, ORG_A, V_SUB, BILL, 'user_ap')).rejects.toThrow(/Artistry subcontractors.*General liability/);
    expect(await events(V_SUB)).toContain('PAYMENT_BLOCKED');
  });

  it('a portal COI upload closes the live request (waiting for review) and the AI read is checked', async () => {
    const ctx = await loadPolicyContext(svc, ORG_A);
    const r = await createVendorDocRequest({ db: svc, now: () => T0 }, ctx, {
      orgId: ORG_A,
      vendor: { id: V_SUB, name: 'Prairie Drywall', email: 'ap@prairie.test' },
      need: { kind: 'coi', docTypes: ['GL_COI'], renewal: false, dueDate: null },
      createdBy: 'user_bk',
      source: 'manual',
    });
    coiReqId = r.request.id;
    const tok = await validatePortalToken(svc, TOKEN_SUB);
    expect(tok.ok).toBe(true);
    const tokenId = tok.ok ? tok.token.tokenId : '';
    const docId = await insertDoc('one');
    first = await recordSubmission(svc, { orgId: ORG_A, vendorId: V_SUB, docKind: 'COI', source: 'portal_upload', documentId: docId, portalTokenId: tokenId, actor: `vendor_token:${tokenId}` }, T0);
    const live = await db.query<{ status: string; fulfilled_via: string }>(`select status, fulfilled_via from core.requests where id = $1`, [coiReqId]);
    expect(live.rows[0]).toEqual({ status: 'fulfilled', fulfilled_via: 'magic_link' });
    // The vendor-portal link survives (replace a file, see the result).
    expect((await db.query<{ status: string }>(`select status from public.vendor_portal_tokens where token = $1`, [TOKEN_SUB])).rows[0].status).toBe('ACTIVE');

    first = await runAiCheck(svc, first, { base64: 'AA==', mediaType: 'application/pdf' }, {
      anthropicApiKey: 'test-key',
      parseCoi: fakeCoi({
        certificate_holder: 'Artistry Homes, LLC',
        additional_insured: true,
        coverages: [{ coverage_type: 'GENERAL_LIABILITY', doc_type: 'GL_COI', each_occurrence_cents: 50_000_000, aggregate_cents: 200_000_000, effective_date: '2026-07-01', expiration_date: '2027-07-01', confidence: {}, lowConfidenceFields: [] }],
      }),
    }, T0);
    expect(first.status).toBe('ai_checked');
    expect(first.ai_status).toBe('done');
    expect(first.rules_passed).toBe(false);
    const gl = first.rule_results.find((x) => x.rule === 'COI_GL_OCCURRENCE')!;
    expect(gl.outcome).toBe('short');
    expect(gl.reason).toBe('General liability each occurrence $500,000.00 on file; $1,000,000.00 required.');
    expect(await events(V_SUB)).toEqual(expect.arrayContaining(['UPLOAD_RECEIVED', 'REQUIREMENT_FAILED']));
    const aiRows = await db.query<{ n: number }>(`select count(*)::int as n from public.ai_decisions where org_id = $1 and feature = 'COI_EXTRACT' and status = 'PROPOSED'`, [ORG_A]);
    expect(aiRows.rows[0].n).toBe(1);
  });

  it('reject re-requests, quoting the reason (criterion 6)', async () => {
    const res = await rejectSubmission(svc, ORG_A, first.id, { actor: 'user_bk', reason: 'GL each occurrence must be at least $1,000,000' }, at(0.01));
    expect(res.submission.status).toBe('rejected');
    expect(res.requestCreated).toBe(true);
    const r = await db.query<{ status: string; message: string; title: string }>(`select status, message, title from core.requests where id = $1`, [res.requestId]);
    expect(r.rows[0].status).toBe('open');
    expect(r.rows[0].title).toBe('We need a corrected certificate of insurance');
    expect(r.rows[0].message).toContain('GL each occurrence must be at least $1,000,000');
    expect(await events(V_SUB)).toContain('DOC_REJECTED');
    await expect(rejectSubmission(svc, ORG_A, first.id, { actor: 'user_bk', reason: 'again' })).rejects.toBeInstanceOf(ReviewError);
  });

  it('AI down: the upload lands for a person; accept needs keyed lines (criterion 7)', async () => {
    const docId = await insertDoc('two');
    let sub = await recordSubmission(svc, { orgId: ORG_A, vendorId: V_SUB, docKind: 'COI', source: 'portal_upload', documentId: docId, actor: 'vendor_token:x' }, at(1));
    sub = await runAiCheck(svc, sub, { base64: 'AA==', mediaType: 'application/pdf' }, { anthropicApiKey: null }, at(1));
    expect(sub.status).toBe('received');
    expect(sub.ai_status).toBe('unavailable');
    expect(await events(V_SUB)).toContain('AI_UNAVAILABLE');
    await expect(acceptSubmission(svc, ORG_A, sub.id, { actor: 'user_bk' }, at(1))).rejects.toThrow(/Key at least one coverage line.*AI did not read/);
    first = sub;
  });

  it('accepting a passing COI + W-9 lifts the hold, fulfils the request, releases the bill (criterion 5)', async () => {
    // W-9 through the fill-here form first (the set requires one).
    const tok = await validatePortalToken(svc, TOKEN_SUB);
    const tokenId = tok.ok ? tok.token.tokenId : '';
    const { submission: w9 } = await submitW9Form(svc, { tokenId, orgId: ORG_A, vendorId: V_SUB }, W9, { now: at(1), ip: '203.0.113.9', userAgent: 'test' });
    const w9res = await acceptSubmission(svc, ORG_A, w9.id, { actor: 'user_bk' }, at(1));
    expect(w9res.stillOnHold).toBe(true); // the certificate is still missing
    const v = await db.query<{ w9_status: string; is_1099_eligible: boolean }>(`select w9_status, is_1099_eligible from core.vendors where id = $1`, [V_SUB]);
    expect(v.rows[0]).toEqual({ w9_status: 'RECEIVED', is_1099_eligible: true });

    const res = await acceptSubmission(svc, ORG_A, first.id, {
      actor: 'user_bk',
      certificateHolder: 'Artistry Homes, LLC',
      additionalInsured: true,
      coverages: [{ coverage_type: 'GENERAL_LIABILITY', each_occurrence_cents: 100_000_000, aggregate_cents: 200_000_000, effective_date: '2026-07-01', expiration_date: '2027-07-01' }],
    }, at(1));
    expect(res.holdLifted).toBe(true);
    expect(res.stillOnHold).toBe(false);
    expect(res.billsReleased).toBe(1);
    // The correction request was already closed by the re-upload ("waiting for review").
    expect(res.requestsFulfilled).toBe(0);
    const corr = await db.query<{ status: string; fulfilled_via: string }>(`select status, fulfilled_via from core.requests where org_id = $1 and recipient_vendor_id = $2 and title = 'We need a corrected certificate of insurance'`, [ORG_A, V_SUB]);
    expect(corr.rows).toEqual([{ status: 'fulfilled', fulfilled_via: 'magic_link' }]);
    const bill = await db.query<{ status: string }>(`select status from public.bills where id = $1`, [BILL]);
    expect(bill.rows[0].status).toBe('PENDING');
    const docs = await db.query<{ doc_type: string; status: string; expiration_date: string | null }>(`select doc_type, status, expiration_date::text from public.vendor_compliance_docs where vendor_id = $1 order by doc_type::text`, [V_SUB]);
    expect(docs.rows).toEqual([
      { doc_type: 'GL_COI', status: 'VALID', expiration_date: '2027-07-01' },
      { doc_type: 'W9', status: 'VALID', expiration_date: null },
    ]);
    const cov = await db.query<{ n: number }>(`select count(*)::int as n from public.vendor_coverages where vendor_id = $1 and is_active`, [V_SUB]);
    expect(cov.rows[0].n).toBe(1);
    await expect(enforcePaymentAllowed(svc, ORG_A, V_SUB, BILL, 'user_ap')).resolves.toBeUndefined();
    expect(await events(V_SUB)).toEqual(expect.arrayContaining(['DOC_ACCEPTED', 'HOLD_LIFTED', 'BILL_HOLD_RELEASED']));
    const tl = await vendorTimeline(svc, ORG_A, V_SUB);
    expect(tl.some((i) => i.type === 'HOLD_LIFTED')).toBe(true);
    expect(tl.some((i) => i.source === 'request')).toBe(true);
  });
});

describe('fill-here W-9 (criterion 9)', () => {
  it('TIN is encrypted, never in the stored form; members cannot read the ciphertext', async () => {
    const rows = await db.query<{ w9_form: Record<string, unknown>; tin_ciphertext: string | null; tin_last4: string }>(`select w9_form, tin_ciphertext, tin_last4 from public.vendor_document_submissions where source = 'portal_w9_form' and vendor_id = $1`, [V_SUB]);
    const r = rows.rows[0];
    expect(r.tin_last4).toBe('4567');
    expect(JSON.stringify(r.w9_form)).not.toContain('421234567');
    expect(JSON.stringify(r.w9_form)).not.toContain('1234567');
    expect(r.tin_ciphertext).toMatch(/^v2:[0-9a-f]{8}:/); // key id names the sealing key (rotation)
    expect(r.tin_ciphertext).not.toContain('421234567');
    expect(await as('user_bk', ORG_A, () => errorOf(`select tin_ciphertext from public.vendor_document_submissions`))).toMatch(/permission denied/i);
    const ok = await as('user_bk', ORG_A, async () => (await db.query<{ tin_last4: string }>(`select tin_last4 from public.vendor_document_submissions where source = 'portal_w9_form'`)).rows);
    expect(ok[0].tin_last4).toBe('4567');
  });
  it('mismatched entries and implausible TINs are refused', async () => {
    const tok = { tokenId: null, orgId: ORG_A, vendorId: V_SUB };
    await expect(submitW9Form(svc, tok, { ...W9, tin_confirm: '421234568' }, { ip: null, userAgent: null })).rejects.toBeInstanceOf(W9FormError);
    await expect(submitW9Form(svc, tok, { ...W9, tin: '071234567', tin_confirm: '071234567' }, { ip: null, userAgent: null })).rejects.toThrow(/valid EIN/);
  });
});

describe('bank-change call-back (criterion 10)', () => {
  let changeId = '';
  it('a portal banking change blocks payment and an override does not lift it', async () => {
    const row = await openBankChange(ORG_A, { vendorId: V_SUB, source: 'vendor_portal', requestPhone: '(515) 555-0100', openedBy: 'vendor_token:x' }, svc);
    changeId = row.id;
    const ov = await grantOverride(svc, ORG_A, { vendorId: V_SUB, holdType: 'PERMANENT', reason: 'Controller approved', actor: 'user_ctl' });
    expect(ov.success).toBe(true);
    await expect(enforcePaymentAllowed(svc, ORG_A, V_SUB, BILL, 'user_ap')).rejects.toThrow(/bank details changed/);
  });
  it('the number from the request is refused (app and DB); the maker cannot verify', async () => {
    await expect(verifyBankChange(ORG_A, changeId, { actor: 'user_bk', phoneUsed: '515.555.0100', phoneSource: 'vendor_master', contactName: 'Pat Lee' }, svc)).rejects.toBeInstanceOf(BankChangeError);
    expect(
      await errorOf(`update public.vendor_bank_change_verifications set status = 'verified', called_by = 'u', called_at = now(), phone_used = '+1 515 555 0100', phone_source = 'vendor_master', contact_name = 'Pat', decided_by = 'u', decided_at = now() where id = $1`, [changeId]),
    ).toMatch(/vendor_bank_change_not_request_phone_chk/);
    await expect(verifyBankChange(ORG_A, changeId, { actor: 'vendor_token:x', phoneUsed: '515-555-0199', phoneSource: 'vendor_master', contactName: 'Pat Lee' }, svc)).rejects.toThrow(/someone else/);
  });
  it('a valid call-back clears it and payment proceeds', async () => {
    const v = await verifyBankChange(ORG_A, changeId, { actor: 'user_bk', phoneUsed: '515-555-0199', phoneSource: 'vendor_master', contactName: 'Pat Lee' }, svc);
    expect(v.status).toBe('verified');
    await expect(enforcePaymentAllowed(svc, ORG_A, V_SUB, BILL, 'user_ap')).resolves.toBeUndefined();
    expect(await events(V_SUB)).toEqual(expect.arrayContaining(['BANK_CHANGE_OPENED', 'BANK_CHANGE_VERIFIED']));
  });
  describe('payment-profile trigger (security review M2: INSERT OR UPDATE, any new detail)', () => {
    type Row = { status: string; source: string; prior_account_mask: string | null; new_account_mask: string | null; new_payment_method: string | null; opened_by: string };
    const pending = async (): Promise<Row[]> =>
      (await db.query<Row>(`select status, source, prior_account_mask, new_account_mask, new_payment_method, opened_by from public.vendor_bank_change_verifications where vendor_id = $1 and status = 'pending' order by opened_at, created_at`, [V_NEW])).rows;
    const clear = () => db.query(`update public.vendor_bank_change_verifications set status = 'cancelled', decided_by = 'test', decided_at = now(), decision_reason = 'test cleanup' where vendor_id = $1 and status = 'pending'`, [V_NEW]);

    it('first capture (INSERT) opens a pending call-back — no prior details counts as different', async () => {
      await db.query(`insert into public.vendor_payment_profiles (org_id, vendor_id, payment_method, account_mask, routing_mask, captured_by) values ($1, $2, 'ACH', '****1111', '****0001', 'user_capt')`, [ORG_A, V_NEW]);
      expect(await pending()).toEqual([{ status: 'pending', source: 'payment_profile', prior_account_mask: null, new_account_mask: '****1111', new_payment_method: 'ACH', opened_by: 'user_capt' }]);
      await clear();
    });
    it('an update that leaves the bank details alone opens nothing', async () => {
      await db.query(`update public.vendor_payment_profiles set notes = 'net 30', bank_name = 'First Bank' where vendor_id = $1`, [V_NEW]);
      expect(await pending()).toEqual([]);
    });
    it('a changed account mask opens one (prior mask recorded)', async () => {
      await db.query(`update public.vendor_payment_profiles set account_mask = '****2222', captured_by = 'user_maker' where vendor_id = $1`, [V_NEW]);
      expect(await pending()).toEqual([{ status: 'pending', source: 'payment_profile', prior_account_mask: '****1111', new_account_mask: '****2222', new_payment_method: 'ACH', opened_by: 'user_maker' }]);
      // the same change again (an upsert retry) is not stacked
      await db.query(`update public.vendor_payment_profiles set account_mask = '****2222', updated_at = now() where vendor_id = $1`, [V_NEW]);
      expect(await pending()).toHaveLength(1);
      await clear();
    });
    it('a CHECK → ACH switch onto existing details opens one', async () => {
      await db.query(`update public.vendor_payment_profiles set payment_method = 'CHECK' where vendor_id = $1`, [V_NEW]);
      expect(await pending()).toEqual([]);
      await db.query(`update public.vendor_payment_profiles set payment_method = 'ACH' where vendor_id = $1`, [V_NEW]);
      expect((await pending()).map((r) => r.new_payment_method)).toEqual(['ACH']);
      await clear();
    });
    it('a new account with the SAME last four (different fingerprint) opens one', async () => {
      await db.query(`update public.vendor_payment_profiles set account_fingerprint = 'fp_old' where vendor_id = $1`, [V_NEW]);
      await clear(); // the first fingerprint on a legacy row is itself a change; reset
      await db.query(`update public.vendor_payment_profiles set account_fingerprint = 'fp_new' where vendor_id = $1`, [V_NEW]);
      const rows = await pending();
      expect(rows).toHaveLength(1);
      expect(rows[0].new_account_mask).toBe('****2222');
      await expect(enforcePaymentAllowed(svc, ORG_A, V_NEW, BILL, 'user_ap')).rejects.toThrow(/bank details changed/);
      await clear();
    });
    it('a profile with no bank details at all opens nothing', async () => {
      await db.query(`update public.vendor_payment_profiles set account_mask = null, routing_mask = null, account_fingerprint = null, payment_method = 'CHECK' where vendor_id = $1`, [V_NEW]);
      expect(await pending()).toEqual([]);
    });
  });
  it('the audit trail stays append-only', async () => {
    expect(await errorOf(`update public.vendor_compliance_events set detail = 'x' where vendor_id = $1`, [V_SUB])).toMatch(/append-only|not allowed|refuse/i);
  });
});

describe('portal token scope + view (criterion 8)', () => {
  it('a token resolves only its own vendor; revoked / unknown are refused', async () => {
    const ok = await validatePortalToken(svc, TOKEN_SUB);
    expect(ok.ok && ok.token.vendorId).toBe(V_SUB);
    expect(ok.ok && ok.token.orgId).toBe(ORG_A);
    const rev = await validatePortalToken(svc, TOKEN_REVOKED);
    expect(rev).toEqual({ ok: false, state: 'revoked' });
    expect(await validatePortalToken(svc, 'tok_unknown_000000000000000000000000000')).toEqual({ ok: false, state: 'not_found' });
  });
  it('the view shows this vendor’s items and the asking company only', async () => {
    const view = await buildPortalView(svc, { orgId: ORG_A, vendorId: V_SUB, requestedDocs: ['W9', 'COI'] }, at(2));
    expect(view.companyName).toBe('Merit Test Firm');
    expect(view.vendorName).toBe('Prairie Drywall');
    expect(view.items.map((i) => i.state)).toEqual(['accepted', 'accepted']);
    expect(view.renewalDate).toBe('2027-07-01');
    expect(JSON.stringify(view)).not.toContain('Other Vendor');
  });
});

describe('chase switch + preview (criterion 12)', () => {
  it('off → nothing is created; the forced preview lists who would be emailed', async () => {
    const off = await syncVendorComplianceRequests({ db: svc, now: () => at(3) }, ORG_A);
    expect(off.enabled).toBe(false);
    const preview = await planVendorChase({ db: svc, now: () => at(3) }, ORG_A, { forceOn: true });
    const cedar = preview.items.filter((i) => i.vendor.id === V_NEW);
    expect(cedar.map((i) => i.need.kind).sort()).toEqual(['coi', 'w9']);
    expect(cedar.every((i) => i.status === 'would_send')).toBe(true);
    expect(preview.items.some((i) => i.vendor.id === V_SUB && i.status === 'would_send')).toBe(false);
  });
  it('per-company switch on → W-9 with no doc row + COI requests; a renewal is due-anchored', async () => {
    // Oak Roofing: accepted certificate expiring in 20 days.
    const docId = await insertDoc('oak');
    const s = await recordSubmission(svc, { orgId: ORG_A, vendorId: V_RENEW, docKind: 'COI', source: 'staff_upload', documentId: docId, actor: 'user_bk' }, at(3));
    await acceptSubmission(svc, ORG_A, s.id, {
      actor: 'user_bk', certificateHolder: 'Artistry Homes LLC', additionalInsured: true,
      coverages: [{ coverage_type: 'GENERAL_LIABILITY', each_occurrence_cents: 100_000_000, aggregate_cents: 200_000_000, effective_date: '2025-11-15', expiration_date: '2026-11-15' }],
    }, at(3));
    const { submission: w9 } = await submitW9Form(svc, { tokenId: null, orgId: ORG_A, vendorId: V_RENEW }, { ...W9, legal_name: 'Oak Roofing Inc', entity_type: 'C_CORP', llc_tax_class: null }, { now: at(3), ip: null, userAgent: null });
    await acceptSubmission(svc, ORG_A, w9.id, { actor: 'user_bk' }, at(3));

    for (const k of ['w9', 'coi', 'coi_renewal'] as const) await setChaseSwitch(ORG_A, LOC_ART, k, true, 'user_ctl', svc, at(3));
    const plan = await planVendorChase({ db: svc, now: () => at(3) }, ORG_A);
    const sync = await syncVendorComplianceRequests({ db: svc, now: () => at(3) }, ORG_A);
    expect(sync.enabled).toBe(true);
    expect(sync.created).toBe(plan.items.filter((i) => i.status === 'would_send' || i.status === 'no_email').length);
    const reqs = await db.query<{ kind: string; recipient_vendor_id: string; cadence_anchor: string; due_date: string | null }>(
      `select kind, recipient_vendor_id, cadence_anchor, due_date::text from core.requests where org_id = $1 and status in ('open','sent','snoozed') and recipient_vendor_id in ($2, $3) order by recipient_vendor_id, kind`,
      [ORG_A, V_NEW, V_RENEW],
    );
    expect(reqs.rows).toEqual([
      { kind: 'coi', recipient_vendor_id: V_NEW, cadence_anchor: 'created', due_date: null },
      { kind: 'w9', recipient_vendor_id: V_NEW, cadence_anchor: 'created', due_date: null },
      { kind: 'coi', recipient_vendor_id: V_RENEW, cadence_anchor: 'due', due_date: '2026-11-15' },
    ]);
    const again = await syncVendorComplianceRequests({ db: svc, now: () => at(3) }, ORG_A);
    expect(again.created).toBe(0);
  });
  it('the dashboard counts by company and flags each bucket', async () => {
    const d = await buildDashboard(svc, ORG_A, { now: at(3) });
    const byId = new Map(d.rows.map((r) => [r.vendorId, r]));
    expect(byId.get(V_NEW)!.missing).toBe(true);
    expect(byId.get(V_NEW)!.onHold).toBe(true);
    expect(byId.get(V_RENEW)!.expiring).toBe(true);
    expect(byId.get(V_RENEW)!.onHold).toBe(false);
    expect(byId.get(V_SUB)!.compliant).toBe(true);
    const art = d.byCompany.find((c) => c.locationId === LOC_ART)!;
    expect(art.total).toBe(3);
    expect(d.summary.onHold).toBeGreaterThanOrEqual(1);
  });
});

describe('legacy behaviour without a requirement set (criterion 13)', () => {
  it('tenant B (its set is for its own company only): a vendor with a MISSING doc row is held by the old rule', async () => {
    await db.query(`insert into public.vendor_compliance_docs (org_id, vendor_id, doc_type, status) values ($1, $2, 'W9', 'MISSING')`, [ORG_B, V_B]);
    const st = await evaluateVendorCompliance(svc, ORG_B, V_B, { locationId: null });
    expect(st.requirementSet).toBeNull();
    expect(st.onHold).toBe(true);
    expect(st.issues[0]).toMatchObject({ docType: 'W9', state: 'missing' });
  });
});

describe('vendor-portal AI budget (security review M11)', () => {
  const TOK_1 = '18000000-0000-0000-0000-0000000000f1';
  const TOK_2 = '18000000-0000-0000-0000-0000000000f2';
  it(`allows ${PORTAL_AI_READS_PER_DAY} AI reads per link per UTC day, then refuses (DB counter, per link)`, async () => {
    const day1 = new Date('2026-10-23T09:00:00Z');
    for (let i = 1; i <= PORTAL_AI_READS_PER_DAY; i++) {
      expect(await consumePortalAiRead(ORG_A, TOK_1, { writer: svc, now: day1 })).toEqual({ ok: true, used: i });
    }
    expect(await consumePortalAiRead(ORG_A, TOK_1, { writer: svc, now: new Date('2026-10-23T23:59:00Z') })).toMatchObject({ ok: false, reason: 'over_cap' });
    // another link has its own budget; the next UTC day resets
    expect(await consumePortalAiRead(ORG_A, TOK_2, { writer: svc, now: day1 })).toEqual({ ok: true, used: 1 });
    expect(await consumePortalAiRead(ORG_A, TOK_1, { writer: svc, now: new Date('2026-10-24T00:00:01Z') })).toEqual({ ok: true, used: 1 });
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from core.outbound_send_counters where scope = 'portal_ai_day'`);
    expect(rows.rows[0].n).toBeGreaterThanOrEqual(3);
  });
  it('a refused read stores the upload for a person and is NOT re-read by the re-check job', async () => {
    const docId = await insertDoc('budget');
    let sub = await recordSubmission(svc, { orgId: ORG_A, vendorId: V_SUB, docKind: 'COI', source: 'portal_upload', documentId: docId, actor: 'vendor_token:x' }, at(2));
    let called = 0;
    sub = await runAiCheck(svc, sub, { base64: 'AA==', mediaType: 'application/pdf' }, { anthropicApiKey: 'k', aiDeniedNote: 'This link has used its 3 automatic reads for today.', parseCoi: async () => { called++; throw new Error('must not be called'); } }, at(2));
    expect(called).toBe(0);
    expect(sub.status).toBe('received');
    expect(sub.ai_status).toBe('skipped');
    expect(sub.ai_note).toMatch(/3 automatic reads/);
    await db.query(`update public.vendor_document_submissions set status = 'superseded' where id = $1`, [sub.id]);
  });
  it('the counter is service-role only', async () => {
    expect(await as('user_bk', ORG_A, () => errorOf(`select * from core.outbound_send_counters`))).toMatch(/permission denied/i);
  });
});

describe('certificate AI re-check stops after 3 attempts (LOW)', () => {
  it('each model call counts an attempt; the job skips documents at the cap', async () => {
    const docId = await insertDoc('retry');
    let sub = await recordSubmission(svc, { orgId: ORG_A, vendorId: V_SUB, docKind: 'COI', source: 'portal_upload', documentId: docId, actor: 'vendor_token:x' }, at(2));
    const failing = async (): Promise<ParseCoiResult> => ({ ok: false, error: 'unreadable' });
    for (let i = 1; i <= MAX_AI_ATTEMPTS; i++) {
      sub = await runAiCheck(svc, sub, { base64: 'AA==', mediaType: 'application/pdf' }, { anthropicApiKey: 'k', parseCoi: failing }, at(2));
      expect(sub.ai_attempts).toBe(i);
      expect(sub.ai_status).toBe('failed');
    }
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const ctx = { orgId: ORG_A, now: new Date(), slotAt: new Date(), signal: new AbortController().signal, admin: svc } as unknown as JobContext;
      const res = await runVendorAiRecheckJob(ctx);
      expect(res).toMatchObject({ status: 'skipped', summary: 'Nothing waiting for an AI read.' });
      // one attempt short of the cap → the job still picks it up
      await db.query(`update public.vendor_document_submissions set ai_attempts = $2, document_id = null where id = $1`, [sub.id, MAX_AI_ATTEMPTS - 1]);
      const res2 = await runVendorAiRecheckJob(ctx);
      expect(res2.counts).toMatchObject({ waiting: 1 });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
      await db.query(`update public.vendor_document_submissions set status = 'superseded' where id = $1`, [sub.id]);
    }
  });
});

describe('W-9 whose TIN could not be stored (LOW)', () => {
  it('cannot be accepted (no encryption key when it was typed)', async () => {
    const prev = process.env.TIN_ENCRYPTION_KEY;
    delete process.env.TIN_ENCRYPTION_KEY;
    let id = '';
    try {
      const { submission, tinStored } = await submitW9Form(svc, { tokenId: null, orgId: ORG_B, vendorId: V_B }, W9, { now: at(3), ip: null, userAgent: null });
      expect(tinStored).toBe(false);
      id = submission.id;
    } finally {
      process.env.TIN_ENCRYPTION_KEY = prev;
    }
    await expect(acceptSubmission(svc, ORG_B, id, { actor: 'user_bk' }, at(3))).rejects.toThrow(/full taxpayer ID was not saved/);
    const st = await db.query<{ status: string }>(`select status from public.vendor_document_submissions where id = $1`, [id]);
    expect(st.rows[0].status).toBe('received');
  });
});
