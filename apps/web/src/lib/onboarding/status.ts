/**
 * First-run onboarding STATUS — server-side detection + progress persistence.
 *
 * The unified inaugural wizard (`/onboarding`) needs to know two things:
 *   1. Is this tenant on its FIRST RUN? — i.e. has it never established its book
 *      of record. The canonical signal (per the task brief) is "no go-live /
 *      opening entry (or an explicit flag)". A tenant with ANY posted GL activity
 *      is, by definition, already live and is NOT first-run — this is what keeps
 *      an established tenant (seeded, imported, or long-running) from ever being
 *      bounced back into the wizard.
 *   2. Where did they leave off, so the wizard can resume.
 *
 * PERSISTENCE IS DEGRADE-SAFE. A durable "current step / complete" flag ideally
 * lives in a dedicated column — see the REPORTED migration below. Until that
 * column exists this module still works:
 *   - It ALWAYS persists completion on the always-present `setup_complete` column,
 *     so "finished onboarding" survives even without the new column.
 *   - It attempts to read/write `core.organizations.onboarding_state` (jsonb) for
 *     the richer step memory, and silently degrades (statePersisted=false) when the
 *     column is absent — the wizard still runs, it just can't remember the exact
 *     step across reloads (it re-derives a sensible step from live counts instead).
 *
 * ── REPORTED MIGRATION (for the lead — this module is written to light up the
 *    moment it lands, no code change needed) ──────────────────────────────────
 *      alter table core.organizations
 *        add column if not exists onboarding_state jsonb not null default '{}'::jsonb;
 *    Shape written by this module:
 *      { "currentStep": "opening", "complete": false, "updatedAt": "<iso>" }
 *    (An `onboarding_progress` side-table would also work; a single jsonb column on
 *    the org is the lightest option and inherits the org row's RLS.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The ordered steps of the unified onboarding wizard. */
export type OnboardingStepKey = 'welcome' | 'coa' | 'opening' | 'bank' | 'erp' | 'team' | 'launch';

export const ONBOARDING_STEPS: OnboardingStepKey[] = [
  'welcome',
  'coa',
  'opening',
  'bank',
  'erp',
  'team',
  'launch',
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-section status map (Wave-0 foundation for the SectionDefinition framework).
//
// The onboarding shell is being generalized so every setup DOMAIN (company, chart
// of accounts, opening balances, bank, integrations, team, and — in later waves —
// AR/AP, debt, leases, jobs/WIP, …) is a self-describing section. Each section has
// a lifecycle status persisted here, alongside the flow's currentStep/complete
// flags, inside the SAME `core.organizations.onboarding_state` jsonb column (no new
// migration — the column already exists). This only WIDENS the shape the normalizer
// reads/writes; it stays degrade-safe exactly like the flow flags do.
//
// IMPORTANT: the persisted section status is a HINT, not the truth. `deriveStatus`
// in the section registry always lets a live-count-derived `done` win over stale
// stored state — so a section that is actually satisfied (e.g. a company exists)
// reads `done` even if the map was never written.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The domain sections the shell renders (the flow's `launch` step is terminal, not a
 * domain). The first six are the inaugural WIZARD FLOW steps; the remainder are the
 * optional long-tail Setup-Home domains (AR/AP, jobs/WIP, debt, leases, fixed assets,
 * equity). All are listed here so `normalizeSections` PRESERVES a persisted section /
 * detection hint written under any of these keys (a key not in this list would be
 * silently stripped on read).
 */
