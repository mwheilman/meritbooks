'use client';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { DepartmentDrawer, type DeptLike } from './dept-drawer';

import { useState, useMemo } from 'react';
import { Loader2, AlertCircle, Plus, Network, Pencil, Power, X, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { addToast } from '@/hooks';
import { PageHeader, EmptyState } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';

type ChargeMethod = 'inherit' | 'revenue' | 'cost_transfer';

interface DepartmentRow {
  id: string;
  name: string;
  code: string;
  locationId: string | null;
  parentDepartmentId: string | null;
  parentName: string | null;
  internalChargeMethod: ChargeMethod;
  hierarchyDepth: number;
  isActive: boolean;
  createdAt: string;
}

interface DepartmentsResponse {
  departments: DepartmentRow[];
  total: number;
  active: number;
}

interface LocationRow {
  id: string;
  name: string;
  short_code: string;
  industry: string | null;
}

const CHARGE_METHOD_LABELS: Record<ChargeMethod, { label: string; className: string }> = {
  inherit: { label: 'Company default', className: 'bg-slate-500/10 text-slate-400' },
  revenue: { label: 'Revenue', className: 'bg-emerald-500/10 text-emerald-400' },
  cost_transfer: { label: 'Cost transfer', className: 'bg-blue-500/10 text-blue-400' },
};

const CHARGE_METHOD_HELP: Record<ChargeMethod, string> = {
  inherit: 'Uses the company default charge method.',
  revenue: 'When this department serves another, it issues an internal invoice and books internal revenue; the receiver books internal cost. Both net to zero on the company\u2019s consolidated books.',
  cost_transfer: 'Internal work moves cost from this department to the receiver \u2014 no internal revenue is recognized.',
};

interface FormState {
  id: string | null;
  name: string;
  code: string;
  locationId: string;
  parentDepartmentId: string;
  internalChargeMethod: ChargeMethod;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  code: '',
  locationId: '',
  parentDepartmentId: '',
  internalChargeMethod: 'inherit',
};

export default function DepartmentsPage() {
  // COMPANY-SCOPE CONTROL: departments and inter-department charge setup belong to
  // one company's structure.
  return (
    <CompanyScopeGuard>
      <DepartmentsPageInner />
    </CompanyScopeGuard>
  );
}

function DepartmentsPageInner() {
  const { data, isLoading, error, refetch } = useQuery<DepartmentsResponse>('/api/departments');
  const [selected, setSelected] = useState<{ dept: DeptLike; companyName: string } | null>(null);
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<{ dept: DeptLike; companyName: string }>();
  const { data: locations } = useQuery<LocationRow[]>('/api/locations');

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const departments = data?.departments ?? [];
  const locationList = locations ?? [];
  const locationName = (id: string | null) =>
    locationList.find((l) => l.id === id)?.name ?? 'Unassigned company';

  // Group by company, then order parents-first with children nested underneath.
  const grouped = useMemo(() => {
    const byCompany = new Map<string, DepartmentRow[]>();
    for (const d of departments) {
      const key = d.locationId ?? 'unassigned';
      if (!byCompany.has(key)) byCompany.set(key, []);
      byCompany.get(key)!.push(d);
    }

    const ordered: { companyId: string; companyName: string; rows: DepartmentRow[] }[] = [];
    for (const [companyId, rows] of byCompany) {
      const childrenOf = (parentId: string | null): DepartmentRow[] =>
        rows
          .filter((r) => r.parentDepartmentId === parentId)
          .sort((a, b) => a.name.localeCompare(b.name));
      const flat: DepartmentRow[] = [];
      const walk = (parentId: string | null) => {
        for (const r of childrenOf(parentId)) {
          flat.push(r);
          walk(r.id);
        }
      };
      walk(null);
      // Include any orphaned rows whose parent isn't in this company set
      for (const r of rows) {
        if (!flat.includes(r)) flat.push(r);
      }
      ordered.push({
        companyId,
        companyName: companyId === 'unassigned' ? 'Unassigned company' : locationName(companyId),
        rows: flat,
      });
    }
    return ordered.sort((a, b) => a.companyName.localeCompare(b.companyName));
  }, [departments, locationList]);

  const openCreate = () => {
    setFormError(null);
    setForm({ ...EMPTY_FORM, locationId: locationList[0]?.id ?? '' });
  };

  const openEdit = (d: DepartmentRow) => {
    setFormError(null);
    setForm({
      id: d.id,
      name: d.name,
      code: d.code,
      locationId: d.locationId ?? '',
      parentDepartmentId: d.parentDepartmentId ?? '',
      internalChargeMethod: d.internalChargeMethod,
    });
  };

  const parentOptions = useMemo(() => {
    if (!form) return [];
    return departments.filter(
      (d) => d.locationId === form.locationId && d.id !== form.id && d.isActive
    );
  }, [form, departments]);

  const submit = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      setFormError('Department name is required.');
      return;
    }
    if (!form.locationId) {
      setFormError('Select a company.');
      return;
    }

    setSaving(true);
    setFormError(null);
    try {
      const isEdit = !!form.id;
      const res = await fetch('/api/departments', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: form.id ?? undefined,
          name: form.name.trim(),
          code: form.code.trim() || undefined,
          location_id: form.locationId,
          parent_department_id: form.parentDepartmentId || null,
          internal_charge_method: form.internalChargeMethod,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(json.error ?? 'Could not save department.');
        setSaving(false);
        return;
      }
      addToast('success', isEdit ? 'Department updated.' : 'Department created.');
      setForm(null);
      await refetch();
    } catch {
      setFormError('Network error \u2014 please try again.');
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (d: DepartmentRow) => {
    if (!window.confirm(`Deactivate "${d.name}"? It will be hidden but its history is preserved.`)) return;
    try {
      const res = await fetch(`/api/departments?id=${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast('error', json.error ?? 'Could not deactivate department.');
        return;
      }
      addToast('success', 'Department deactivated.');
      await refetch();
    } catch {
      addToast('error', 'Network error \u2014 please try again.');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Departments"
        description={
          data
            ? `${data.active} active \u00b7 ${data.total} total across ${grouped.length} ${grouped.length === 1 ? 'company' : 'companies'}`
            : 'Company \u2192 Department structure'
        }
        actions={
          <button
            onClick={openCreate}
            disabled={locationList.length === 0}
            className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus size={14} /> New Department
          </button>
        }
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : departments.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No departments yet"
          description={
            locationList.length === 0
              ? 'Add a company in setup first, then create its departments here.'
              : 'Departments give each part of a company its own P&L, budget, and FP&A. Create your first one to get started.'
          }
          action={locationList.length > 0 ? { label: 'New Department', onClick: openCreate } : undefined}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.companyId} className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 bg-slate-800/20">
                <h2 className="text-sm font-semibold text-white">{group.companyName}</h2>
                <p className="text-2xs text-slate-500">{group.rows.length} department{group.rows.length === 1 ? '' : 's'}</p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Department</th>
                    <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Code</th>
                    <th className="px-4 py-2.5 text-left text-2xs font-semibold uppercase text-slate-500">Internal charge method</th>
                    <th className="px-4 py-2.5 text-center text-2xs font-semibold uppercase text-slate-500">Status</th>
                    <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/30">
                  {group.rows.map((d) => {
                    const indent = Math.max(0, (d.hierarchyDepth ?? 1) - 1);
                    const cm = CHARGE_METHOD_LABELS[d.internalChargeMethod];
                    return (
                      <tr key={d.id} {...rowHandlers({ dept: d as unknown as DeptLike, companyName: group.companyName })} onClick={() => setSelected({ dept: d as unknown as DeptLike, companyName: group.companyName })} className={clsx('row-clickable', !d.isActive && 'opacity-50')}>
                        <td className="px-4 py-3">
                          <div className="flex items-center" style={{ paddingLeft: `${indent * 18}px` }}>
                            {indent > 0 && <span className="text-slate-600 mr-1.5">{'\u2514'}</span>}
                            <span className="text-sm text-white font-medium">{d.name}</span>
                          </div>
                          {d.parentName && (
                            <p className="text-2xs text-slate-500" style={{ paddingLeft: `${indent * 18}px` }}>
                              under {d.parentName}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs font-mono text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">{d.code}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={clsx('inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium', cm.className)}>
                            {cm.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {d.isActive ? (
                            <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400">Active</span>
                          ) : (
                            <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-500/10 text-slate-500">Inactive</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={(e) => { e.stopPropagation(); openEdit(d); }}
                              className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-white/[0.04] transition-colors"
                              title="Edit"
                            >
                              <Pencil size={14} />
                            </button>
                            {d.isActive && (
                              <button
                                onClick={(e) => { e.stopPropagation(); deactivate(d); }}
                                className="p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                title="Deactivate"
                              >
                                <Power size={14} />
                              </button>
                            )}
                            <ChevronRight size={14} className="row-chevron" />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null} visible={!!peek} cardHandlers={cardHandlers}
        onOpen={peek ? () => { const sel = peek.item; close(); setSelected(sel); } : undefined}
      >
        {peek && (
          <div className="p-3">
            <div className="text-sm font-semibold text-white mb-1">{peek.item.dept.name}</div>
            <div className="text-2xs text-slate-500 mb-2">{peek.item.dept.code} · {peek.item.companyName}</div>
            {peek.item.dept.parentName && <div className="text-2xs text-slate-500">under {peek.item.dept.parentName}</div>}
            <div className="mt-2 text-2xs"><span className={peek.item.dept.isActive ? 'text-emerald-400' : 'text-slate-500'}>{peek.item.dept.isActive ? 'Active' : 'Inactive'}</span></div>
          </div>
        )}
      </HoverPeekCard>

      <DepartmentDrawer
        dept={selected?.dept ?? null}
        companyName={selected?.companyName}
        onClose={() => setSelected(null)}
        onEdit={selected ? () => { const d = selected.dept; setSelected(null); openEdit(d as unknown as DepartmentRow); } : undefined}
      />

      {/* Create / Edit modal */}
      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => !saving && setForm(null)} />
          <div className="relative z-10 w-full max-w-lg rounded-xl border border-slate-800 bg-surface-900 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-white">
                {form.id ? 'Edit department' : 'New department'}
              </h3>
              <button onClick={() => !saving && setForm(null)} className="text-slate-500 hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Company *</label>
                <select
                  value={form.locationId}
                  onChange={(e) => setForm({ ...form, locationId: e.target.value, parentDepartmentId: '' })}
                  disabled={!!form.id}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white disabled:opacity-60"
                >
                  <option value="">{'Select a company\u2026'}</option>
                  {locationList.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Name *</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Commercial Service"
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Code</label>
                  <input
                    value={form.code}
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    placeholder="auto"
                    className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Parent department</label>
                <select
                  value={form.parentDepartmentId}
                  onChange={(e) => setForm({ ...form, parentDepartmentId: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white"
                >
                  <option value="">None (top level)</option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Internal charge method</label>
                <select
                  value={form.internalChargeMethod}
                  onChange={(e) => setForm({ ...form, internalChargeMethod: e.target.value as ChargeMethod })}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white"
                >
                  <option value="inherit">Use company default</option>
                  <option value="revenue">Revenue</option>
                  <option value="cost_transfer">Cost transfer</option>
                </select>
                <p className="mt-1.5 text-2xs text-slate-500">{CHARGE_METHOD_HELP[form.internalChargeMethod]}</p>
              </div>

              {formError && (
                <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
              <button onClick={() => !saving && setForm(null)} className="btn-ghost btn-sm">Cancel</button>
              <button onClick={submit} disabled={saving} className="btn-primary btn-sm inline-flex items-center gap-1.5 disabled:opacity-60">
                {saving && <Loader2 size={14} className="animate-spin" />}
                {form.id ? 'Save changes' : 'Create department'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
