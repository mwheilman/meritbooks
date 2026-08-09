'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  ShieldCheck,
  Plus,
  Trash2,
  Lock,
  Info,
  RotateCcw,
  X,
  Check,
  Sparkles,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';

// ── API shapes ──────────────────────────────────────────────────────────────────
interface RoleSummary {
  key: string;
  label: string;
  description: string;
  isCustom: boolean;
  baseRole: string | null;
  companyScope?: string;
}
interface CatalogAction {
  action: string;
  label: string;
  description: string;
}
interface CatalogFeature {
  id: string;
  name: string;
  category: string;
  description: string;
  actions: CatalogAction[];
  businessViewOnly: boolean;
  internalOnly: boolean;
}
interface CatalogPayload {
  features: CatalogFeature[];
  actionGlossary: CatalogAction[];
}
interface RolesResponse {
  systemRoles: RoleSummary[];
  customRoles: RoleSummary[];
  catalog: CatalogPayload;
}
interface MatrixCell {
  action: string;
  allowed: boolean;
  defaultAllowed: boolean;
  source: 'default' | 'override';
}
interface MatrixFeature {
  featureId: string;
  featureName: string;
  category: string;
  cells: MatrixCell[];
}
interface MatrixResult {
  roleKey: string;
  isCustom: boolean;
  baseSystemRole: string | null;
  name?: string;
  description?: string | null;
  features: MatrixFeature[];
}

