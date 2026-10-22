import { describe, expect, it } from 'vitest';
// The package is the source of truth; apps/projects does not depend on it yet, so import by path.
import { PROJECT_ROLE_TEMPLATES } from '../../../../packages/projects-access/src/roles';
import { PROJECT_CAPABILITIES as PKG_CAPS } from '../../../../packages/projects-access/src/capabilities';
import { PERSONAS, PERSONA_RANK, PROJECT_CAPABILITIES } from '@/lib/access/types';
import { CAPABILITY_ACTIONS, PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';

describe('local template mirror == packages/projects-access', () => {
  it('same personas, same ranks', () => {
    expect(PROJECT_ROLE_TEMPLATES.map((t) => t.key).sort()).toEqual([...PERSONAS].sort());
    for (const t of PROJECT_ROLE_TEMPLATES) expect(PERSONA_RANK[t.key], t.key).toBe(t.rank);
  });

  it.each(PROJECT_ROLE_TEMPLATES.map((t) => [t.key, t]))('%s grants match', (_k, t) => {
    const pkg = t.grants.flatMap((g) => g.actions.map((a) => `${g.capability}:${a}`)).sort();
    expect([...PERSONA_TEMPLATE_GRANTS[t.key]].sort()).toEqual(pkg);
  });

  it('same capabilities and actions', () => {
    expect(PKG_CAPS.map((c) => c.key).sort()).toEqual([...PROJECT_CAPABILITIES].sort());
    for (const c of PKG_CAPS) expect([...CAPABILITY_ACTIONS[c.key]].sort(), c.key).toEqual([...c.actions].sort());
  });
});
