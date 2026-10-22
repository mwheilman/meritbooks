import type { IconName } from '@meritbooks/merit-ui';
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
 * A plane is a lens over the navigation, not a separate app. The ⌘J context
 * switcher sets the active plane; the rail shows only that plane's groups. In the
 * merit-ui shell (Redesign R1) the planes map onto the IA-SPEC §3.1 contexts:
 * books → client books (one client) or the workspace (no client picked);
 * practice → the tenant workspace; platform → the platform console.
 */
export type Plane = 'platform' | 'practice' | 'books';

export interface PlaneDef {
  id: Plane;
  label: string;
  tagline: string;
  /** merit-ui sprite name for the switcher row. */
  icon: IconName;
  /** nav group labels (from lib/navigation.ts) that belong to this plane */
  groups: string[];
}

export const PLANES: Record<Plane, PlaneDef> = {
  books: {
    id: 'books',
    label: 'Books',
    tagline: 'Day-to-day accounting, one client at a time',
    icon: 'book',
    // Operational accounting for ONE client at a time. No team/governance surfaces —
    // those live in Practice. A supervisor sees a client's jobs/WIP by switching into
    // that client's books with the ⌘J context switcher.
    groups: [
      'Home',
      'Banking',
      'Payables',
      'Receivables',
      'Revenue & jobs',
      'Cash & debt',
      'Accounting',
      'Dealer', // industry pack — shown only when enabled for the active client
      'Planning & reports',
      'Controls',
    ],
  },
  practice: {
    id: 'practice',
    label: 'Team & settings',
    tagline: 'Clients, team, access and firm settings',
    icon: 'users',
    // The supervisor's cockpit: supervise the team & their access, monitor performance,
    // compliance/audit, and the roster of companies they oversee — plus firm settings.
    // Deliberately NO operational accounting (no WIP/jobs/tax) — that's Books.
    groups: ['Clients', 'Team', 'Oversight', 'Integrations', 'Settings'],
  },
  platform: {
    id: 'platform',
    label: 'Platform',
    tagline: 'Operator console',
    icon: 'grid',
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
