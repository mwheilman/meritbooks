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
    // Operational accounting for ONE company at a time. No team/governance surfaces —
    // those live in Practice. A supervisor sees a company's jobs/WIP by switching into
    // that company's Books via the header company picker.
    groups: [
      'Home',
      'Payables',
      'Receivables',
      'Banking & Cash',
      'Accounting',
      'Jobs & Costing',
      'Reporting & Analytics',
    ],
  },
  practice: {
    id: 'practice',
    label: 'Practice',
    tagline: 'Team, oversight & settings',
    icon: Layers,
    // The supervisor's cockpit: supervise the team & their access, monitor performance,
    // compliance/audit, and the roster of companies they oversee — plus firm settings.
    // Deliberately NO operational accounting (no WIP/jobs/tax) — that's Books.
    groups: ['Team & Oversight', 'Settings & Admin'],
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
/** Roles whose JOB is to supervise a team / firm, so they get the Practice plane even
 *  if they don't hold the raw canManageUsers flag (e.g. an Accounting Manager assigns
 *  company access for specialists and monitors their performance). Operational-only
 *  roles (accounting_specialist, check_processor, general_admin, business_user) do NOT
 *  get Practice — they only ever see the Book-of-Record plane. */
const PRACTICE_SUPERVISOR_ROLES: ReadonlyArray<NonNullable<MeUser['role']>> = [
  'company_admin',
  'cfo',
  'merit_controller',
  'assistant_cfo',
  'accounting_manager',
];

export function availablePlanes(user: MeUser | null): Plane[] {
  const planes: Plane[] = ['books'];
  const supervises =
    user?.canManageUsers ||
    user?.canManageUsersDelegated ||
    user?.canEditSystemSettings ||
    user?.canEditAccountingSettings ||
    (user?.role != null && PRACTICE_SUPERVISOR_ROLES.includes(user.role));
  if (supervises) {
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
