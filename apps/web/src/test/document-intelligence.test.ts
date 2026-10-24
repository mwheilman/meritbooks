/**
 * Document intelligence against a REAL Postgres (PGlite migration replay WITH hosted
 * Supabase's default grants) — FPB-document-intelligence §9:
 *
 *   188 schema     RLS on, members read their org only and cannot write; CHECKs hold;
 *                  the same bytes can never back two pending proposals of one kind
 *   AI down        rules route a scanner-named lease PDF; the extractor waits; a retry is
 *                  scheduled; an unreadable scan needs review (AC1, AC2, AC6)
 *   AI back        the retry job re-reads only due rows and fills the proposal (AC6)
 *   idempotent     analyze twice → one proposal; identical bytes → duplicate (AC3, AC4)
 *   accept         one link both ways + the document's entity link; unknown target → 404 (AC5)
 *   company        one company → it; several → the one named in the text (AC7)
 *   W-9            typed by rules → the gateway is never called (AC9)
 *   backfill       eligible docs analyzed, module-filed docs linked not proposed (AC10)
 *   no GL          nothing inserts into gl_entries (AC12)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';
import { seedTenant, count, type Tenant } from './seam-fixture';
import { makePdf } from './pdf-fixture';

const holder = vi.hoisted(() => ({ svc: null as unknown as SupabaseClient }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => holder.svc }));
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabase: () => holder.svc, createServerSupabase: () => holder.svc }));

const svcMod = await import('@/lib/documents/intelligence/service');
const { analyzeDocument, acceptProposal, backfillOrg, retryDue, changeType, linkExisting, dismissDocument } = svcMod;
const { TIN_REVIEW_REASON } = await import('@/lib/documents/intelligence/tin-guard');
const { defaultNative, genuineOpenSubmission } = await import('@/lib/documents/intelligence/native');
const { needsAccessMessage } = await import('@/lib/documents/intelligence/types');
type IntelDeps = import('@/lib/documents/intelligence/service').IntelDeps;
type ClassifyFn = import('@/lib/documents/intelligence/ai-classify').ClassifyFn;
type ExtractImpl = import('@/lib/documents/intelligence/extract').ExtractImpl;
type NativeImpl = import('@/lib/documents/intelligence/native').NativeImpl;

let db: PGlite;
let svc: SupabaseClient;
let T: Tenant;
let OTHER: Tenant;
const bytes = new Map<string, Uint8Array>();

const LEASE_TEXT = [
  'COMMERCIAL LEASE AGREEMENT',
  'This Lease is made between Acme Properties LLC ("Lessor") and Co DI ("Lessee").',
  'Premises: 123 Main Street, Suite 200. Base Rent: $8,500.00 per month. Security Deposit: $17,000.00.',
  'Commencement Date: March 1, 2025. Expiration Date: February 28, 2030.',
];

async function addDoc(org: string, name: string, data: Uint8Array, opts: { entityType?: string | null; entityId?: string | null; mime?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.documents (id, org_id, storage_path, file_name, mime_type, size_bytes, doc_type, entity_type, entity_id)
     values ($1, $2, $3, $4, $5, $6, 'OTHER', $7, $8)`,
    [id, org, `${org}/unfiled/${id}-${name}`, name, opts.mime ?? 'application/pdf', data.length, opts.entityType ?? null, opts.entityId ?? null],
  );
  bytes.set(id, data);
  return id;
}

function deps(over: Partial<IntelDeps> = {}): IntelDeps {
  return {
    db: svc,
    anthropicApiKey: null,
    now: () => new Date('2026-10-24T12:00:00Z'),
    loadBytes: async (doc) => bytes.get(doc.id) ?? null,
    classify: vi.fn<ClassifyFn>(async () => ({ ok: false, kind: 'unavailable', error: 'organization disabled' })),
    extract: vi.fn<ExtractImpl>(async () => ({ ok: false, kind: 'unavailable', error: 'HTTP 403' })),
    native: fakeNative(),
    ...over,
  };
}

function fakeNative(): NativeImpl {
  return {
    createBillDraft: vi.fn(async () => ({ ok: true as const, nativeTable: 'ai_decisions' as const, nativeId: crypto.randomUUID(), title: 'Vendor bill', summary: '$10.00', confidence: 0.9, extracted: true })),
    createVendorSubmission: vi.fn(async () => ({ ok: true as const, nativeTable: 'vendor_document_submissions' as const, nativeId: crypto.randomUUID(), title: 'W-9', summary: 'waiting', confidence: null, extracted: false })),
  };
}

const leaseExtract: ExtractImpl = async (kind, _d, args) => ({
  ok: true,
  payload: { lease: { lessor: 'Acme Properties LLC', description: 'Suite 200', classification: 'OPERATING', commencement_date: '2025-03-01', end_date: '2030-02-28', payment_dollars: 8500, payment_frequency: 'MONTHLY', payment_timing: 'ADVANCE', term_months: 60, discount_rate: null, notes: null, snippet: null, confidence: { lessor: 0.95 }, lowConfidenceFields: [] }, meta: { fileName: args.fileName, model: 'm', decisionId: null, documentNote: null, extractionMs: 1, sourceDocumentId: args.documentId } },
  title: `Acme Properties LLC · Suite 200 (${kind})`,
  summary: '$8,500 monthly · 2025-03-01 to 2030-02-28',
  confidence: 0.95,
  model: 'claude-sonnet-4-6',
  correlationId: null,
  feature: 'LEASE_EXTRACT',
});

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function asMember<R>(org: string, fn: () => Promise<R>): Promise<R> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: 'user_member', org_id: org, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true }));
  svc = pgSupabase(db);
  holder.svc = svc;
  T = await seedTenant(db, { projects: false, shortCode: 'DI' });
  OTHER = await seedTenant(db, { projects: false, shortCode: 'OX' });
}, 175_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 188', () => {
  it('RLS on, members read their org only, no member writes; CHECKs hold', async () => {
    for (const t of ['document_intelligence', 'document_proposals', 'document_links']) {
      const rls = await db.query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`);
      expect(rls.rows[0].relrowsecurity, t).toBe(true);
      expect(await asMember(T.org, () => errorOf(`insert into public.${t} (org_id) values ('${T.org}')`)), t).toMatch(/permission denied|row-level security|violates not-null/i);
      expect(await asMember(T.org, () => errorOf(`update public.${t} set org_id = org_id`)), t).toMatch(/permission denied/i);
      expect(await asMember(T.org, () => errorOf(`delete from public.${t}`)), t).toMatch(/permission denied/i);
    }
    const doc = await addDoc(T.org, 'check.pdf', makePdf(['x']));
    expect(await errorOf(`insert into public.document_intelligence (org_id, document_id, doc_class) values ($1, $2, 'spaceship')`, [T.org, doc])).toMatch(/document_intelligence_values_chk/);
    expect(await errorOf(`insert into public.document_proposals (org_id, document_id, target_kind, mode, status) values ($1, $2, 'lease', 'staged', 'accepted')`, [T.org, doc])).toMatch(/document_proposals_values_chk/);
    expect(await errorOf(`insert into public.document_links (org_id, document_id, target_type, target_id) values ($1, $2, 'Bad Type', $1)`, [T.org, doc])).toMatch(/document_links_values_chk/);
    // The same bytes can back only one live proposal per module.
    const doc2 = await addDoc(T.org, 'check2.pdf', makePdf(['y']));
    const sha = 'a'.repeat(64);
    expect(await errorOf(`insert into public.document_proposals (org_id, document_id, target_kind, mode, content_sha256) values ($1, $2, 'lease', 'staged', $3)`, [T.org, doc, sha])).toBeNull();
    expect(await errorOf(`insert into public.document_proposals (org_id, document_id, target_kind, mode, content_sha256) values ($1, $2, 'lease', 'staged', $3)`, [T.org, doc2, sha])).toMatch(/duplicate key|ux_document_proposals_hash_kind/);
    await db.query(`delete from public.document_proposals where org_id = $1`, [T.org]);
    // Member reads are org-isolated.
    await db.query(`insert into public.document_links (org_id, document_id, target_type, target_id) values ($1, $2, 'lease', $1)`, [T.org, doc]);
    expect(await asMember(OTHER.org, async () => (await db.query(`select count(*)::int n from public.document_links`)).rows[0])).toEqual({ n: 0 });
    expect(await asMember(T.org, async () => (await db.query(`select count(*)::int n from public.document_links`)).rows[0])).toEqual({ n: 1 });
    await db.query(`delete from public.document_links where org_id = $1`, [T.org]);
    await db.query(`delete from public.documents where id in ($1, $2)`, [doc, doc2]);
  });
});

describe('AI down → rules + retry; AI back → proposal (AC1, AC2, AC6)', () => {
  it('routes a scanner-named lease PDF by its text layer and schedules the AI read', async () => {
    const glBefore = await count(db, `select count(*) n from public.gl_entries`);
    const id = await addDoc(T.org, '20240912122602102.pdf', makePdf(LEASE_TEXT));
    const d = deps();
    const r = await analyzeDocument(d, { orgId: T.org, documentId: id, userId: 'user_1', source: 'center' });
    expect(r.intelligence?.doc_class).toBe('lease');
    expect(r.intelligence?.class_source).toBe('rules');
    expect(Number(r.intelligence?.confidence)).toBeGreaterThanOrEqual(0.6);
    expect(r.intelligence?.status).toBe('proposal_created');
    expect(r.intelligence?.ai_status).toBe('unavailable');
    expect(new Date(r.intelligence?.next_retry_at as string).toISOString()).toBe('2026-10-24T12:15:00.000Z');
    expect(r.intelligence?.location_id).toBe(T.loc); // one company → it
    expect(r.intelligence?.counterparty).toBe('Acme Properties LLC');
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ target_kind: 'lease', mode: 'staged', status: 'pending', extract_state: 'pending', location_id: T.loc, target_href: '/leases' });
    expect(r.message).toMatch(/We found a lease — added to Leases for your review\. AI will read the terms/);
    expect(d.classify).not.toHaveBeenCalled(); // no key → no gateway call at all
    const doc = await db.query<{ doc_type: string }>(`select doc_type from public.documents where id = $1`, [id]);
    expect(doc.rows[0].doc_type).toBe('LEASE');

    // A due retry with AI back fills the proposal from LEASE_EXTRACT.
    const classify = vi.fn<ClassifyFn>(async () => ({ ok: true, classification: { docClass: 'lease', confidence: 0.97, summary: 'A 5-year office lease.', counterparty: 'Acme Properties LLC', companyName: 'Co DI', keyDates: { effective_date: '2025-03-01' }, amountCents: 850_000, note: null }, model: 'claude-sonnet-4-6', correlationId: 'c1' }));
    const extract = vi.fn(leaseExtract);
    const later = deps({ anthropicApiKey: 'sk-test', classify, extract, now: () => new Date('2026-10-24T12:20:00Z') });
    const out = await retryDue(later, { orgId: T.org });
    expect(out.retried).toBe(1);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    const p = await db.query<{ extract_state: string; payload: { lease: { lessor: string }; meta: { sourceDocumentId: string; decisionId: string } }; title: string; ai_decision_id: string }>(`select * from public.document_proposals where document_id = $1`, [id]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].extract_state).toBe('done');
    expect(p.rows[0].payload.lease.lessor).toBe('Acme Properties LLC');
    expect(p.rows[0].payload.meta.sourceDocumentId).toBe(id);
    expect(p.rows[0].payload.meta.decisionId).toBe(p.rows[0].ai_decision_id);
    const intel = await db.query<{ ai_status: string; next_retry_at: string | null; class_source: string; summary: string }>(`select * from public.document_intelligence where document_id = $1`, [id]);
    expect(intel.rows[0]).toMatchObject({ ai_status: 'done', next_retry_at: null, class_source: 'ai', summary: 'A 5-year office lease.' });
    expect(await count(db, `select count(*) n from public.ai_decisions where org_id = $1 and feature in ('DOCUMENT_CLASSIFY', 'LEASE_EXTRACT')`, [T.org])).toBe(2);

    // Not due → not re-read.
    const again = await retryDue(deps({ anthropicApiKey: 'sk-test', classify, extract }), { orgId: T.org });
    expect(again.retried).toBe(0);

    // AC3: analyzing again never makes a second proposal.
    await analyzeDocument(later, { orgId: T.org, documentId: id, userId: 'user_1', source: 'center', force: true });
    expect(await count(db, `select count(*) n from public.document_proposals where document_id = $1`, [id])).toBe(1);

    // AC4: the same bytes uploaded again → duplicate, no proposal.
    const twin = await addDoc(T.org, 'lease copy.pdf', bytes.get(id) as Uint8Array);
    const dup = await analyzeDocument(later, { orgId: T.org, documentId: twin, userId: 'user_1', source: 'center' });
    expect(dup.intelligence).toMatchObject({ status: 'duplicate', duplicate_of: id });
    expect(await count(db, `select count(*) n from public.document_proposals where document_id = $1`, [twin])).toBe(0);

    // AC5: the Leases create path made lease L from the proposal → accept links both ways.
    const leaseId = crypto.randomUUID();
    await db.query(
      `insert into public.leases (id, org_id, location_id, lessor, description, classification, commencement_date, end_date, payment_cents, payment_frequency, payment_timing, term_months, discount_rate, rou_asset_cents, liability_cents)
       values ($1, $2, $3, 'Acme Properties LLC', 'Suite 200', 'OPERATING', '2025-03-01', '2030-02-28', 850000, 'MONTHLY', 'ADVANCE', 60, 0.06, 1, 1)`,
      [leaseId, T.org, T.loc],
    );
    const prop = (await db.query<{ id: string }>(`select id from public.document_proposals where document_id = $1`, [id])).rows[0];
    await expect(acceptProposal(later, { orgId: T.org, proposalId: prop.id, userId: 'user_1', targetType: 'lease', targetId: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
    await expect(acceptProposal(later, { orgId: OTHER.org, proposalId: prop.id, userId: 'user_1', targetType: 'lease', targetId: leaseId })).rejects.toMatchObject({ status: 404 });
    const acc = await acceptProposal(later, { orgId: T.org, proposalId: prop.id, userId: 'user_1', targetType: 'lease', targetId: leaseId });
    expect(acc.label).toBe('Lease: Acme Properties LLC — Suite 200');
    await acceptProposal(later, { orgId: T.org, proposalId: prop.id, userId: 'user_1', targetType: 'lease', targetId: leaseId }); // idempotent
    const links = await db.query<{ document_id: string; target_type: string; target_id: string; created_via: string }>(`select * from public.document_links where org_id = $1 and target_type = 'lease' and target_id = $2`, [T.org, leaseId]);
    expect(links.rows).toEqual([expect.objectContaining({ document_id: id, created_via: 'ai' })]);
    const byDoc = await db.query(`select * from public.document_links where org_id = $1 and document_id = $2`, [T.org, id]);
    expect(byDoc.rows).toHaveLength(1);
    const docRow = await db.query<{ entity_type: string; entity_id: string }>(`select entity_type, entity_id from public.documents where id = $1`, [id]);
    expect(docRow.rows[0]).toEqual({ entity_type: 'lease', entity_id: leaseId });
    const finalIntel = await db.query<{ status: string }>(`select status from public.document_intelligence where document_id = $1`, [id]);
    expect(finalIntel.rows[0].status).toBe('accepted');

    // AC12: none of it touched the GL.
    expect(await count(db, `select count(*) n from public.gl_entries`)).toBe(glBefore);
  });

  it('an image-only scan with a meaningless name waits for a PERSON — never sent to AI (H4)', async () => {
    const id = await addDoc(T.org, '20240912122602102.pdf', Buffer.from('%PDF-1.4\n4 0 obj << /Length 3 /Filter /DCTDecode >>\nstream\nabc\nendstream\n%%EOF'));
    const classify = vi.fn<ClassifyFn>(async () => ({ ok: false, kind: 'unavailable', error: 'Your organization has been disabled.' }));
    const r = await analyzeDocument(deps({ anthropicApiKey: 'sk-test', classify }), { orgId: T.org, documentId: id, userId: 'user_1', source: 'center' });
    expect(classify).not.toHaveBeenCalled();
    expect(r.intelligence).toMatchObject({ doc_class: 'other', status: 'needs_review', ai_status: 'skipped', ai_attempts: 0, next_retry_at: null, reason: TIN_REVIEW_REASON });
    expect(r.proposals).toHaveLength(0);
    expect(r.message).toMatch(/To protect taxpayer IDs/);
    // The retry job never picks it up either.
    expect((await retryDue(deps({ anthropicApiKey: 'sk-test', classify }), { orgId: T.org })).retried).toBe(0);
    expect(classify).not.toHaveBeenCalled();

    // A person picks the type → routed at once (and the extractor waits for AI).
    const c = await changeType(deps(), { orgId: T.org, documentId: id, userId: 'user_1', docClass: 'insurance_policy' });
    expect(c.intelligence).toMatchObject({ doc_class: 'insurance_policy', class_source: 'user', status: 'proposal_created' });
    expect(c.proposals.map((p) => p.target_kind)).toEqual(['insurance_policy']);

    // Changing it again supersedes the old kind's proposal.
    const c2 = await changeType(deps(), { orgId: T.org, documentId: id, userId: 'user_1', docClass: 'prepaid' });
    expect(c2.proposals.map((p) => p.target_kind)).toEqual(['prepaid']);
    const kinds = await db.query<{ target_kind: string; status: string }>(`select target_kind, status from public.document_proposals where document_id = $1 order by created_at`, [id]);
    expect(kinds.rows).toEqual([{ target_kind: 'insurance_policy', status: 'superseded' }, { target_kind: 'prepaid', status: 'pending' }]);

    // Dismiss stops the retries.
    const dis = await dismissDocument(deps(), { orgId: T.org, documentId: id, userId: 'user_1' });
    expect(dis).toMatchObject({ status: 'dismissed', next_retry_at: null });
  });
});

describe('company, W-9, native, links, backfill', () => {
  it('several companies → the one named in the text (AC7)', async () => {
    const spe = crypto.randomUUID();
    await db.query(`insert into core.locations (id, org_id, name, short_code, rev_rec_method) values ($1, $2, 'Merit SPE 2 LLC', 'SPE2', 'AS_BILLED')`, [spe, T.org]);
    const id = await addDoc(T.org, 'note.pdf', makePdf(['PROMISSORY NOTE', 'Borrower: Merit SPE 2, L.L.C. promises to pay First State Bank ("Lender") the principal sum of $300,000.00.', 'Maturity Date: September 17, 2029. Interest rate 7.5%.']));
    const r = await analyzeDocument(deps(), { orgId: T.org, documentId: id, userId: 'user_1', source: 'center' });
    expect(r.intelligence).toMatchObject({ doc_class: 'loan', location_id: spe, location_source: 'rules', counterparty: 'First State Bank' });
    expect(r.proposals[0]).toMatchObject({ target_kind: 'debt_instrument', location_id: spe });
  });

  it('a W-9 typed by rules never reaches the gateway; the vendor gets a submission (AC9)', async () => {
    const vendor = crypto.randomUUID();
    await db.query(`insert into core.vendors (id, org_id, name) values ($1, $2, 'Bolt Electric LLC')`, [vendor, T.org]);
    const id = await addDoc(T.org, 'bolt w9.pdf', makePdf(['Form W-9 (Rev. March 2024)', 'Request for Taxpayer Identification Number and Certification', 'Name (as shown on your income tax return): Bolt Electric LLC', 'Exempt payee code. Backup withholding.']));
    const classify = vi.fn<ClassifyFn>();
    const native = fakeNative();
    const r = await analyzeDocument(deps({ anthropicApiKey: 'sk-test', classify, native }), { orgId: T.org, documentId: id, userId: 'user_1', source: 'center' });
    expect(classify).not.toHaveBeenCalled();
    expect(r.intelligence).toMatchObject({ doc_class: 'w9', ai_status: 'skipped', next_retry_at: null });
    expect(native.createVendorSubmission).toHaveBeenCalledWith(svc, expect.objectContaining({ vendorId: vendor, docKind: 'W9', base64: null }));
    expect(r.proposals[0]).toMatchObject({ target_kind: 'vendor_w9', mode: 'native', native_table: 'vendor_document_submissions', extract_state: 'done' });
  });

  it('a vendor bill lands in the AP intake queue as a native draft', async () => {
    const id = await addDoc(T.org, 'inv.pdf', makePdf(['INVOICE', 'Invoice Number 7781 Bill To Merit SPE 2 LLC Amount Due $10.00 Remit To Acme Supply Due Date 11/30/2026 Subtotal']));
    const native = fakeNative();
    const r = await analyzeDocument(deps({ anthropicApiKey: 'sk-test', native, classify: vi.fn<ClassifyFn>(async () => ({ ok: false, kind: 'failed', error: 'bad json' })) }), { orgId: T.org, documentId: id, userId: 'user_1', source: 'center' });
    expect(r.intelligence?.doc_class).toBe('vendor_bill');
    expect(native.createBillDraft).toHaveBeenCalledWith(svc, expect.objectContaining({ locationId: expect.any(String), documentId: id }));
    expect(r.proposals[0]).toMatchObject({ target_kind: 'bill', mode: 'native', native_table: 'ai_decisions', status: 'pending' });
    // A failed classification read is retried with backoff even though the bill is routed.
    expect(r.intelligence).toMatchObject({ ai_status: 'failed', ai_attempts: 1 });
  });

  it('link to an existing record (user) + backfill links module-filed docs and analyzes the rest (AC10)', async () => {
    // A module-filed lease document (entity set) — linked, never proposed.
    const leaseId = crypto.randomUUID();
    await db.query(
      `insert into public.leases (id, org_id, location_id, lessor, classification, commencement_date, end_date, payment_cents, payment_frequency, payment_timing, term_months, discount_rate, rou_asset_cents, liability_cents)
       values ($1, $2, $3, 'Old Lessor', 'OPERATING', '2024-01-01', '2026-12-31', 100000, 'MONTHLY', 'ARREARS', 36, 0.05, 1, 1)`,
      [leaseId, OTHER.org, OTHER.loc],
    );
    const filed = await addDoc(OTHER.org, 'lease-from-module.pdf', makePdf(LEASE_TEXT.concat(['module copy'])), { entityType: 'lease', entityId: leaseId });
    const loose1 = await addDoc(OTHER.org, 'Office Lease.pdf', makePdf(['nothing readable here']));
    const loose2 = await addDoc(OTHER.org, 'random.pdf', makePdf(['hello']));
    const r = await backfillOrg(deps(), { orgId: OTHER.org, userId: 'user_1' });
    expect(r.analyzed).toBe(2);
    expect(r.linksCreated).toBe(1);
    expect(await count(db, `select count(*) n from public.document_intelligence where document_id = $1`, [filed])).toBe(0);
    expect(await count(db, `select count(*) n from public.document_links where document_id = $1 and target_id = $2 and created_via = 'module'`, [filed, leaseId])).toBe(1);
    const st = await db.query<{ document_id: string; status: string; doc_class: string }>(`select document_id, status, doc_class from public.document_intelligence where org_id = $1`, [OTHER.org]);
    expect(st.rows.find((x) => x.document_id === loose1)).toMatchObject({ doc_class: 'lease', status: 'proposal_created' });
    expect(st.rows.find((x) => x.document_id === loose2)).toMatchObject({ status: 'needs_review' });
    // Idempotent: nothing left to do.
    const again = await backfillOrg(deps(), { orgId: OTHER.org, userId: 'user_1' });
    expect(again).toMatchObject({ analyzed: 0, linksCreated: 0 });

    // "This is that lease" → a user link closes the lease proposal.
    const l = await linkExisting(deps(), { orgId: OTHER.org, documentId: loose1, userId: 'user_1', targetType: 'lease', targetId: leaseId });
    expect(l.label).toBe('Lease: Old Lessor');
    const after = await db.query<{ status: string }>(`select status from public.document_intelligence where document_id = $1`, [loose1]);
    expect(after.rows[0].status).toBe('linked');
    const prop = await db.query<{ status: string; accepted_target_id: string }>(`select status, accepted_target_id from public.document_proposals where document_id = $1`, [loose1]);
    expect(prop.rows[0]).toEqual({ status: 'accepted', accepted_target_id: leaseId });
    // A record in ANOTHER org can never be linked.
    await expect(linkExisting(deps(), { orgId: T.org, documentId: (await addDoc(T.org, 'z.pdf', makePdf(['z']))), userId: 'user_1', targetType: 'lease', targetId: leaseId })).rejects.toMatchObject({ status: 404 });
  });
});

describe('taxpayer IDs never reach the AI; redaction; drafts need the module gate (security review H4 / M)', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

  it('a photo with a meaningless name is not sent to AI; one named as a lease is (safe filename clearance)', async () => {
    const classify = vi.fn<ClassifyFn>(async () => ({ ok: false, kind: 'failed', error: 'bad json' }));
    const photo = await addDoc(T.org, 'IMG_4471.png', PNG, { mime: 'image/png' });
    const r = await analyzeDocument(deps({ anthropicApiKey: 'sk-test', classify }), { orgId: T.org, documentId: photo, userId: 'user_1', source: 'center' });
    expect(classify).not.toHaveBeenCalled();
    expect(r.intelligence).toMatchObject({ status: 'needs_review', ai_status: 'skipped', next_retry_at: null });

    const w9photo = await addDoc(T.org, 'Bolt W-9 scan.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { mime: 'image/jpeg' });
    const w = await analyzeDocument(deps({ anthropicApiKey: 'sk-test', classify }), { orgId: T.org, documentId: w9photo, userId: 'user_1', source: 'center' });
    expect(classify).not.toHaveBeenCalled();
    expect(w.intelligence).toMatchObject({ doc_class: 'w9', class_source: 'rules', ai_status: 'skipped' });

    const lease = await addDoc(T.org, 'Office Lease 2025.png', Buffer.concat([PNG, Buffer.from([9, 9, 9])]), { mime: 'image/png' });
    await analyzeDocument(deps({ anthropicApiKey: 'sk-test', classify }), { orgId: T.org, documentId: lease, userId: 'user_1', source: 'center' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][1]).toMatchObject({ mediaType: 'image/png', textSample: null });
  });

  it('a W-2 / 1099 / EIN letter read from the text layer is typed natively — no classifier, no extractor', async () => {
    const classify = vi.fn<ClassifyFn>();
    const extract = vi.fn<ExtractImpl>(leaseExtract);
    const native = fakeNative();
    const d = deps({ anthropicApiKey: 'sk-test', classify, extract, native });
    const w2 = await addDoc(T.org, 'scan0001.pdf', makePdf(['Form W-2 Wage and Tax Statement 2025', "Employee's social security number 123-45-6789", 'Employer identification number (EIN) 12-3456789', 'Wages, tips, other compensation 52,000.00']));
    const r = await analyzeDocument(d, { orgId: T.org, documentId: w2, userId: 'user_1', source: 'center' });
    expect(r.intelligence).toMatchObject({ doc_class: 'tax_document', class_source: 'rules', ai_status: 'skipped', next_retry_at: null });
    expect(r.intelligence?.reason).toMatch(/W-2 — it carries a taxpayer ID/);
    const n1099 = await addDoc(T.org, 'misc.pdf', makePdf(['Form 1099-NEC Nonemployee Compensation', "PAYER'S TIN 12-3456789 RECIPIENT'S TIN ***-**-1234"]));
    expect((await analyzeDocument(d, { orgId: T.org, documentId: n1099, userId: 'user_1', source: 'center' })).intelligence).toMatchObject({ doc_class: 'form_1099', ai_status: 'skipped' });
    // A person typing it as a lease does not open it to the AI extractor either.
    const c = await changeType(d, { orgId: T.org, documentId: w2, userId: 'user_1', docClass: 'lease' });
    expect(c.proposals[0]).toMatchObject({ target_kind: 'lease', extract_state: 'failed' });
    expect(c.proposals[0].last_error).toMatch(/taxpayer ID/);
    expect(classify).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    // Nothing TIN-shaped was saved.
    const saved = await db.query<{ blob: string }>(`select row_to_json(i)::text blob from public.document_intelligence i where document_id in ($1, $2)`, [w2, n1099]);
    for (const row of saved.rows) expect(row.blob).not.toMatch(/123-45-6789|12-3456789/);
  });

  it('TINs are redacted from the AI prompt, the saved summary / counterparty / payload and the ai_decisions log', async () => {
    const classify = vi.fn<ClassifyFn>(async () => ({ ok: true, classification: { docClass: 'lease', confidence: 0.95, summary: 'Lease with Redact Realty (SSN 123-45-6789, EIN 98-7654321).', counterparty: 'Redact Realty 98-7654321', companyName: null, keyDates: {}, amountCents: null, note: 'TIN 987654321' }, model: 'm', correlationId: null }));
    const extract = vi.fn<ExtractImpl>(async (kind, dd, args) => {
      const base = await leaseExtract(kind, dd, args);
      return base.ok ? { ...base, summary: 'Lessor EIN 98-7654321', payload: { ...base.payload, lessor_tin: '98-7654321', nested: { ssn: 'SSN: 123 45 6789' } } } : base;
    });
    const id = await addDoc(T.org, 'redact lease.pdf', makePdf([...LEASE_TEXT, 'Lessor taxpayer identification number: 98-7654321. Guarantor SSN 123-45-6789.']));
    await analyzeDocument(deps({ anthropicApiKey: 'sk-test', classify, extract }), { orgId: T.org, documentId: id, userId: 'user_1', source: 'center' });
    // The classifier got TEXT (not the PDF bytes), with the TINs masked.
    expect(classify).toHaveBeenCalledTimes(1);
    const sent = classify.mock.calls[0][1];
    expect(sent.base64).toBeNull();
    expect(sent.textSample).toContain('*****4321');
    expect(sent.textSample).toContain('*****6789');
    expect(sent.textSample).not.toMatch(/123-45-6789|98-7654321/);
    const blobs = await db.query<{ blob: string }>(
      `select row_to_json(i)::text blob from public.document_intelligence i where document_id = $1
       union all select row_to_json(p)::text from public.document_proposals p where document_id = $1
       union all select row_to_json(a)::text from public.ai_decisions a where org_id = $2 and (proposed_output->>'document_id') = $1::text`,
      [id, T.org],
    );
    expect(blobs.rows.length).toBeGreaterThanOrEqual(3);
    for (const b of blobs.rows) expect(b.blob).not.toMatch(/123-45-6789|98-7654321|987654321|123 45 6789/);
    const p = await db.query<{ payload: { lessor_tin: string }; summary: string }>(`select payload, summary from public.document_proposals where document_id = $1`, [id]);
    expect(p.rows[0].payload.lessor_tin).toBe('**-***4321');
    expect(p.rows[0].summary).toBe('Lessor EIN *****4321');
  });

  it('no module draft without the module gate / company scope; a system re-run keeps the refusal', async () => {
    const extract = vi.fn<ExtractImpl>(leaseExtract);
    const id = await addDoc(T.org, 'gated lease.pdf', makePdf([...LEASE_TEXT, 'gated copy']));
    const canDraft = vi.fn(async () => false);
    const r = await analyzeDocument(deps({ anthropicApiKey: 'sk-test', extract, classify: vi.fn<ClassifyFn>(async () => ({ ok: false, kind: 'failed', error: 'x' })) }), { orgId: T.org, documentId: id, userId: 'user_1', source: 'center', canDraft });
    expect(canDraft).toHaveBeenCalledWith('lease', r.intelligence?.location_id ?? null);
    expect(extract).not.toHaveBeenCalled();
    expect(r.proposals[0]).toMatchObject({ target_kind: 'lease', status: 'pending', extract_state: 'pending', last_error: needsAccessMessage('lease') });
    // The job (no authorizer) does not draft behind the refusal.
    await analyzeDocument(deps({ anthropicApiKey: 'sk-test', extract }), { orgId: T.org, documentId: id, userId: null, source: 'backfill', force: true });
    expect(extract).not.toHaveBeenCalled();
    // Someone with access re-reads it → the draft is made.
    await analyzeDocument(deps({ anthropicApiKey: 'sk-test', extract }), { orgId: T.org, documentId: id, userId: 'user_2', source: 'center', force: true, canDraft: async () => true });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("a vendor's genuine pending W-9 is never superseded by a stored document; this feature's own draft may be", async () => {
    const vendor = crypto.randomUUID();
    await db.query(`insert into core.vendors (id, org_id, name) values ($1, $2, 'Genuine Vendor Co')`, [vendor, T.org]);
    const genuine = crypto.randomUUID();
    await db.query(`insert into public.vendor_document_submissions (id, org_id, vendor_id, doc_kind, source, status) values ($1, $2, $3, 'W9', 'portal_upload', 'received')`, [genuine, T.org, vendor]);
    expect(await genuineOpenSubmission(svc, T.org, vendor, 'W9')).toBe(genuine);
    const docId = await addDoc(T.org, 'gv w9.pdf', makePdf(['x']));
    const out = await defaultNative.createVendorSubmission(svc, { orgId: T.org, userId: 'user_1', vendorId: vendor, docKind: 'W9', documentId: docId, base64: null, mediaType: 'application/pdf', anthropicApiKey: null });
    expect(out).toMatchObject({ ok: false, kind: 'needs_input' });
    const st = await db.query<{ status: string }>(`select status from public.vendor_document_submissions where id = $1`, [genuine]);
    expect(st.rows[0].status).toBe('received');
    // An open submission a document proposal lodged is "ours" → not genuine.
    await db.query(`update public.vendor_document_submissions set source = 'staff_upload' where id = $1`, [genuine]);
    await db.query(`insert into public.document_proposals (org_id, document_id, target_kind, mode, native_table, native_id) values ($1, $2, 'vendor_w9', 'native', 'vendor_document_submissions', $3)`, [T.org, docId, genuine]);
    expect(await genuineOpenSubmission(svc, T.org, vendor, 'W9')).toBeNull();
  });
});
