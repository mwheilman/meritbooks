/**
 * Wave 2G — the legacy role / override SoD checks fail CLOSED when the conflict catalog
 * can't be read (hard rules are always-on; an unchecked change is refused, not waved through).
 */
import { describe, it, expect } from 'vitest';
import { fakeSupabase } from '@/test/fake-supabase';
import { legacyOverrideSod, legacyRoleChangeSod } from './sod-store';

const broken = fakeSupabase((c) =>
  c.table === 'sod_rules' ? { data: null, error: { message: 'catalog unavailable' } } : { data: [], error: null });

describe('legacy SoD checks fail closed', () => {
  it('a role change is blocked when the rules cannot be read', async () => {
    const r = await legacyRoleChangeSod(broken.client, 'org1', 'accounting_specialist', 'company_admin');
    expect(r.unavailable).toBe(true);
    expect(r.blocked.length).toBeGreaterThan(0);
  });

  it('a permission grant override is blocked when the rules cannot be read', async () => {
    const r = await legacyOverrideSod(broken.client, 'org1', 'accounting_specialist', 'payments::run', true);
    expect(r.unavailable).toBe(true);
    expect(r.blocked.length).toBeGreaterThan(0);
  });

  it('a revoke override never needs the catalog', async () => {
    const r = await legacyOverrideSod(broken.client, 'org1', 'accounting_specialist', 'payments::run', false);
    expect(r).toEqual({ blocked: [], warnings: [] });
  });
});
