import { Building2, Layers, Landmark, type LucideIcon } from 'lucide-react';
import type { MeUser } from '@/lib/hooks/use-me';

/**
 * The three "planes" a MeritBooks user operates in — the fix for the conflated
 * single UI where it was unclear which hat you were wearing:
 *
 *  - platform  : MeritBooks OPERATOR. Provision tenants, licensing, entitlements,
 *                cross-tenant health. Only for platform staff. (Console is WIP.)
 *  - practice  : TENANT ADMIN / accounting leadership. Manage the team & access,
 *                clients/entities, org settings.
 *  - books     : BOOK OF RECORD. The day-to-day accounting for the entities —
 *                bank feed, bills, invoices, GL, reports.
 *
 * A plane is a lens over the navigation, not a separate app. The switcher sets
 * the active plane; the sidebar shows only that plane's sections.
 */
export type Plane = 'platform' | 'practice' | 'books';

export interface PlaneDef {
  id: Plane;
  label: string;
  tagline: string;
  icon: LucideIcon;
  /** nav group labels (from lib/navigation.ts) that belong to this plane */
  groups: string[];
}

export const PLANES: Record<Plane, PlaneDef> = {
  books: {
    id: 'books',
    label: 'Book of Record',
    tagline: 'Day-to-day accounting',
    icon: Landmark,
    groups: [
      'Home',
      'Payables',
      'Receivables',
      'Banking & Cash',
      'Accounting',
      'Reporting & Analytics',
      'Firm & Governance',
      'Settings & Admin',
    ],
  },
  practice: {
    id: 'practice',
    label: 'Practice',
    tagline: 'Team, clients & settings',
    icon: Layers,
    groups: ['Firm & Governance', 'Settings & Admin'],
  },
  platform: {
    id: 'platform',
    label: 'Platform',
    tagline: 'MeritBooks operator',
    icon: Building2,
    groups: ['Platform'],
  },
};

/** Order planes appear in the switcher (broadest hat last). */
export const PLANE_ORDER: Plane[] = ['books', 'practice', 'platform'];

/**
 * Which planes a given viewer may enter. Everyone gets Book of Record. Practice
 * requires the ability to administer the tenant (manage users / edit settings).
 * Platform requires the identity-layer platform-staff flag.
 */
export function availablePlanes(user: MeUser | null): Plane[] {
  const planes: Plane[] = ['books'];
  if (user?.canManageUsers || user?.canEditSystemSettings || user?.role === 'company_admin') {
    planes.push('practice');
  }
  if (user?.isPlatformStaff) {
    planes.push('platform');
  }
  return planes;
}

export function isPlaneAvailable(user: MeUser | null, plane: Plane): boolean {
  return availablePlanes(user).includes(plane);
}
