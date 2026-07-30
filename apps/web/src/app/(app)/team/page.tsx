'use client';

import { useState, useMemo } from 'react';
import { Loader2, AlertCircle, Search, Plus, Lock, ShieldCheck, Building2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { useMe } from '@/lib/hooks/use-me';
import { PageHeader } from '@/components/ui';
import { ALL_ROLES, ROLE_DEFINITIONS, type UserRole, type CompanyScope } from '@/lib/rbac/permissions';

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
      setFormError('Email is required.');
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
      <div className="relative w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-white">
              {mode === 'add' ? 'Add team member' : 'Edit member access'}
            </h2>
            {mode === 'edit' && member && (
              <p className="text-xs text-slate-500">
                {member.firstName || member.lastName
                  ? `${member.firstName} ${member.lastName}`.trim()
                  : member.email}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          {mode === 'add' ? (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-400">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  They claim this seat on first sign-in with a matching email.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">First name</label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">Last name</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                  />
                </div>
              </div>
            </>
          ) : (
            member && (
              <div className="rounded-lg border border-slate-800 bg-slate-800/30 px-3 py-2">
                <p className="text-xs text-slate-500">Member</p>
                <p className="text-sm text-white">
                  {member.firstName || member.lastName
                    ? `${member.firstName} ${member.lastName}`.trim()
                    : '—'}
                </p>
                {member.email && <p className="text-xs text-slate-400">{member.email}</p>}
              </div>
            )
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {roleDef?.description && (
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{roleDef.description}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">Company access</label>
            {allScope ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-xs text-emerald-300">
                <Building2 size={14} />
                This role sees all companies — no per-company assignment needed.
              </div>
            ) : locations.length === 0 ? (
              <p className="text-xs text-slate-500">No companies available.</p>
            ) : (
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-800 p-1.5">
                {locations.map((loc) => {
                  const checked = companyIds.includes(loc.id);
                  return (
                    <label
                      key={loc.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-slate-800/50"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCompany(loc.id)}
                        className="h-3.5 w-3.5 accent-emerald-500"
                      />
                      <span className="text-sm text-slate-200">{loc.name}</span>
                      <span className="ml-auto font-mono text-[10px] text-slate-500">{loc.short_code}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {!allScope && locations.length > 0 && (
              <p className="mt-1 text-[11px] text-slate-500">{companyIds.length} selected</p>
            )}
          </div>

          {formError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              <AlertCircle size={14} />
              {formError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
          >
            {submitting && <Loader2 size={13} className="animate-spin" />}
            {mode === 'add' ? 'Add member' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Read-only roster (non-admins) ───────────────────────────────────────────────

function ReadOnlyRoster() {
  const { data, isLoading, error } = useQuery<RosterResponse>('/api/team');
  const rows = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Team" description="Directory of your organization's team members." />
      <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-800/30 px-3.5 py-2.5 text-xs text-slate-400">
        <Lock size={14} className="text-slate-500" />
        Managing roles and company access is restricted to administrators.
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="p-8 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-12 text-center text-sm text-slate-500">No team members yet.</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Name</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Title</th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-800/20">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-white">{r.fullName}</p>
                    {r.email && <p className="text-xs text-slate-500">{r.email}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">{r.title ?? '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <StatusPill isActive={r.isActive} clerkLinked />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Status pill ─────────────────────────────────────────────────────────────────

function StatusPill({ isActive, clerkLinked }: { isActive: boolean; clerkLinked: boolean }) {
  if (!isActive) {
    return (
      <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-500/10 text-slate-500">
        Inactive
      </span>
    );
  }
  if (!clerkLinked) {
    return (
      <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-400">
        Invited
      </span>
    );
  }
  return (
    <span className="inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/10 text-emerald-400">
      Active
    </span>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────────

export default function TeamPage() {
  const { loading: meLoading, user } = useMe();
  const canManage = user?.canManageUsers === true;

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

  // Loading identity → spinner
  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  // Wait for identity before deciding admin vs read-only, so the roster doesn't
  // flash for an admin during the /api/me round-trip.
  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
      </div>
    );
  }

  // Non-admins: read-only roster + notice
  if (!canManage) {
    return <ReadOnlyRoster />;
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
        description={
          summary
            ? `${summary.total} ${summary.total === 1 ? 'member' : 'members'}${summary.invited ? ` · ${summary.invited} invited` : ''}`
            : 'Manage members, roles, and company access.'
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-800/30 p-0.5">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={clsx(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                statusFilter === tab.key
                  ? 'bg-emerald-500/10 text-emerald-400'
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
            className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500"
          />
        </div>

        <button
          onClick={() => setModal({ mode: 'add', member: null })}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
        >
          <Plus size={14} />
          Add member
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
        </div>
      ) : error ? (
        <div className="p-8 text-center">
          <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-400" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm text-slate-400">
            {search || statusFilter !== 'all'
              ? 'No members match your filters.'
              : 'No team members yet. Add your first member to grant access.'}
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Name</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Role</th>
                <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">
                  Company access
                </th>
                <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Status</th>
                <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/30">
              {filtered.map((m) => {
                const displayName =
                  m.firstName || m.lastName ? `${m.firstName} ${m.lastName}`.trim() : m.email ?? '—';
                const companyLabel = isAllScope(m.role)
                  ? 'All companies'
                  : m.companies.length === 0
                    ? 'None'
                    : m.companies.map((c) => c.name).join(', ');
                return (
                  <tr key={m.id} className="hover:bg-slate-800/20">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-white">{displayName}</p>
                      {m.email && <p className="text-xs text-slate-500">{m.email}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-slate-300">{m.roleLabel}</span>
                    </td>
                    <td className="max-w-xs px-4 py-3">
                      <span
                        className={clsx(
                          'text-xs',
                          isAllScope(m.role) ? 'text-emerald-400' : 'text-slate-400'
                        )}
                      >
                        {companyLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusPill isActive={m.isActive} clerkLinked={m.clerkLinked} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setModal({ mode: 'edit', member: m })}
                          className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => toggleActive(m)}
                          disabled={busyId === m.id}
                          className={clsx(
                            'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-60',
                            m.isActive
                              ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                              : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
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
    </div>
  );
}
