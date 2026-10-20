/**
 * Wave 2F — H6 at release (05 §4.1) wired into the approval engine: the preparer never
 * releases, the approver releases only in sole-approver mode, and the check runs BEFORE
 * the compare-and-set claim (so a blocked releaser never flips the row).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeSupabase, type FakeDb } from '@/test/fake-supabase';

const svc = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabase: () => svc.db }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminSupabase: () => svc.db }));

import { claimApprovalForRelease, markReleased } from './approvals';
import { SodViolationError } from '@/lib/rbac/sod';

function world(opts: { sole: boolean; prepared: string; approved: string | null }): FakeDb {
  return fakeSupabase((c) => {
    if (c.table === 'organizations') return { data: { tenant_type: 'company', sole_approver_mode: opts.sole, je_self_post_threshold_cents: null }, error: null };
    if (c.table === 'sod_rule_settings') return { data: [], error: null };
    if (c.table === 'approvals' && c.op === 'select') {
      return {
        data: {
          id: 'a1', org_id: 'org1', kind: 'AP_DISBURSEMENT', subject_table: 'bills', subject_id: 'b1', amount_cents: 100,
          status: 'APPROVED', prepared_by: opts.prepared, approved_by: opts.approved, released_by: null,
          provider_correlation_id: null, reject_reason: null,
        },
        error: null,
      };
    }
    if (c.table === 'approvals' && c.op === 'update') return { data: { id: 'a1' }, error: null };
    return { data: null, error: null };
  });
}

let w: FakeDb;
const updates = () => w.calls.filter((c) => c.table === 'approvals' && c.op === 'update');

describe('claimApprovalForRelease — SoD before the claim', () => {
  beforeEach(() => { w = world({ sole: false, prepared: 'prep', approved: 'appr' }); svc.db = w.client; });

  it('the approver cannot release (not sole-approver mode) — and nothing is claimed', async () => {
    const err = await claimApprovalForRelease(w.client, 'org1', 'a1', 'appr').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SodViolationError);
    expect((err as SodViolationError).code).toBe('APPROVER_CANNOT_RELEASE');
    expect(updates()).toEqual([]);
  });

  it('the preparer cannot release', async () => {
    const err = await claimApprovalForRelease(w.client, 'org1', 'a1', 'prep', { preparedBy: 'prep', approvedBy: 'appr' }).catch((e: unknown) => e);
    expect((err as SodViolationError).code).toBe('PREPARER_CANNOT_RELEASE');
    expect(updates()).toEqual([]);
  });

  it('a third person claims normally (the approval is read once for its payee)', async () => {
    expect(await claimApprovalForRelease(w.client, 'org1', 'a1', 'rel', { preparedBy: 'prep', approvedBy: 'appr' })).toBe('CLAIMED');
    // Wave 2G: the claim reads the approval (service role) to find the payee for the
    // bank-detail-change rule; passed parties still win over the stored ones.
    expect(w.calls.filter((c) => c.table === 'approvals' && c.op === 'select')).toHaveLength(1);
    expect(w.calls.some((c) => c.table === 'bills' && c.op === 'select')).toBe(true);
    expect(updates()).toHaveLength(1);
  });

  it('sole-approver mode lets the approver release (never the preparer)', async () => {
    w = world({ sole: true, prepared: 'prep', approved: 'appr' });
    svc.db = w.client;
    expect(await claimApprovalForRelease(w.client, 'org1', 'a1', 'appr')).toBe('CLAIMED');
    const err = await claimApprovalForRelease(w.client, 'org1', 'a1', 'prep').catch((e: unknown) => e);
    expect((err as SodViolationError).code).toBe('PREPARER_CANNOT_RELEASE');
  });
});

describe('claimApprovalForRelease — H6_BANK_CHANGE_RELEASE', () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  function bankWorld(profile: Record<string, unknown> | null, opts: { profileError?: boolean } = {}): FakeDb {
    return fakeSupabase((c) => {
      if (c.table === 'bills') return { data: { vendor_id: 'v1' }, error: null };
      if (c.table === 'vendor_payment_profiles') {
        return opts.profileError ? { data: null, error: { message: 'boom' } } : { data: profile, error: null };
      }
      if (c.table === 'organizations') return { data: { tenant_type: 'company', sole_approver_mode: false, je_self_post_threshold_cents: null }, error: null };
      if (c.table === 'sod_rule_settings') return { data: [], error: null };
      if (c.table === 'approvals' && c.op === 'select') {
        return { data: { kind: 'AP_DISBURSEMENT', subject_table: 'bills', subject_id: 'b1', prepared_by: 'prep', approved_by: 'appr' }, error: null };
      }
      if (c.table === 'approvals' && c.op === 'update') return { data: { id: 'a1' }, error: null };
      return { data: null, error: null };
    });
  }

  it('whoever captured the payee bank details in the last 10 days cannot release to it', async () => {
    w = bankWorld({ vendor_id: 'v1', captured_by: 'rel', captured_at: daysAgo(3), updated_at: daysAgo(3) });
    svc.db = w.client;
    const err = await claimApprovalForRelease(w.client, 'org1', 'a1', 'rel').catch((e: unknown) => e);
    expect((err as SodViolationError).code).toBe('RECENT_BANK_DETAIL_CHANGE');
    expect(updates()).toEqual([]);
  });

  it('after 10 days — or for anyone else — the release proceeds', async () => {
    w = bankWorld({ vendor_id: 'v1', captured_by: 'rel', captured_at: daysAgo(30), updated_at: daysAgo(11) });
    svc.db = w.client;
    expect(await claimApprovalForRelease(w.client, 'org1', 'a1', 'rel')).toBe('CLAIMED');
    w = bankWorld({ vendor_id: 'v1', captured_by: 'someone_else', captured_at: daysAgo(1), updated_at: daysAgo(1) });
    svc.db = w.client;
    expect(await claimApprovalForRelease(w.client, 'org1', 'a1', 'rel')).toBe('CLAIMED');
  });

  it('a later approver of the bank details is covered too (changed_by / approved_by columns)', async () => {
    w = bankWorld({ vendor_id: 'v1', captured_by: 'x', captured_at: daysAgo(40), approved_by: 'rel', approved_at: daysAgo(2) });
    svc.db = w.client;
    const err = await claimApprovalForRelease(w.client, 'org1', 'a1', 'rel').catch((e: unknown) => e);
    expect((err as SodViolationError).code).toBe('RECENT_BANK_DETAIL_CHANGE');
  });

  it('fails closed when the bank details cannot be read', async () => {
    w = bankWorld(null, { profileError: true });
    svc.db = w.client;
    await expect(claimApprovalForRelease(w.client, 'org1', 'a1', 'rel')).rejects.toThrow(/bank details/);
    expect(updates()).toEqual([]);
  });
});

describe('markReleased — same rule', () => {
  beforeEach(() => { w = world({ sole: false, prepared: 'prep', approved: 'appr' }); svc.db = w.client; });

  it('refuses the approver, allows a third person', async () => {
    await expect(markReleased(w.client, 'org1', 'a1', 'appr', 'corr-1')).rejects.toBeInstanceOf(SodViolationError);
    expect(updates()).toEqual([]);
    const a = await markReleased(w.client, 'org1', 'a1', 'rel', 'corr-1');
    expect(a.status).toBe('RELEASED');
  });
});
