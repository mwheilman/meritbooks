import { describe, it, expect } from 'vitest';
import { MIGRATION_PERMISSIONS } from './guard';
import { FEATURE_CATALOG as FEATURES } from '@/lib/rbac/permissions';

describe('migration permissions ride real feature/actions until the onb.* keys land', () => {
  it('every action maps to an existing feature + action', () => {
    for (const [action, p] of Object.entries(MIGRATION_PERMISSIONS)) {
      const f = FEATURES.find((x) => x.id === p.feature);
      expect(f, `${action} → ${p.feature}`).toBeDefined();
      expect(f!.actions).toContain(p.action);
    }
  });
  it('signing off needs more than preparing (post vs create); voiding is a controller step', () => {
    expect(MIGRATION_PERMISSIONS.sign_proof).toEqual({ feature: 'journal_entries', action: 'create' });
    expect(MIGRATION_PERMISSIONS.sign_off).toEqual({ feature: 'journal_entries', action: 'post' });
    expect(MIGRATION_PERMISSIONS.void).toEqual({ feature: 'close_mgmt', action: 'manage' });
    expect(MIGRATION_PERMISSIONS.settle).toEqual({ feature: 'chart_of_accounts', action: 'approve' });
    expect(MIGRATION_PERMISSIONS.view.action).toBe('view');
  });
});