// ── Small UI atoms ────────────────────────────────────────────────────────────────
function Toggle({
  on,
  onClick,
  disabled,
  busy,
  title,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      disabled={disabled || busy}
      onClick={onClick}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50',
        on ? 'bg-emerald-500' : 'bg-slate-700',
        (disabled || busy) && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={clsx(
          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
          on ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
      {busy && (
        <Loader2 className="absolute -right-5 h-3.5 w-3.5 animate-spin text-slate-400" />
      )}
    </button>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────────
export function RolesClient() {
  const [roles, setRoles] = useState<RolesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<MatrixResult | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [busyCells, setBusyCells] = useState<Set<string>>(new Set());

  const [showCreate, setShowCreate] = useState(false);

  // Feature-description + action-label lookups from the catalog.
  const featureMeta = useMemo(() => {
    const m = new Map<string, CatalogFeature>();
    roles?.catalog.features.forEach((f) => m.set(f.id, f));
    return m;
  }, [roles]);
  const actionMeta = useMemo(() => {
    const m = new Map<string, CatalogAction>();
    roles?.catalog.actionGlossary.forEach((a) => m.set(a.action, a));
    return m;
  }, [roles]);

  const loadRoles = useCallback(async (selectAfter?: string) => {
    setLoading(true);
    setError(null);
    const res = await api.get<{ data: RolesResponse }>('/api/rbac/roles');
    if (res.error) {
      if (res.status === 403) setForbidden(true);
      else setError(res.error.error);
      setLoading(false);
      return;
    }
    const data = res.data!.data;
    setRoles(data);
    setLoading(false);
    const next = selectAfter ?? selected ?? data.systemRoles[0]?.key ?? null;
    setSelected(next);
  }, [selected]);

  useEffect(() => {
    void loadRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the effective matrix for the selected role.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setMatrixLoading(true);
    api.get<{ data: MatrixResult }>(`/api/rbac/roles/${encodeURIComponent(selected)}`).then((res) => {
      if (cancelled) return;
      if (res.error) {
        addToast('error', res.error.error || 'Failed to load permissions');
        setMatrix(null);
      } else {
        setMatrix(res.data!.data);
      }
      setMatrixLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const selectedSummary = useMemo(() => {
    if (!roles || !selected) return null;
    return (
      roles.systemRoles.find((r) => r.key === selected) ??
      roles.customRoles.find((r) => r.key === selected) ??
      null
    );
  }, [roles, selected]);

  // Group matrix features by category, preserving catalog order.
  const grouped = useMemo(() => {
    if (!matrix) return [];
    const order: string[] = [];
    const byCat = new Map<string, MatrixFeature[]>();
    for (const f of matrix.features) {
      if (!byCat.has(f.category)) {
        byCat.set(f.category, []);
        order.push(f.category);
      }
      byCat.get(f.category)!.push(f);
    }
    return order.map((cat) => ({ category: cat, features: byCat.get(cat)! }));
  }, [matrix]);

  const cellId = (feature: string, action: string) => `${feature}:${action}`;

  const toggleCell = useCallback(
    async (feature: string, cell: MatrixCell) => {
      if (!matrix) return;
      const id = cellId(feature, cell.action);
      const nextAllowed = !cell.allowed;
      setBusyCells((s) => new Set(s).add(id));

      // If the new value equals the system default, RESET (delete override) to keep the
      // table clean; otherwise SET an explicit override. Both need a JSON body, so we call
      // fetch directly (the shared api.delete helper sends no body).
      const revertToDefault = nextAllowed === cell.defaultAllowed;
      const resp = await fetch('/api/rbac/overrides', {
        method: revertToDefault ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          revertToDefault
            ? { roleKey: matrix.roleKey, feature, action: cell.action }
            : { roleKey: matrix.roleKey, feature, action: cell.action, allowed: nextAllowed },
        ),
      });

      setBusyCells((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });

      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        addToast('error', j.error || 'Could not update permission');
        return;
      }

      // Apply locally.
      setMatrix((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          features: prev.features.map((f) =>
            f.featureId !== feature
              ? f
              : {
                  ...f,
                  cells: f.cells.map((c) =>
                    c.action !== cell.action
                      ? c
                      : {
                          ...c,
                          allowed: nextAllowed,
                          source: revertToDefault ? 'default' : 'override',
                        },
                  ),
                },
          ),
        };
      });
    },
    [matrix],
  );

  const resetCell = useCallback(
    async (feature: string, cell: MatrixCell) => {
      if (!matrix) return;
      const id = cellId(feature, cell.action);
      setBusyCells((s) => new Set(s).add(id));
      const resp = await fetch('/api/rbac/overrides', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleKey: matrix.roleKey, feature, action: cell.action }),
      });
      setBusyCells((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        addToast('error', j.error || 'Could not reset permission');
        return;
      }
      setMatrix((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          features: prev.features.map((f) =>
            f.featureId !== feature
              ? f
              : {
                  ...f,
                  cells: f.cells.map((c) =>
                    c.action !== cell.action
                      ? c
                      : { ...c, allowed: c.defaultAllowed, source: 'default' },
                  ),
                },
          ),
        };
      });
    },
    [matrix],
  );

  const deleteRole = useCallback(async () => {
    if (!matrix || !matrix.isCustom) return;
    if (!confirm(`Delete the custom role "${matrix.name ?? matrix.roleKey}"? This cannot be undone.`)) return;
    const resp = await fetch(`/api/rbac/custom-roles/${encodeURIComponent(matrix.roleKey)}`, {
      method: 'DELETE',
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      addToast('error', j.error || 'Could not delete role');
      return;
    }
    addToast('success', 'Custom role deleted');
    setSelected(null);
    setMatrix(null);
    await loadRoles(roles?.systemRoles[0]?.key);
  }, [matrix, loadRoles, roles]);

  // ── Render states ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading roles…
      </div>
    );
  }
  if (forbidden) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-slate-800 bg-surface-900 p-8 text-center">
        <Lock className="mx-auto mb-3 h-8 w-8 text-slate-500" />
        <h3 className="text-lg font-semibold text-white">Admin access required</h3>
        <p className="mt-2 text-sm text-slate-400">
          Creating roles and changing permissions is limited to organization administrators
          (user-management access). Ask an admin to grant you access or make the change.
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300">
        <AlertCircle className="h-4 w-4" /> {error}
      </div>
    );
  }
  if (!roles) return null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
      {/* Role list */}
      <aside className="space-y-4">
        <RoleGroup
          title="System roles"
          hint="Shipped defaults. Adjust any permission below; changes are org-specific."
          roles={roles.systemRoles}
          selected={selected}
          onSelect={setSelected}
        />
        <div>
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Custom roles
            </span>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20"
            >
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          </div>
          {roles.customRoles.length === 0 ? (
            <p className="px-1 text-xs text-slate-500">
              None yet. Create one to tailor access to your org.
            </p>
          ) : (
            <RoleGroup
              title=""
              roles={roles.customRoles}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>
      </aside>

      {/* Matrix */}
      <section className="min-w-0">
        {matrixLoading || !matrix ? (
          <div className="flex items-center justify-center py-24 text-slate-400">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading permissions…
          </div>
        ) : (
          <>
            <RoleHeader summary={selectedSummary} matrix={matrix} onDelete={deleteRole} />

            <Legend />

            <div className="mt-4 space-y-6">
              {grouped.map(({ category, features }) => (
                <div key={category}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {category}
                  </h3>
                  <div className="overflow-hidden rounded-xl border border-slate-800 bg-surface-900">
                    {features.map((feat, i) => {
                      const meta = featureMeta.get(feat.featureId);
                      return (
                        <div
                          key={feat.featureId}
                          className={clsx(
                            'flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between',
                            i > 0 && 'border-t border-slate-800',
                          )}
                        >
                          <div className="min-w-0 sm:max-w-md">
                            <div className="text-sm font-medium text-white">{feat.featureName}</div>
                            <div className="mt-0.5 text-xs text-slate-400">
                              {meta?.description ?? ''}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-x-5 gap-y-2">
                            {feat.cells.map((cell) => {
                              const am = actionMeta.get(cell.action);
                              const id = cellId(feat.featureId, cell.action);
                              const isOverride = cell.source === 'override';
                              return (
                                <div key={cell.action} className="flex items-center gap-2">
                                  <Toggle
                                    on={cell.allowed}
                                    busy={busyCells.has(id)}
                                    title={am?.description}
                                    onClick={() => toggleCell(feat.featureId, cell)}
                                  />
                                  <div className="flex items-center gap-1">
                                    <span
                                      className={clsx(
                                        'text-xs',
                                        cell.allowed ? 'text-slate-200' : 'text-slate-500',
                                      )}
                                    >
                                      {am?.label ?? cell.action}
                                    </span>
                                    {isOverride && (
                                      <button
                                        type="button"
                                        title="Custom — click to reset to the system default"
                                        onClick={() => resetCell(feat.featureId, cell)}
                                        className="inline-flex items-center rounded bg-indigo-500/15 px-1 py-0.5 text-[10px] font-medium text-indigo-300 hover:bg-indigo-500/25"
                                      >
                                        <RotateCcw className="mr-0.5 h-2.5 w-2.5" />
                                        custom
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {showCreate && (
        <CreateRoleModal
          systemRoles={roles.systemRoles}
          onClose={() => setShowCreate(false)}
          onCreated={async (key) => {
            setShowCreate(false);
            await loadRoles(key);
          }}
        />
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────────
function RoleGroup({
  title,
  hint,
  roles,
  selected,
  onSelect,
}: {
  title: string;
  hint?: string;
  roles: RoleSummary[];
  selected: string | null;
  onSelect: (k: string) => void;
}) {
  return (
    <div>
      {title && (
        <div className="mb-2 px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</span>
          {hint && <p className="mt-1 text-[11px] leading-snug text-slate-500">{hint}</p>}
        </div>
      )}
      <div className="space-y-1">
        {roles.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onSelect(r.key)}
            className={clsx(
              'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
              selected === r.key
                ? 'bg-emerald-500/15 text-white'
                : 'text-slate-300 hover:bg-surface-900',
            )}
          >
            {r.isCustom ? (
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            )}
            <span className="truncate">{r.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RoleHeader({
  summary,
  matrix,
  onDelete,
}: {
  summary: RoleSummary | null;
  matrix: MatrixResult;
  onDelete: () => void;
}) {
  const label = summary?.label ?? matrix.name ?? matrix.roleKey;
  const description = summary?.description ?? matrix.description ?? '';
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-surface-900 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {matrix.isCustom ? (
            <Sparkles className="h-4 w-4 text-indigo-400" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
          )}
          <h2 className="text-base font-semibold text-white">{label}</h2>
          <span
            className={clsx(
              'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
              matrix.isCustom ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-700/50 text-slate-400',
            )}
          >
            {matrix.isCustom ? 'Custom' : 'System default'}
          </span>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">{description}</p>
        {matrix.isCustom && (
          <p className="mt-1 text-xs text-slate-500">
            Based on{' '}
            <span className="text-slate-300">
              {matrix.baseSystemRole ?? 'no base (deny-all)'}
            </span>
            . Toggles below start from that role&apos;s defaults.
          </p>
        )}
      </div>
      {matrix.isCustom && (
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-900/50 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-950/40"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete role
        </button>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-400">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-5 rounded-full bg-emerald-500" /> Allowed
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-5 rounded-full bg-slate-700" /> Denied
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center rounded bg-indigo-500/15 px-1 py-0.5 text-[10px] text-indigo-300">
          custom
        </span>{' '}
        Overrides the system default (click to reset)
      </span>
      <span className="flex items-center gap-1.5 text-slate-500">
        <Info className="h-3.5 w-3.5" /> Hover a toggle to see what it grants
      </span>
    </div>
  );
}

function CreateRoleModal({
  systemRoles,
  onClose,
  onCreated,
}: {
  systemRoles: RoleSummary[];
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseRole, setBaseRole] = useState<string>(systemRoles[0]?.key ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (name.trim().length < 2) {
      addToast('error', 'Give the role a name (2+ characters).');
      return;
    }
    setSaving(true);
    const res = await api.post<{ data: { key: string } }>('/api/rbac/custom-roles', {
      name: name.trim(),
      description: description.trim() || undefined,
      baseRole: baseRole === '__none__' ? null : baseRole,
    });
    setSaving(false);
    if (res.error) {
      addToast('error', res.error.error || 'Could not create role');
      return;
    }
    addToast('success', 'Custom role created');
    onCreated(res.data!.data.key);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-surface-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">New custom role</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-300">Role name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. AP Clerk, Read-only Auditor"
              className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-300">
              Description <span className="text-slate-500">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What is this role for?"
              className="w-full resize-none rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-300">Start from</label>
            <select
              value={baseRole}
              onChange={(e) => setBaseRole(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
            >
              {systemRoles.map((r) => (
                <option key={r.key} value={r.key}>
                  Clone: {r.label}
                </option>
              ))}
              <option value="__none__">Empty (deny everything, build up)</option>
            </select>
            <p className="mt-1 text-[11px] text-slate-500">
              The new role starts with these permissions. You can change any of them afterward.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-surface-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Create role
          </button>
        </div>
      </div>
    </div>
  );
}
