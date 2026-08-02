/**
 * MeritProjects RBAC — permission model.
 *
 * Deliberately mirrors the Books identity vocabulary (`core.employees.role`,
 * normalized like Books' role-normalize) so a single membership drives authz in
 * BOTH modules — a `company_admin` in Books is a `company_admin` here. Projects
 * does not invent a parallel role set; it defines its OWN feature catalog (the
 * PM surfaces) and maps the shared roles onto it.
 *
 * Fail closed: an unknown/absent role has NO permissions. This is the layer the
 * security agent (session 43) flagged as missing on the money/approve routes.
 */

export type UserRole =
  | 'company_admin'
  | 'cfo'
  | 'merit_controller'
  | 'assistant_cfo'
  | 'accounting_manager'
  | 'accounting_specialist'
  | 'check_processor'
  | 'general_admin'
  | 'business_user';

export const ALL_ROLES: readonly UserRole[] = [
  'company_admin', 'cfo', 'merit_controller', 'assistant_cfo', 'accounting_manager',
  'accounting_specialist', 'check_processor', 'general_admin', 'business_user',
];

export type FeatureAction = 'view' | 'create' | 'edit' | 'approve';

/** The MeritProjects feature surfaces that carry authorization. */
export type ProjFeature =
  | 'proj_jobs'          // job records
  | 'proj_schedule'      // work orders / dispatch
  | 'proj_costs'         // cost review
  | 'proj_commitments'   // POs / subcontracts (create + approve = mint number)
  | 'proj_billing'       // draws / SOV / retainage (approve = EMIT money)
  | 'proj_contracts'     // set contract / progress
  | 'proj_gates';        // external permit/inspection gates (approve = advance)

const FEATURES: readonly ProjFeature[] = [
  'proj_jobs', 'proj_schedule', 'proj_costs', 'proj_commitments',
  'proj_billing', 'proj_contracts', 'proj_gates',
];

type Perm = Partial<Record<FeatureAction, boolean>>;
type RoleMatrix = Record<ProjFeature, Perm>;

const ALL: Perm = { view: true, create: true, edit: true, approve: true };
const CREATE: Perm = { view: true, create: true, edit: true, approve: false };
const VIEW: Perm = { view: true };
const NONE: Perm = {};

function matrix(over: Partial<Record<ProjFeature, Perm>>): RoleMatrix {
  return FEATURES.reduce((acc, f) => {
    acc[f] = over[f] ?? NONE;
    return acc;
  }, {} as RoleMatrix);
}

/**
 * Role → permission matrix. The five senior finance/ops roles are approvers on
 * every money/authority surface; the specialist creates but cannot approve
 * (separation of duties); business users see only; check_processor and the bare
 * general_admin have no PM authority.
 */
export const ROLE_MATRIX: Record<UserRole, RoleMatrix> = {
  company_admin: matrix({
    proj_jobs: ALL, proj_schedule: ALL, proj_costs: ALL, proj_commitments: ALL,
    proj_billing: ALL, proj_contracts: ALL, proj_gates: ALL,
  }),
  merit_controller: matrix({
    proj_jobs: ALL, proj_schedule: ALL, proj_costs: ALL, proj_commitments: ALL,
    proj_billing: ALL, proj_contracts: ALL, proj_gates: ALL,
  }),
  accounting_manager: matrix({
    proj_jobs: ALL, proj_schedule: ALL, proj_costs: ALL, proj_commitments: ALL,
    proj_billing: ALL, proj_contracts: ALL, proj_gates: ALL,
  }),
  assistant_cfo: matrix({
    proj_jobs: ALL, proj_schedule: ALL, proj_costs: ALL, proj_commitments: ALL,
    proj_billing: ALL, proj_contracts: ALL, proj_gates: ALL,
  }),
  cfo: matrix({
    // Financial oversight: full sign-off on billing/contracts, view the rest.
    proj_jobs: VIEW, proj_schedule: VIEW, proj_costs: VIEW,
    proj_commitments: { view: true, create: false, edit: false, approve: true },
    proj_billing: ALL, proj_contracts: ALL, proj_gates: VIEW,
  }),
  accounting_specialist: matrix({
    // Day-to-day: creates the work, cannot approve money.
    proj_jobs: CREATE, proj_schedule: CREATE, proj_costs: VIEW,
    proj_commitments: CREATE, proj_billing: CREATE, proj_contracts: CREATE,
    proj_gates: { view: true, create: true, edit: true, approve: false },
  }),
  general_admin: matrix({
    proj_jobs: VIEW, proj_schedule: { view: true, create: true, edit: true }, proj_costs: VIEW,
  }),
  business_user: matrix({
    proj_jobs: VIEW, proj_schedule: VIEW, proj_costs: VIEW,
    proj_commitments: VIEW, proj_billing: VIEW, proj_contracts: VIEW, proj_gates: VIEW,
  }),
  check_processor: matrix({}),
};

export function hasPermission(role: UserRole, feature: ProjFeature, action: FeatureAction): boolean {
  return ROLE_MATRIX[role]?.[feature]?.[action] === true;
}

/**
 * Normalize a raw `core.employees.role` value onto a Projects UserRole, or null
 * (= no authority, fail closed). Mirrors Books' normalizeMembershipRole: Clerk
 * owner/admin → company_admin; the canonical role names pass through; anything
 * else (incl. bare 'member') → null.
 */
const FULL_ADMIN: ReadonlySet<string> = new Set(['owner', 'admin', 'org_admin', 'company_admin']);

export function normalizeMembershipRole(raw: string | null | undefined): UserRole | null {
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/^org:/, '');
  if (key === '') return null;
  if (FULL_ADMIN.has(key)) return 'company_admin';
  if ((ALL_ROLES as readonly string[]).includes(key)) return key as UserRole;
  return null;
}
