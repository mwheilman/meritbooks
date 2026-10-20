'use client';

/**
 * Department map (FPB §3.11): the six dealer department roles → this client's own
 * departments. A small client can point several roles at one department.
 * PUT /api/dealer/settings/departments.
 */

import { useState } from 'react';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import type { Readiness } from '@/lib/dealer/service/settings';
import { DEPT_ROLE } from '@/lib/dealer/ui/labels';
import type { DeptRole } from '@/lib/dealer/types';
import { dealerMutate, type DealerApiError } from '../../_lib/use-dealer';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel, Pill, Section } from '../../_components/ui';

export function DepartmentsSection({ readiness, locationId, onSaved }: { readiness: Readiness; locationId: string; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<Partial<Record<DeptRole, string | null>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const changed = Object.keys(draft) as DeptRole[];

  async function save() {
    setBusy(true);
    setError(null);
    const res = await dealerMutate<Readiness>(
      'put',
      '/api/dealer/settings/departments',
      locationId,
      { mappings: changed.map((deptRole) => ({ deptRole, departmentId: draft[deptRole] ?? null })) },
      'Departments saved',
    );
    setBusy(false);
    if (res.error) return setError(res.error);
    setDraft({});
    await onSaved();
  }

  return (
    <Section
      id="departments"
      className="scroll-mt-6"
      title="Departments"
      description="Every dealer posting line carries one of these so the departmental P&L matches how the store is run. A small client can map several roles to one department."
      actions={
        changed.length > 0 ? (
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setDraft({})} disabled={busy}>
              Discard
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Save departments
            </button>
          </>
        ) : null
      }
    >
      {error && (
        <div className="px-5 pt-4">
          <ErrorPanel error={error} compact />
        </div>
      )}
      <ul className="divide-y divide-slate-800/50">
        {readiness.departments.map((d) => {
          const value = d.deptRole in draft ? draft[d.deptRole] ?? null : d.departmentId;
          const missing = !value;
          return (
            <li key={d.deptRole} id={`dept-${d.deptRole}`} className={clsx('grid scroll-mt-24 gap-3 px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center', missing && 'bg-amber-500/[0.03]')}>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-100">{DEPT_ROLE[d.deptRole].label}</span>
                  <Pill label="Required" tone={missing ? 'warning' : 'neutral'} dot={missing} />
                  {d.deptRole in draft && <span className="text-2xs text-amber-300">Unsaved</span>}
                </div>
                {DEPT_ROLE[d.deptRole].hint && <p className="mt-0.5 text-xs text-slate-500">{DEPT_ROLE[d.deptRole].hint}</p>}
              </div>
              <LookupPicker
                kind="departments"
                value={value}
                disabled={busy}
                invalid={missing}
                aria-label={`Department for ${DEPT_ROLE[d.deptRole].label}`}
                placeholder="Choose a department…"
                onChange={(v) =>
                  setDraft((x) => {
                    const next = { ...x };
                    if (v === d.departmentId) delete next[d.deptRole];
                    else next[d.deptRole] = v;
                    return next;
                  })
                }
              />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
