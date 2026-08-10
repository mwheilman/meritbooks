import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PostingFacts } from './posting-templates';

// Mock the GL post + the reversal so we can drive the provisioning ORCHESTRATION
// (safe-ordering) without a live database: post succeeds, subledger insert fails,
// and we assert the JE is reversed so no orphaned GL entry survives.
vi.mock('./posting-templates', () => ({
  postTransaction: vi.fn(),
}));
vi.mock('./lifecycle', () => ({
  reverseGlEntry: vi.fn(),
}));

import { recordAssetAcquisition } from './provisioning';
import { postTransaction } from './posting-templates';
import { reverseGlEntry } from './lifecycle';

const postMock = postTransaction as unknown as ReturnType<typeof vi.fn>;
const reverseMock = reverseGlEntry as unknown as ReturnType<typeof vi.fn>;

const facts: PostingFacts = {
  org_id: 'org-1',
  location_id: 'loc-1',
  entry_date: '2026-06-30',
  amount_cents: 500_000,
  category_account_id: 'asset-acct',
};

const acqInput = {
  facts,
  name: 'Forklift',
  useful_life_months: 60,
  depreciation_expense_account_id: 'dep-exp',
  accumulated_depreciation_account_id: 'accum',
};

/** DB whose fixed_assets insert resolves with the given {data,error}. */
function fixedAssetsInsertStub(result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => result }) }),
    }),
  } as unknown as SupabaseClient;
}

describe('recordAssetAcquisition — no orphaned GL on subledger failure', () => {
  beforeEach(() => {
    postMock.mockReset();
    reverseMock.mockReset();
    postMock.mockResolvedValue({ success: true, entry_id: 'je-1', entry_number: 'JE-1' });
  });

  it('reverses the JE when the fixed_assets insert fails (GL⇄register never drifts)', async () => {
    const db = fixedAssetsInsertStub({ data: null, error: { message: 'insert boom' } });
    const res = await recordAssetAcquisition(db, acqInput, { created_by: null });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/reversed/i);
    // The orphaned GL entry was reversed with the posted entry id.
    expect(reverseMock).toHaveBeenCalledTimes(1);
    expect(reverseMock).toHaveBeenCalledWith(db, 'org-1', 'je-1', expect.any(String));
  });

  it('does NOT reverse when the subledger row commits (both exist together)', async () => {
    const db = fixedAssetsInsertStub({ data: { id: 'fa-1' }, error: null });
    const res = await recordAssetAcquisition(db, acqInput, { created_by: null });

    expect(res.success).toBe(true);
    expect(res.provisioned_id).toBe('fa-1');
    expect(res.entry_id).toBe('je-1');
    expect(reverseMock).not.toHaveBeenCalled();
  });

  it('never inserts a subledger row when the GL post itself fails (nothing to orphan)', async () => {
    postMock.mockResolvedValue({ success: false, error: 'period closed' });
    const db = fixedAssetsInsertStub({ data: { id: 'fa-1' }, error: null });
    const res = await recordAssetAcquisition(db, acqInput, { created_by: null });

    expect(res.success).toBe(false);
    expect(res.error).toBe('period closed');
    expect(reverseMock).not.toHaveBeenCalled();
  });
});
