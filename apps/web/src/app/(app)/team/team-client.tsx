'use client';

import { useState, useMemo } from 'react';
import {
  Loader2,
  AlertCircle,
  Search,
  Plus,
  Lock,
  Users2,
  Building2,
  X,
  ShieldCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { useMe } from '@/lib/hooks/use-me';
import { PageHeader, EmptyState, TableSkeleton } from '@/components/ui';
import { ALL_ROLES, ROLE_DEFINITIONS, type UserRole, type CompanyScope } from '@/lib/rbac/permissions';
import { PerformancePanel } from './performance-panel';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MemberCompany {
  id: string;
  name: string;
}

interface Member {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  role: UserRole;
  roleLabel: string;
  isActive: boolean;
  clerkLinked: boolean;
  companyScope: CompanyScope;
  companies: MemberCompany[];
}

interface MembersResponse {
  data: Member[];
  summary: { total: number; active: number; invited: number };
}

interface LocationOption {
  id: string;
  name: string;
  short_code: string;
}

// Non-admin read-only roster (existing /api/team shape).
interface RosterRow {
  id: string;
  fullName: string;
  email: string | null;
  title: string | null;
  isActive: boolean;
}
interface RosterResponse {
  data: RosterRow[];
  summary: { total: number; active: number };
}

type StatusFilter = 'all' | 'active' | 'inactive';

const ROLE_OPTIONS = ALL_ROLES.map((r) => ({ value: r, label: ROLE_DEFINITIONS[r].label }));

function isAllScope(role: UserRole): boolean {
  const scope = ROLE_DEFINITIONS[role]?.companyScope;
  return scope === 'all' || scope === 'portcos_and_3rdparty';
}

// ── Presentational helpers ──────────────────────────────────────────────────────

function initials(first: string, last: string, email: string | null): string {
  const fromName = `${first?.[0] ?? ''}${last?.[0] ?? ''}`.trim();
  if (fromName) return fromName.toUpperCase();
  return (email?.[0] ?? '?').toUpperCase();
}

// Deterministic, muted avatar tint keyed off the name — quiet identity, not decoration.
function avatarTint(seed: string): string {
  const tints = [
    'bg-slate-700 text-slate-200',
    'bg-slate-800 text-slate-300',
    'bg-emerald-500/10 text-emerald-300',
    'bg-blue-500/10 text-blue-300',
    'bg-indigo-500/10 text-indigo-300',
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return tints[h % tints.length];
}

function Avatar({ member }: { member: { firstName: string; lastName: string; email: string | null } }) {
  const label = initials(member.firstName, member.lastName, member.email);
  const seed = `${member.firstName}${member.lastName}${member.email ?? ''}`;
  return (
    <div
      className={clsx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold',
        avatarTint(seed)
      )}
      aria-hidden
    >
      {label}
    </div>
  );
}

// Status: emerald active / amber invited / slate inactive — dot + label pill (§6 badge).
function StatusPill({ isActive, clerkLinked }: { isActive: boolean; clerkLinked: boolean }) {
  const spec = !isActive
    ? { label: 'Inactive', dot: 'bg-slate-500', text: 'text-slate-400', fill: 'bg-slate-500/10' }
    : !clerkLinked
      ? { label: 'Invited', dot: 'bg-amber-400', text: 'text-amber-400', fill: 'bg-amber-500/10' }
      : { label: 'Active', dot: 'bg-emerald-400', text: 'text-emerald-400', fill: 'bg-emerald-500/10' };
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium',
        spec.fill,
        spec.text
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', spec.dot)} />
      {spec.label}
    </span>
  );
}

// Company access rendered as scannable pills, not a comma-run of names.
function CompanyAccess({ role, companies }: { role: UserRole; companies: MemberCompany[] }) {
  if (isAllScope(role)) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">
        <Building2 size={12} />
        All companies
      </span>
    );
  }
  if (companies.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400">
        No access assigned
      </span>
    );
  }
  const shown = companies.slice(0, 3);
  const rest = companies.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((c) => (
        <span
          key={c.id}
          className="max-w-[10rem] truncate rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-300"
          title={c.name}
        >
          {c.name}
        </span>
      ))}
      {rest > 0 && (
        <span className="rounded-md bg-slate-800/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
          +{rest}
        </span>
      )}
    </div>
  );
}

// Role chip — quiet slate, name only. Scope is carried by the company column, so
// role stays a neutral identifier (no decorative rainbow, §9).
function RoleChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-slate-700/70 bg-slate-800/60 px-2 py-0.5 text-xs font-medium text-slate-200">
      {label}
    </span>
  );
}

