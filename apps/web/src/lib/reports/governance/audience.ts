/**
 * Governance audience — WHO is reading, resolved server-side from capabilities (never from
 * request input). FPB §18.2:
 *
 *   finance      holds journal_entries:create OR close_mgmt:manage
 *                (v2: gl.journal_entries:create, or gl.periods / close.checklist edit+approve)
 *                → bookkeeper, accounting manager, controller, finance director, CFO, admin
 *   non_finance  everyone else → owner template, department head, lender viewer, external
 *                auditor, view-only, client staff
 *
 * Release / withdraw / settings / coverage writes require close_mgmt:manage (`canRelease`).
 *
 * Both checks run through requirePermission → authorizeLegacyCell, so they follow the
 * tenant's enforcement mode (legacy / dual / v2) exactly like every other route.
 */

import type { GovernanceAudience } from './types';

/** A resolved audience. Only `resolveGovernanceAudience` (or a test probe) can mint one. */
export class ResolvedAudience {
  private constructor(
    readonly audience: GovernanceAudience,
    readonly canRelease: boolean,
  ) {}

  /** @internal — for the resolver and tests only. */
  static of(audience: GovernanceAudience, canRelease: boolean): ResolvedAudience {
    return new ResolvedAudience(audience, canRelease && audience === 'finance');
  }
}

export interface CapabilityProbe {
  /** Does the caller hold (feature, action)? Fails closed (false) on any error. */
  has(feature: 'journal_entries' | 'close_mgmt', action: 'create' | 'manage'): Promise<boolean>;
}

/** Default probe: the shared route guard (Clerk session + org + enforcement mode). */
export function permissionProbe(userId: string): CapabilityProbe {
  return {
    async has(feature, action) {
      try {
        const { requirePermission } = await import('@/lib/rbac/require-permission');
        const r = await requirePermission(userId, feature, action, { route: '/api/report-governance' });
        return r.ok;
      } catch {
        return false;
      }
    },
  };
}

export async function resolveGovernanceAudience(probe: CapabilityProbe): Promise<ResolvedAudience> {
  const [manage, createJe] = await Promise.all([probe.has('close_mgmt', 'manage'), probe.has('journal_entries', 'create')]);
  const finance = manage || createJe;
  return ResolvedAudience.of(finance ? 'finance' : 'non_finance', manage);
}
