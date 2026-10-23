/** Security review LOW — marking an invoice disputed cancels the reminders already queued. */
import { describe, it, expect } from 'vitest';
import { fakeSupabase, filterValue, type FakeCall, type FakeResp } from '@/test/fake-supabase';
import { cancelDunningForInvoice } from './dunning-requests';

const ok = (data: unknown): FakeResp => ({ data, error: null });

describe('cancelDunningForInvoice', () => {
  it('cancels every live dunning request for the invoice (and only those), org pinned', async () => {
    const d = fakeSupabase((c: FakeCall) => {
      if (c.table === 'requests' && c.op === 'select') return ok([{ id: 'r1' }, { id: 'r2' }]);
      if (c.table === 'requests' && c.op === 'update') {
        const id = filterValue(c, 'id') as string;
        return ok([{ id, org_id: 'org', kind: 'dunning', subject_type: 'invoice', subject_id: 'inv1', status: 'cancelled', location_id: null, meta: {} }]);
      }
      return ok([]);
    });
    const n = await cancelDunningForInvoice(d.client, 'org', 'inv1', 'user_1', 'Invoice INV-1 marked disputed.');
    expect(n).toBe(2);
    const read = d.calls.find((c) => c.table === 'requests' && c.op === 'select');
    expect(filterValue(read!, 'org_id')).toBe('org');
    expect(filterValue(read!, 'kind')).toBe('dunning');
    expect(filterValue(read!, 'subject_id')).toBe('inv1');
    expect(filterValue(read!, 'status')).toEqual(['open', 'sent', 'snoozed']);
    const updates = d.calls.filter((c) => c.table === 'requests' && c.op === 'update');
    expect(updates).toHaveLength(2);
    expect(updates[0].payload).toMatchObject({ status: 'cancelled', next_send_at: null, cancelled_by: 'user_1' });
  });

  it('a reminder that closed in the meantime is not an error', async () => {
    const d = fakeSupabase((c: FakeCall) => {
      if (c.table === 'requests' && c.op === 'select') return ok([{ id: 'r1' }]);
      if (c.table === 'requests' && c.op === 'update') return ok([]); // no live row matched → 409 inside
      return ok([]);
    });
    expect(await cancelDunningForInvoice(d.client, 'org', 'inv1', 'u', 'disputed')).toBe(0);
  });
});