// ── Member add/edit modal ──────────────────────────────────────────────────────

interface MemberModalProps {
  mode: 'add' | 'edit';
  member: Member | null;
  locations: LocationOption[];
  onClose: () => void;
  onSaved: () => void;
}

function MemberModal({ mode, member, locations, onClose, onSaved }: MemberModalProps) {
  const [email, setEmail] = useState(member?.email ?? '');
  const [firstName, setFirstName] = useState(member?.firstName ?? '');
  const [lastName, setLastName] = useState(member?.lastName ?? '');
  const [role, setRole] = useState<UserRole>(member?.role ?? 'accounting_specialist');
  const [companyIds, setCompanyIds] = useState<string[]>(
    member && !isAllScope(member.role) ? member.companies.map((c) => c.id) : []
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const allScope = isAllScope(role);
  const roleDef = ROLE_DEFINITIONS[role];

  function toggleCompany(id: string) {
    setCompanyIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function handleSubmit() {
    setFormError('');
    if (mode === 'add' && !email.trim()) {
      setFormError('Enter an email so this person can claim their seat.');
      return;
    }
    setSubmitting(true);

    const effectiveCompanyIds = allScope ? [] : companyIds;

    const result =
      mode === 'add'
        ? await api.post('/api/team/members', {
            email: email.trim(),
            firstName: firstName.trim() || undefined,
            lastName: lastName.trim() || undefined,
            role,
            companyIds: effectiveCompanyIds,
          })
        : await api.patch(`/api/team/members/${member!.id}`, {
            role,
            companyIds: effectiveCompanyIds,
          });

    setSubmitting(false);

    if (result.error) {
      setFormError(result.error.error || 'Something went wrong.');
      return;
    }

    addToast('success', mode === 'add' ? 'Member added' : 'Member updated');
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-slate-800 bg-surface-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-subheading font-semibold text-white">
              {mode === 'add' ? 'Add team member' : 'Edit member access'}
            </h2>
            {mode === 'edit' && member && (
              <p className="truncate text-body-sm text-slate-500">
                {member.firstName || member.lastName
                  ? `${member.firstName} ${member.lastName}`.trim()
                  : member.email}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.04] hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 py-5">
          {mode === 'add' ? (
            <>
              <div>
                <label className="mb-1 block text-label text-slate-400">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="input"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  They claim this seat on first sign-in with a matching email.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-label text-slate-400">First name</label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="input"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-label text-slate-400">Last name</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="input"
                  />
                </div>
              </div>
            </>
          ) : (
            member && (
              <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-surface-850 px-3 py-2.5">
                <Avatar member={member} />
                <div className="min-w-0">
                  <p className="truncate text-body font-medium text-white">
                    {member.firstName || member.lastName
                      ? `${member.firstName} ${member.lastName}`.trim()
                      : '—'}
                  </p>
                  {member.email && <p className="truncate text-body-sm text-slate-400">{member.email}</p>}
                </div>
              </div>
            )
          )}

          <div>
            <label className="mb-1 block text-label text-slate-400">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className="input">
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {roleDef?.description && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{roleDef.description}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-label text-slate-400">Company access</label>
            {allScope ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-xs text-emerald-300">
                <Building2 size={14} />
                This role sees all companies — no per-company assignment needed.
              </div>
            ) : locations.length === 0 ? (
              <p className="text-xs text-slate-500">No companies available.</p>
            ) : (
              <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-slate-800 bg-surface-950/40 p-1.5">
                {locations.map((loc) => {
                  const checked = companyIds.includes(loc.id);
                  return (
                    <label
                      key={loc.id}
                      className={clsx(
                        'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors',
                        checked ? 'bg-slate-800/60' : 'hover:bg-slate-800/40'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCompany(loc.id)}
                        className="h-3.5 w-3.5 accent-emerald-500"
                      />
                      <span className="text-sm text-slate-200">{loc.name}</span>
                      <span className="ml-auto font-mono text-[10px] tabular-nums text-slate-500">
                        {loc.short_code}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {!allScope && locations.length > 0 && (
              <p className="mt-1.5 font-mono text-[11px] tabular-nums text-slate-500">
                {companyIds.length} selected
              </p>
            )}
          </div>

          {formError && (
            <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger-fg">
              <AlertCircle size={14} />
              {formError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 bg-surface-900 px-6 py-3.5">
          <button onClick={onClose} className="btn-ghost btn-sm">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={submitting} className="btn-primary btn-sm gap-1.5">
            {submitting && <Loader2 size={13} className="animate-spin" />}
            {mode === 'add' ? 'Add member' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section tabs (Access ⇄ Performance) ─────────────────────────────────────────

type SectionTab = 'access' | 'performance';

function SectionTabs({
  active,
  onChange,
  accessLabel = 'Access',
}: {
  active: SectionTab;
  onChange: (t: SectionTab) => void;
  accessLabel?: string;
}) {
  const tabs: { key: SectionTab; label: string }[] = [
    { key: 'access', label: accessLabel },
    { key: 'performance', label: 'Performance' },
  ];
  return (
    <div className="flex items-center gap-6 border-b border-slate-800">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          aria-current={active === t.key ? 'page' : undefined}
          className={clsx(
            '-mb-px border-b-2 pb-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:text-white',
            active === t.key
              ? 'border-brand-500 text-white'
              : 'border-transparent text-slate-500 hover:text-slate-300'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Read-only roster (non-admins) ───────────────────────────────────────────────

function ReadOnlyRoster({ canViewTeamPerf }: { canViewTeamPerf: boolean }) {
  const [tab, setTab] = useState<SectionTab>('access');
  const { data, isLoading, error, refetch } = useQuery<RosterResponse>('/api/team');
  const rows = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description={
          canViewTeamPerf
            ? "Your organization's team, and how it's performing."
            : "Directory of your organization's team members."
        }
      />

      <SectionTabs active={tab} onChange={setTab} accessLabel="Directory" />

      {tab === 'performance' ? (
        // Managers (accounting_manager) see the full team lens; everyone else sees
        // ONLY their own scorecard — the privacy boundary from the FPB.
        <PerformancePanel scope={canViewTeamPerf ? 'team' : 'self'} />
      ) : (
        <ReadOnlyRosterBody
          rows={rows}
          isLoading={isLoading}
          error={error}
          refetch={refetch}
        />
      )}
    </div>
  );
}

function ReadOnlyRosterBody({
  rows,
  isLoading,
  error,
  refetch,
}: {
  rows: RosterRow[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-surface-850 px-3.5 py-2.5 text-xs text-slate-400">
        <Lock size={14} className="shrink-0 text-slate-500" />
        Managing roles and company access is restricted to administrators.
      </div>

      {isLoading ? (
        <TableSkeleton rows={5} cols={3} />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Users2}
            title="No team members yet"
            description="Once your administrator adds people, they'll appear here."
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <Th>Name</Th>
                <Th>Title</Th>
                <Th align="center">Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {rows.map((r) => {
                const [first = '', ...restName] = (r.fullName || '').split(' ');
                return (
                  <tr key={r.id} className="table-row-hover">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar member={{ firstName: first, lastName: restName.join(' '), email: r.email }} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">{r.fullName || '—'}</p>
                          {r.email && <p className="truncate text-xs text-slate-500">{r.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">{r.title ?? '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <StatusPill isActive={r.isActive} clerkLinked />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────────

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right';
}) {
  return (
    <th
      className={clsx(
        'px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500',
        align === 'left' && 'text-left',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right'
      )}
    >
      {children}
    </th>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card flex flex-col items-center justify-center px-4 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-danger/10">
        <AlertCircle size={24} className="text-danger-fg" />
      </div>
      <h3 className="mb-1 text-sm font-medium text-slate-200">Couldn&apos;t load the team</h3>
      <p className="mb-4 max-w-sm text-sm text-slate-500">{message}</p>
      <button onClick={onRetry} className="btn-secondary btn-sm">
        Try again
      </button>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col px-5 py-3">
      <span className="text-caption uppercase tracking-caps text-slate-500">{label}</span>
      <span
        className={clsx(
          'mt-0.5 font-mono text-heading font-semibold tabular-nums',
          accent ? 'text-emerald-400' : 'text-white'
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────────

export function TeamClient() {
  const { loading: meLoading, user, can } = useMe();
  const canManage = user?.canManageUsers === true;
  // Performance manager lens = whoever can manage the Team feature: company_admin +
  // accounting_manager (team:'all' → { manage: true }). This is the closest existing
  // signal to the FPB's team_performance:view_all permission; the /api/team-performance
  // route should gate identically (and enforce self-only for everyone else) — the
  // panel trusts the server as the source of truth for which rows it returns.
  const canViewTeamPerf = can('team', 'manage');

  const [tab, setTab] = useState<SectionTab>('access');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; member: Member | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<MembersResponse>(
    canManage ? '/api/team/members' : null
  );
  const { data: locData } = useQuery<LocationOption[]>(canManage ? '/api/locations' : null);
  const locations = locData ?? [];

  const members = useMemo(() => data?.data ?? [], [data]);
  const summary = data?.summary;

  const filtered = useMemo(() => {
    return members.filter((m) => {
      if (statusFilter === 'active' && !m.isActive) return false;
      if (statusFilter === 'inactive' && m.isActive) return false;
      if (search) {
        const s = search.toLowerCase();
        const name = `${m.firstName} ${m.lastName}`.toLowerCase();
        return (
          name.includes(s) ||
          (m.email ?? '').toLowerCase().includes(s) ||
          m.roleLabel.toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [members, statusFilter, search]);

  async function toggleActive(m: Member) {
    setBusyId(m.id);
    const path = m.isActive ? 'deactivate' : 'reactivate';
    const result = await api.post(`/api/team/members/${m.id}/${path}`, {});
    setBusyId(null);
    if (result.error) {
      addToast('error', result.error.error || 'Action failed');
      return;
    }
    addToast('success', m.isActive ? 'Member deactivated' : 'Member reactivated');
    refetch();
  }

  // Wait for identity before deciding admin vs read-only, so the roster doesn't
  // flash for an admin during the /api/me round-trip.
  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  // Non-admins: read-only roster + notice (with its own Access ⇄ Performance tabs).
  if (!canManage) {
    return <ReadOnlyRoster canViewTeamPerf={canViewTeamPerf} />;
  }

  const STATUS_TABS: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'inactive', label: 'Inactive' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team & Access"
        description="Manage who's on the team, their role, and the companies they can see."
        actions={
          tab === 'access' ? (
            <button onClick={() => setModal({ mode: 'add', member: null })} className="btn-primary btn-sm gap-1.5">
              <Plus size={14} />
              Add member
            </button>
          ) : undefined
        }
      />

      <SectionTabs active={tab} onChange={setTab} />

      {tab === 'performance' ? (
        <PerformancePanel scope="team" />
      ) : (
        <>
      {/* Roster composition summary — access, not performance. */}
      {summary && (
        <div className="card flex w-fit divide-x divide-slate-800">
          <SummaryStat label="Members" value={summary.total} />
          <SummaryStat label="Active" value={summary.active} accent />
          <SummaryStat label="Invited" value={summary.invited} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-slate-800 bg-surface-850 p-0.5">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={clsx(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
                statusFilter === tab.key
                  ? 'bg-brand-500/10 text-emerald-400'
                  : 'text-slate-400 hover:text-slate-200'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-[220px] max-w-md flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, or role..."
            className="input pl-9"
          />
        </div>
      </div>

      {isLoading ? (
        <TableSkeleton rows={6} cols={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : filtered.length === 0 ? (
        <div className="card">
          {search || statusFilter !== 'all' ? (
            <EmptyState
              icon={Search}
              title="No members match"
              description="Try a different name, email, or role — or clear the status filter."
              action={{
                label: 'Clear filters',
                onClick: () => {
                  setSearch('');
                  setStatusFilter('all');
                },
              }}
            />
          ) : (
            <EmptyState
              icon={ShieldCheck}
              title="No team members yet"
              description="Add your first member to grant access to the books."
              action={{ label: 'Add member', onClick: () => setModal({ mode: 'add', member: null }) }}
            />
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <Th>Member</Th>
                <Th>Role</Th>
                <Th>Company access</Th>
                <Th align="center">Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {filtered.map((m) => {
                const displayName =
                  m.firstName || m.lastName ? `${m.firstName} ${m.lastName}`.trim() : m.email ?? '—';
                return (
                  <tr key={m.id} className="table-row-hover">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar member={m} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">{displayName}</p>
                          {m.email && <p className="truncate text-xs text-slate-500">{m.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <RoleChip label={m.roleLabel} />
                    </td>
                    <td className="max-w-xs px-4 py-3">
                      <CompanyAccess role={m.role} companies={m.companies} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusPill isActive={m.isActive} clerkLinked={m.clerkLinked} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setModal({ mode: 'edit', member: m })}
                          className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => toggleActive(m)}
                          disabled={busyId === m.id}
                          className={clsx(
                            'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 disabled:opacity-60',
                            m.isActive
                              ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 focus-visible:ring-red-500/40'
                              : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 focus-visible:ring-brand-500/40'
                          )}
                        >
                          {busyId === m.id && <Loader2 size={12} className="animate-spin" />}
                          {m.isActive ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <MemberModal
          mode={modal.mode}
          member={modal.member}
          locations={locations}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            refetch();
          }}
        />
      )}
        </>
      )}
    </div>
  );
}