export const SECTION_KEYS = [
  'welcome', 'coa', 'opening', 'bank', 'erp', 'team',
  // Long-tail Setup-Home domains (Wave-1) — registered on the board, not the flow.
  'customers_ar', 'vendors_ap', 'jobs_wip', 'debt', 'leases', 'fixed_assets', 'equity',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** The lifecycle status of a single section. */
export const SECTION_STATUS_VALUES = ['not_started', 'in_progress', 'done', 'skipped', 'n_a'] as const;
export type SectionStatusValue = (typeof SECTION_STATUS_VALUES)[number];

/** One entry in the persisted per-section status map. */
export interface SectionStateEntry {
  status: SectionStatusValue;
  /** ISO timestamp of the last transition. */
  updatedAt: string;
  /** Clerk user id that made the transition, when known. */
  updatedBy?: string;
  /** The staged proposal (ai_decisions row) this status refers to, when relevant. */
  proposalId?: string;
}

/** The persisted per-section status map, keyed by section key. */
export type SectionStatusMap = Partial<Record<SectionKey, SectionStateEntry>>;

/** Live tenant counts that drive first-run detection and step derivation. */
export interface OnboardingCounts {
  entities: number;
  accounts: number;
  teamMembers: number;
  glEntries: number;
  /** Active bank accounts linked (Plaid or manual) — the "bank connected" signal. */
  bankAccounts: number;
  /** Bank-feed transactions that have been categorized/approved — "first transaction categorized". */
  categorizedTransactions: number;
  // ── Long-tail Setup-Home domain live counts (Wave-1). Each drives a board card's
  //    done/detected derivation; all degrade to 0 when the table/count is unavailable.
  /** Customer master rows (core.customers). */
  customers: number;
  /** Open trade receivables (invoices not paid/void/draft). Foots to the A/R control. */
  openArInvoices: number;
  /** Vendor master rows (core.vendors). */
  vendors: number;
  /** Open trade payables (bills not paid/void). Foots to the A/P control. */
  openApBills: number;
  /** Active debt instruments (loans). */
  debts: number;
  /** Lease agreements (ASC 842). */
  leases: number;
  /** Active fixed-asset records. */
  fixedAssets: number;
  /** Cap-table holders (core.equity_holders). */
  equityHolders: number;
}

/** The (best-effort) durable progress flag stored on the org. */
export interface OnboardingStateFlag {
  currentStep?: OnboardingStepKey;
  complete?: boolean;
  updatedAt?: string;
  /** Per-section lifecycle status (Wave-0 widening; absent on legacy rows). */
  sections?: SectionStatusMap;
  /** Per-COMPANY explicit choices, keyed by core.locations.id (W2 widening). */
  companies?: CompanyStateMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-company first-run (W2 — FPB-onboarding §2 principle 7, §4 B6).
//
// "First run" is a property of each COMPANY, not of the org: a company is LIVE once
// its opening balances are POSTED or its owner EXPLICITLY chose "Start fresh with no
// history". The only explicit choice we persist is that start-fresh; "posted" is
// always read back from the ledger (never trusted from a flag). The choice lives in
// the same `core.organizations.onboarding_state` jsonb (no migration), under
// `companies[<locationId>]`.
//
// GRANDFATHERING (keeps established tenants out of the wizard): in an org that was
// already established before per-company tracking (setup_complete / complete flag),
// a company that already has POSTED ledger activity is a live book of record even
// without an OPENING_BALANCE entry (seeded / imported / long-running books).
// ─────────────────────────────────────────────────────────────────────────────

/** The explicit per-company opening choice. `none` records an undo of `fresh`. */
export type CompanyOpeningChoice = 'fresh' | 'none';

/** One persisted per-company entry. */
export interface CompanyStateEntry {
  opening: CompanyOpeningChoice;
  updatedAt: string;
  updatedBy?: string;
}

/** Persisted per-company choices, keyed by location id. */
export type CompanyStateMap = Record<string, CompanyStateEntry>;

/** The honest opening-balance state of one company, as shown in the wizard. */
export type CompanyOpeningState = 'not_started' | 'started_fresh' | 'posted';

/** One company's onboarding picture. */
export interface CompanyOnboarding {
  id: string;
  name: string;
  shortCode: string;
  createdAt: string | null;
  opening: CompanyOpeningState;
  /** Has any POSTED ledger activity. */
  hasActivity: boolean;
  /** Live = opening posted OR start-fresh chosen OR grandfathered (see above). */
  live: boolean;
}

/** Inputs for the pure liveness rule. */
export interface CompanyLivenessInput {
  openingPosted: boolean;
  startedFresh: boolean;
  hasActivity: boolean;
  /** The org was established before per-company tracking (grandfathering applies). */
  legacyEstablished: boolean;
}

/** The honest opening state. A posted entry always wins over a start-fresh choice. */
export function companyOpeningState(i: Pick<CompanyLivenessInput, 'openingPosted' | 'startedFresh'>): CompanyOpeningState {
  if (i.openingPosted) return 'posted';
  if (i.startedFresh) return 'started_fresh';
  return 'not_started';
}

/** Pure per-company liveness rule. */
export function isCompanyLive(i: CompanyLivenessInput): boolean {
  if (i.openingPosted || i.startedFresh) return true;
  return i.legacyEstablished && i.hasActivity;
}

/** How long a not-live company in an ESTABLISHED org still pulls the router into
 *  onboarding. Older dormant entities (no books, never chosen) never bounce a
 *  returning admin; a newly-added company does. */
export const NEW_COMPANY_WINDOW_DAYS = 30;

/**
 * Should the root router send this tenant into onboarding? Pure.
 *  - No companies yet → yes (the first thing to do is create one).
 *  - Not established → yes when any company is not live (first run).
 *  - Established → only when a not-live company was added recently (a dormant
 *    legacy entity never traps an established tenant in the wizard).
 */
export function needsOnboarding(
  companies: Pick<CompanyOnboarding, 'live' | 'createdAt'>[],
  legacyEstablished: boolean,
  now: Date = new Date(),
): boolean {
  if (companies.length === 0) return true;
  const pending = companies.filter((c) => !c.live);
  if (pending.length === 0) return false;
  if (!legacyEstablished) return true;
  const windowMs = NEW_COMPANY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return pending.some((c) => {
    if (!c.createdAt) return false;
    const t = new Date(c.createdAt).getTime();
    return Number.isFinite(t) && now.getTime() - t <= windowMs;
  });
}

/** Coerce an unknown jsonb value into a typed per-company map (defensive, total). */
export function normalizeCompanies(raw: unknown): CompanyStateMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: CompanyStateMap = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.opening !== 'fresh' && e.opening !== 'none') continue;
    const normalized: CompanyStateEntry = {
      opening: e.opening,
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString(),
    };
    if (typeof e.updatedBy === 'string') normalized.updatedBy = e.updatedBy;
    out[id] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A best-effort "does at least one row exist" probe. Never throws; errors → false. */
async function safeExists(
  q: PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<boolean> {
  try {
    const { data, error } = await q;
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Raw per-company ledger facts (read from the DB; never from a flag). */
export interface CompanyProbe {
  id: string;
  name: string;
  shortCode: string;
  createdAt: string | null;
  hasActivity: boolean;
  openingPosted: boolean;
}

/**
 * Probe every active company's ledger facts for an org. `db` may be the RLS-scoped
 * client or the admin client — every query is ALSO filtered by `org_id` explicitly,
 * so it is correct either way. Cheap: one locations read, then per company one
 * indexed limit-1 probe on gl_entries(org_id, location_id), plus a second limit-1
 * opening probe only for companies that have activity. Never throws.
 */
export async function probeCompanies(db: SupabaseClient, orgId: string): Promise<CompanyProbe[]> {
  let rows: Array<{ id: string; name: string | null; short_code: string | null; created_at: string | null }> = [];
  try {
    const { data, error } = await db
      .schema('core')
      .from('locations')
      .select('id, name, short_code, created_at')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('name');
    if (error || !data) return [];
    rows = data as typeof rows;
  } catch {
    return [];
  }

  return Promise.all(rows.map(async (r) => {
    const hasActivity = await safeExists(
      db.from('gl_entries').select('id').eq('org_id', orgId).eq('location_id', r.id).eq('status', 'POSTED').limit(1),
    );
    const openingPosted = hasActivity
      ? await safeExists(
        db.from('gl_entries').select('id')
          .eq('org_id', orgId).eq('location_id', r.id)
          .eq('source_module', 'OPENING_BALANCE').eq('status', 'POSTED').limit(1),
      )
      : false;
    return {
      id: r.id,
      name: r.name ?? 'Company',
      shortCode: r.short_code ?? '',
      createdAt: r.created_at,
      hasActivity,
      openingPosted,
    };
  }));
}

/** Combine ledger probes + persisted choices into the per-company picture. Pure. */
export function buildCompanyOnboarding(
  probes: CompanyProbe[],
  choices: CompanyStateMap | undefined,
  established: boolean,
): CompanyOnboarding[] {
  return probes.map((p) => {
    const input: CompanyLivenessInput = {
      openingPosted: p.openingPosted,
      startedFresh: choices?.[p.id]?.opening === 'fresh',
      hasActivity: p.hasActivity,
      legacyEstablished: established,
    };
    return {
      id: p.id,
      name: p.name,
      shortCode: p.shortCode,
      createdAt: p.createdAt,
      opening: companyOpeningState(input),
      hasActivity: p.hasActivity,
      live: isCompanyLive(input),
    };
  });
}

/**
 * Was this org already ESTABLISHED (so grandfathering applies)? The always-present
 * `setup_complete` flag, an explicit `complete` flag, or real posted ledger activity
 * anywhere in the org (seeded / imported tenants may never have set either flag).
 * Pure.
 */
export function isLegacyEstablished(
  setupComplete: boolean,
  flag: OnboardingStateFlag | null,
  orgHasPostedActivity = false,
): boolean {
  return setupComplete || flag?.complete === true || orgHasPostedActivity;
}

/**
 * The root router's status read: org flags + per-company liveness. Returns whether
 * the caller should be sent into onboarding. Degrade-safe: any failure resolves to
 * "not needed" (never trap a user in the wizard).
 */
export async function loadRouterOnboarding(
  db: SupabaseClient,
  admin: SupabaseClient,
  orgId: string,
): Promise<{ needsOnboarding: boolean; companies: CompanyOnboarding[] }> {
  try {
    const [{ setupComplete, flag }, probes] = await Promise.all([
      readOrgOnboarding(admin, orgId),
      probeCompanies(db, orgId),
    ]);
    const established = isLegacyEstablished(setupComplete, flag, probes.some((p) => p.hasActivity));
    const companies = buildCompanyOnboarding(probes, flag?.companies, established);
    return { needsOnboarding: needsOnboarding(companies, established), companies };
  } catch {
    return { needsOnboarding: false, companies: [] };
  }
}

export interface OnboardingStatus {
  /** True while onboarding still has work: no company yet, or (per company) a company
   *  that is not live — see `needsOnboarding`. */
  firstRun: boolean;
  /** The inverse of firstRun: every company is live (posted / started fresh / grandfathered). */
  complete: boolean;
  /** Per-company onboarding picture (W2). Optional so hand-built fixtures still type. */
  companies?: CompanyOnboarding[];
  /** The org was established before per-company tracking (grandfathering applies). */
  legacyEstablished?: boolean;
  /** The step the wizard should open on (saved flag wins; else derived from counts). */
  currentStep: OnboardingStepKey;
  counts: OnboardingCounts;
  /** True when at least one balanced OPENING_BALANCE entry has been posted (go-live). */
  hasOpeningEntry: boolean;
  /** The always-present org provisioning flag. */
  setupComplete: boolean;
  /** True when the richer onboarding_state column is available (see migration note). */
  statePersisted: boolean;
  /** The stored flag, when the column exists. */
  flag: OnboardingStateFlag | null;
  /** The persisted per-section status map (empty when unset/absent). Derived `done`
   *  from live counts still wins over any stale value here — see the registry. */
  sections: SectionStatusMap;
  /**
   * The distinct revenue-recognition methods in use across this tenant's companies
   * (core.locations.rev_rec_method). Used by the Jobs/WIP section's n/a gate: WIP only
   * applies to a %-completion method. Undefined when unavailable — the WIP section then
   * stays visible (the import route still enforces applicability). */
  revRecMethods?: string[];
}

/** Read the org-level onboarding flags, degrading when the jsonb column is absent. */
async function readOrgOnboarding(
  admin: SupabaseClient,
  orgId: string,
): Promise<{ setupComplete: boolean; flag: OnboardingStateFlag | null; statePersisted: boolean }> {
  // Try the rich read first (setup_complete + onboarding_state).
  const rich = await admin
    .schema('core')
    .from('organizations')
    .select('setup_complete, onboarding_state')
    .eq('id', orgId)
    .maybeSingle();

  if (!rich.error && rich.data) {
    const row = rich.data as { setup_complete: boolean | null; onboarding_state: unknown };
    const flag = normalizeFlag(row.onboarding_state);
    return { setupComplete: row.setup_complete === true, flag, statePersisted: true };
  }

  // Column absent (or select failed) → degrade to the always-present column only.
  const basic = await admin
    .schema('core')
    .from('organizations')
    .select('setup_complete')
    .eq('id', orgId)
    .maybeSingle();

  const setupComplete = !basic.error && basic.data
    ? (basic.data as { setup_complete: boolean | null }).setup_complete === true
    : false;

  return { setupComplete, flag: null, statePersisted: false };
}

/** Coerce an unknown jsonb value into a typed flag (defensive — never throws). */
function normalizeFlag(raw: unknown): OnboardingStateFlag | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const step = obj.currentStep;
  const flag: OnboardingStateFlag = {};
  if (typeof step === 'string' && (ONBOARDING_STEPS as string[]).includes(step)) {
    flag.currentStep = step as OnboardingStepKey;
  }
  if (typeof obj.complete === 'boolean') flag.complete = obj.complete;
  if (typeof obj.updatedAt === 'string') flag.updatedAt = obj.updatedAt;
  const sections = normalizeSections(obj.sections);
  if (sections) flag.sections = sections;
  const companies = normalizeCompanies(obj.companies);
  if (companies) flag.companies = companies;
  return flag;
}

/**
 * Coerce an unknown jsonb value into a typed per-section status map. Unknown section
 * keys and unknown status values are dropped rather than trusted, so a malformed or
 * future-shaped blob can never corrupt the map or throw. Returns undefined when there
 * is nothing valid to keep.
 */
export function normalizeSections(raw: unknown): SectionStatusMap | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const out: SectionStatusMap = {};
  for (const key of SECTION_KEYS) {
    const entry = src[key];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.status !== 'string' || !(SECTION_STATUS_VALUES as readonly string[]).includes(e.status)) continue;
    const normalized: SectionStateEntry = {
      status: e.status as SectionStatusValue,
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString(),
    };
    if (typeof e.updatedBy === 'string') normalized.updatedBy = e.updatedBy;
    if (typeof e.proposalId === 'string') normalized.proposalId = e.proposalId;
    out[key] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A best-effort head-count that returns 0 on any error (status must never throw). */
async function safeCount(
  q: PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number> {
  try {
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Assemble the full onboarding status for a tenant.
 *
 * `supabase` is the RLS-scoped request client (counts are org-isolated by RLS);
 * `admin` reads the org flags (org row is service-role-write only for onboarding_state).
 */
export async function loadOnboardingStatus(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  orgId: string,
): Promise<OnboardingStatus> {
  const [entities, accounts, teamMembers, glEntries, openingCount, bankAccounts, categorizedTransactions] = await Promise.all([
    safeCount(
      supabase.schema('core').from('locations').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ),
    safeCount(supabase.from('accounts').select('id', { count: 'exact', head: true })),
    safeCount(supabase.schema('core').from('employees').select('id', { count: 'exact', head: true })),
    safeCount(supabase.from('gl_entries').select('id', { count: 'exact', head: true })),
    safeCount(
      supabase.from('gl_entries').select('id', { count: 'exact', head: true }).eq('source_module', 'OPENING_BALANCE'),
    ),
    safeCount(
      supabase.from('bank_accounts').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ),
    // A transaction the customer (or AI, once approved) has categorized: status has
    // advanced past PENDING (CATEGORIZED/APPROVED/POSTED are all "handled").
    safeCount(
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true }).neq('status', 'PENDING'),
    ),
  ]);

  // Long-tail Setup-Home domain counts — all RLS-scoped and degrade-safe (a missing
  // table/count yields 0, never throws, so the board simply shows "add later"). Schemas
  // per the migrations: customers/vendors/equity_holders live in `core`; invoices/bills/
  // debt_instruments/leases/fixed_assets in `public`.
  const [customers, openArInvoices, vendors, openApBills, debts, leasesCount, fixedAssets, equityHolders] = await Promise.all([
    safeCount(supabase.schema('core').from('customers').select('id', { count: 'exact', head: true })),
    safeCount(
      supabase.from('invoices').select('id', { count: 'exact', head: true })
        .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
    ),
    safeCount(supabase.schema('core').from('vendors').select('id', { count: 'exact', head: true })),
    safeCount(
      supabase.from('bills').select('id', { count: 'exact', head: true })
        .in('status', ['PENDING', 'APPROVED', 'PARTIALLY_PAID', 'ON_HOLD']),
    ),
    safeCount(
      supabase.from('debt_instruments').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
    ),
    safeCount(supabase.from('leases').select('id', { count: 'exact', head: true })),
    safeCount(
      supabase.from('fixed_assets').select('id', { count: 'exact', head: true }).eq('status', 'ACTIVE'),
    ),
    safeCount(supabase.schema('core').from('equity_holders').select('id', { count: 'exact', head: true })),
  ]);

  const counts: OnboardingCounts = {
    entities, accounts, teamMembers, glEntries, bankAccounts, categorizedTransactions,
    customers, openArInvoices, vendors, openApBills,
    debts, leases: leasesCount, fixedAssets, equityHolders,
  };
  const hasOpeningEntry = openingCount > 0;

  // Distinct rev-rec methods across the tenant's companies (drives the WIP n/a gate).
  const revRecMethods = await safeRevRecMethods(supabase);

  const [{ setupComplete, flag, statePersisted }, probes] = await Promise.all([
    readOrgOnboarding(admin, orgId),
    probeCompanies(supabase, orgId),
  ]);

  // PER-COMPANY first run (W2). A company is live once its opening balances are
  // posted or its owner explicitly chose "start fresh"; an ESTABLISHED org's
  // companies with real posted activity are grandfathered live. `firstRun` is the
  // router predicate; `complete` means every company is live.
  const established = isLegacyEstablished(
    setupComplete, flag, glEntries > 0 || probes.some((p) => p.hasActivity),
  );
  const companies = buildCompanyOnboarding(probes, flag?.companies, established);
  const firstRun = needsOnboarding(companies, established);
  const complete = companies.length > 0 && companies.every((c) => c.live);

  const currentStep = flag?.currentStep ?? deriveStep(counts, hasOpeningEntry);
  const sections = honestSections(flag?.sections ?? {}, companies);

  return {
    firstRun, complete, currentStep, counts, hasOpeningEntry, setupComplete,
    statePersisted, flag, sections, companies, legacyEstablished: established,
    ...(revRecMethods ? { revRecMethods } : {}),
  };
}

/**
 * Best-effort distinct rev-rec methods across the tenant's companies. RLS-scoped,
 * degrade-safe: any error (missing column/table) yields undefined so the WIP section
 * stays visible and the import route governs applicability. Never throws.
 */
async function safeRevRecMethods(supabase: SupabaseClient): Promise<string[] | undefined> {
  try {
    const { data, error } = await supabase.schema('core').from('locations').select('rev_rec_method');
    if (error || !data) return undefined;
    const set = new Set<string>();
    for (const row of data as Array<{ rev_rec_method: string | null }>) {
      if (row.rev_rec_method) set.add(String(row.rev_rec_method));
    }
    return set.size > 0 ? [...set] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make the org-level `opening` section hint HONEST against the per-company truth
 * (FPB §2 principle 7 — skipped is never shown as done, and a stale "skipped" from a
 * source-picker click can never satisfy the go-live gate). Pure.
 *  - Every company live and at least one started fresh → `skipped` (an explicit
 *    clean start; a posted entry still drives `done` via hasOpeningEntry).
 *  - Otherwise a stored `skipped`/`n_a` is dropped (some company has neither posted
 *    balances nor an explicit start-fresh choice), falling back to `in_progress`
 *    when some company has made progress.
 */
export function honestSections(stored: SectionStatusMap, companies: CompanyOnboarding[]): SectionStatusMap {
  if (companies.length === 0) return stored;
  const out: SectionStatusMap = { ...stored };
  const allLive = companies.every((c) => c.live);
  const anyFresh = companies.some((c) => c.opening === 'started_fresh');
  const anyProgress = companies.some((c) => c.opening !== 'not_started');
  const prev = stored.opening;
  if (allLive && anyFresh) {
    out.opening = { status: 'skipped', updatedAt: prev?.updatedAt ?? new Date(0).toISOString(), ...(prev?.updatedBy ? { updatedBy: prev.updatedBy } : {}) };
  } else if (!allLive && (prev?.status === 'skipped' || prev?.status === 'n_a' || prev?.status === 'done')) {
    if (anyProgress) out.opening = { status: 'in_progress', updatedAt: prev.updatedAt };
    else delete out.opening;
  }
  return out;
}

/** Derive a sensible resume step from live tenant state (used when no flag is stored). */
export function deriveStep(counts: OnboardingCounts, hasOpeningEntry: boolean): OnboardingStepKey {
  if (counts.entities === 0) return 'welcome';
  if (counts.accounts === 0) return 'coa';
  if (!hasOpeningEntry) return 'opening';
  return 'launch';
}

/** A patch applied to the persisted onboarding state. */
export interface OnboardingProgressPatch {
  currentStep?: OnboardingStepKey;
  complete?: boolean;
  /** Per-section status transitions, MERGED (by key) into the existing map. */
  sections?: SectionStatusMap;
  /** Per-company choices, MERGED (by company id) into the existing map. */
  companies?: CompanyStateMap;
}

/**
 * Merge a progress patch into the existing onboarding state flag. Pure and total,
 * so the read-merge-write below is unit-testable without a DB. Section entries are
 * merged BY KEY (a patch for one section never drops the others); the flow flags
 * (currentStep/complete) are overwritten only when present in the patch, so writing
 * a section status can never clobber the resume step and vice-versa.
 */
export function mergeOnboardingState(
  prev: OnboardingStateFlag | null,
  patch: OnboardingProgressPatch,
  now: string = new Date().toISOString(),
): OnboardingStateFlag {
  const base = prev ?? {};
  const merged: OnboardingStateFlag = {
    ...base,
    ...(patch.currentStep ? { currentStep: patch.currentStep } : {}),
    ...(patch.complete !== undefined ? { complete: patch.complete } : {}),
    updatedAt: now,
  };
  if (patch.sections) {
    merged.sections = { ...(base.sections ?? {}), ...patch.sections };
  }
  if (patch.companies) {
    merged.companies = { ...(base.companies ?? {}), ...patch.companies };
  }
  return merged;
}

/**
 * Persist onboarding progress. ALWAYS writes the durable `setup_complete` flag on
 * completion; ADDITIONALLY read-merge-writes the rich `onboarding_state` jsonb when
 * that column exists (so the flow flags and the per-section status map coexist and a
 * single-field patch never clobbers the rest). Returns whether the rich column
 * persisted. Degrade-safe: an absent column simply yields statePersisted=false.
 */
export async function persistOnboardingProgress(
  admin: SupabaseClient,
  orgId: string,
  patch: OnboardingProgressPatch,
): Promise<{ statePersisted: boolean }> {
  // On completion, always flip the always-present provisioning flag (durable).
  if (patch.complete === true) {
    await admin
      .schema('core')
      .from('organizations')
      .update({ setup_complete: true })
      .eq('id', orgId);
  }

  // Read the existing state (degrade-safe) so we merge rather than overwrite.
  const { flag } = await readOrgOnboarding(admin, orgId);
  const merged = mergeOnboardingState(flag, patch);

  const { error } = await admin
    .schema('core')
    .from('organizations')
    .update({ onboarding_state: merged })
    .eq('id', orgId);

  return { statePersisted: !error };
}
