'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Button, Field, Keybar, ListPager, QueueTable, Search, Select, Status, Tag, WidgetState, useDebounce,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import type { JobTypeRow, ProjectListRow } from '@/lib/pm/types';
import { cents, marginCents, marginPctText } from '@/lib/pm/money';
import { stageStatus } from '@/lib/pm/stage';
import { stamp } from '@/lib/time';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { NewJobPanel } from './NewJobPanel';

export interface JobsViewProps {
  rows: ProjectListRow[];
  total: number;
  page: number;
  perPage: number;
  filters: { q: string; stage: string; type: string; sort: string };
  stages: Array<{ key: string; label: string }>;
  jobTypes: JobTypeRow[];
  companies: Array<{ id: string; name: string }>;
  defaultCompanyId: string | null;
  companyNames: Record<string, string>;
  pmNames: Record<string, string>;
  multiCompany: boolean;
  openNew: boolean;
  hasAnyJobs: boolean;
}

export function JobsView(p: JobsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const v = useVocab();
  const { readOnly } = useShell();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(p.filters.q);
  const debounced = useDebounce(q, 300);
  const [panel, setPanel] = useState(p.openNew && !readOnly && !!p.defaultCompanyId);

  const push = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp?.toString() ?? '');
    for (const [k, val] of Object.entries(patch)) {
      if (val) next.set(k, val);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    next.delete('new');
    const qs = next.toString();
    start(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
  };

  useEffect(() => {
    if (debounced !== p.filters.q) push({ q: debounced.trim() || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const sortToggle = (key: 'number' | 'contract') => ({
    direction: p.filters.sort === key ? ('desc' as const) : null,
    onToggle: () => push({ sort: p.filters.sort === key ? null : key }),
    label: `Sort by ${key}`,
  });

  const columns = useMemo<QueueColumn<ProjectListRow>[]>(() => {
    const cols: QueueColumn<ProjectListRow>[] = [
      { id: 'num', header: 'Number', width: 132, sort: sortToggle('number'), cell: (r) => <span className="code">{r.job_number ?? '—'}</span> },
      {
        id: 'name',
        header: 'Name',
        cell: (r) => (
          <>
            <span className="l1">
              {r.name} {r.is_sample ? <Tag tone="warn">Sample</Tag> : null}
            </span>
            {p.multiCompany ? <span className="l2">{p.companyNames[r.location_id]}</span> : null}
          </>
        ),
      },
      { id: 'cust', header: v.customer, width: 176, cell: (r) => <span className="l1" style={{ fontWeight: 400 }}>{r.customer_name ?? <span className="ink-3">None yet</span>}</span> },
      { id: 'type', header: 'Job type', width: 144, cell: (r) => <span className="l2" style={{ color: 'var(--ink-2)' }}>{r.job_type_label}</span> },
      {
        id: 'stage',
        header: 'Stage',
        width: 152,
        cell: (r) => {
          const s = stageStatus(r.core_status);
          return <Status kind={s.kind} pip={s.pip}>{r.stage_label ?? r.stage_key}</Status>;
        },
      },
      { id: 'contract', header: 'Revised contract', numeric: true, width: 136, sort: sortToggle('contract'), cell: (r) => cents(r.contract_revised_cents) },
      { id: 'budget', header: 'Budget', numeric: true, width: 120, cell: (r) => cents(r.budget_total_cents) },
      {
        id: 'margin',
        header: 'Margin',
        numeric: true,
        width: 120,
        cell: (r) =>
          r.contract_revised_cents > 0 ? (
            <>
              <span className="l1" style={{ fontWeight: 400 }}>{cents(marginCents(r))}</span>
              <span className="l2">{marginPctText(r)}</span>
            </>
          ) : (
            <span className="ink-3">—</span>
          ),
      },
      { id: 'pm', header: v.pm === 'Project manager' ? 'PM' : v.pm, width: 120, cell: (r) => <span className="l2">{r.pm_user_id ? p.pmNames[r.pm_user_id] ?? 'Assigned' : 'Unassigned'}</span> },
      { id: 'upd', header: 'Updated', width: 120, cell: (r) => <span className="l2">{stamp(r.updated_at).split(' · ')[0]}</span> },
    ];
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.filters.sort, p.multiCompany, p.companyNames, p.pmNames, v]);

  const filtered = !!(p.filters.q || p.filters.stage || p.filters.type);
  const canCreate = !readOnly && !!p.defaultCompanyId;

  return (
    <div className={panel ? 'mp-split has-panel' : 'mp-split'}>
      <section aria-label={v.jobs} style={{ minWidth: 0 }}>
        <div className="mp-tools">
          <Search aria-label={`Search ${lower(v.jobs)}`} slashToFocus placeholder="Number, name or customer" value={q} onChange={(e) => setQ(e.target.value)} />
          <Field label="Stage">
            <Select value={p.filters.stage} onChange={(e) => push({ stage: e.target.value || null })}>
              <option value="">All stages</option>
              {p.stages.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Job type">
            <Select value={p.filters.type} onChange={(e) => push({ type: e.target.value || null })}>
              <option value="">All job types</option>
              {[...new Map(p.jobTypes.map((t) => [t.key, t])).values()].map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </Select>
          </Field>
          {filtered && <Button variant="quiet" onClick={() => { setQ(''); push({ q: null, stage: null, type: null }); }}>Clear filters</Button>}
          <span className="sp" />
          {pending && <span className="t-cap" role="status">Updating…</span>}
          {canCreate && (
            <Button variant="primary" icon="plus" chord="n" bindChord={!panel} onClick={() => setPanel(true)}>
              New {lower(v.job)}
            </Button>
          )}
        </div>

        <div className="mp-table" aria-busy={pending || undefined}>
          {p.rows.length > 0 ? (
            <QueueTable
              aria-label={`${v.jobs}, ${p.total} in this view`}
              columns={columns}
              rows={p.rows}
              getRowId={(r) => r.job_id}
              openOnClick
              onOpen={(r) => router.push(`/jobs/${r.job_id}`)}
            />
          ) : (
            <WidgetState
              state={
                !p.hasAnyJobs
                  ? {
                      kind: 'empty',
                      title: `Create your first ${lower(v.job)}`,
                      body: 'Pick a job type and a name. The number, first stage and budget template follow from your industry setup.',
                      action: canCreate ? <Button variant="primary" onClick={() => setPanel(true)}>New {lower(v.job)}</Button> : undefined,
                    }
                  : {
                      kind: 'empty',
                      title: `No ${lower(v.jobs)} match these filters`,
                      body: 'Try another stage or job type, or search by number or customer.',
                      action: <Button onClick={() => { setQ(''); push({ q: null, stage: null, type: null }); }}>Clear filters</Button>,
                    }
              }
            />
          )}
        </div>
        <ListPager page={p.page} perPage={p.perPage} total={p.total} onPage={(n) => push({ page: String(n) })} noun={lower(v.jobs)} />
        {p.rows.length > 0 && (
          <Keybar
            hints={[
              { chord: 'j k', label: 'move' },
              { chord: 'enter', label: 'open' },
              { chord: '/', label: 'search' },
              ...(canCreate ? [{ chord: 'n', label: `new ${lower(v.job)}` }] : []),
            ]}
            note={readOnly ? 'Consolidated view is read-only' : undefined}
          />
        )}
      </section>
      {panel && p.defaultCompanyId && (
        <NewJobPanel
          companies={p.companies}
          defaultCompanyId={p.defaultCompanyId}
          jobTypes={p.jobTypes}
          onClose={() => setPanel(false)}
        />
      )}
    </div>
  );
}
