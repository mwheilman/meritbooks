'use client';

/**
 * Programs tab — this client's manufacturer incentive programs (oem_programs).
 * Drafts (including AI-drafted ones from a bulletin, marked indigo) are edited and
 * then approved by a different, authorized person; approval turns them on.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Gift, Plus, Search } from 'lucide-react';
import { OEM_PROGRAM_STATUS, PROGRAM_TYPE, TREATMENT, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { OemProgramRecord } from '@/lib/dealer/ui/claims';
import type { OemProgramStatus } from '@/lib/dealer/types';
import { dealerMutate, nameOf, useDealerList, useNames, type DealerApiError } from '../../_lib/use-dealer';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { ConfirmDialog } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { AiBadge, ErrorPanel, Mono, Pill } from '../../_components/ui';
import { ProgramForm } from './program-form';

type Seg = 'ALL' | OemProgramStatus;

export function ProgramsTab({ locationId }: { locationId: string }) {
  const list = useDealerList<OemProgramRecord>('/api/dealer/oem-programs', { sort: 'name', dir: 'asc' });
  const { state } = list;
  const rows = list.data?.rows ?? [];
  const vendors = useNames('vendors', rows.map((r) => r.oem_vendor_id));
  const [editing, setEditing] = useState<OemProgramRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ program: OemProgramRecord; status: 'ACTIVE' | 'EXPIRED' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const seg = (state.filters.status as Seg | undefined) ?? 'ALL';

  async function setStatus() {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/oem-programs/status', locationId, { id: confirm.program.id, status: confirm.status }, confirm.status === 'ACTIVE' ? 'Program approved — incentives can now be recorded under it' : 'Program expired');
    setBusy(false);
    if (res.error) return setError(res.error);
    setConfirm(null);
    void list.refetch();
  }

  const columns = useMemo<DealerColumn<OemProgramRecord>[]>(
    () => [
      {
        key: 'name',
        header: 'Program',
        sortKey: 'name',
        render: (r) => (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-slate-100">{r.name}</span>
              {r.source_document_id && r.status === 'DRAFT' && <AiBadge title="Drafted by AI from a manufacturer bulletin — check the terms before approving" />}
            </div>
            {r.program_code && <div className="font-mono text-2xs text-slate-500">{r.program_code}</div>}
          </div>
        ),
      },
      { key: 'oem', header: 'Manufacturer', render: (r) => <span className="text-slate-300">{nameOf(vendors, r.oem_vendor_id)}</span> },
      { key: 'type', header: 'Type', sortKey: 'program_type', render: (r) => <span className="text-slate-300">{labelOf(PROGRAM_TYPE, r.program_type)}</span> },
      {
        key: 'treatment',
        header: 'Posts as',
        render: (r) => (
          <span className="text-slate-400" title={TREATMENT[r.treatment]?.hint}>
            {labelOf(TREATMENT, r.treatment)}
            {r.paid_direct && <span className="block text-2xs text-slate-500">Paid direct — no dealer entry</span>}
          </span>
        ),
      },
      {
        key: 'dates',
        header: 'Runs',
        sortKey: 'start_date',
        render: (r) => (
          <Mono className="text-xs text-slate-400">
            {r.start_date || r.end_date ? `${dateLabel(r.start_date)} – ${dateLabel(r.end_date)}` : 'Open-ended'}
          </Mono>
        ),
      },
      { key: 'deadline', header: 'Claim within', align: 'right', render: (r) => <Mono className="text-slate-400">{r.claim_deadline_days != null ? `${r.claim_deadline_days} days` : '—'}</Mono> },
      {
        key: 'status',
        header: 'Status',
        sortKey: 'status',
        render: (r) => <Pill label={r.source_document_id && r.status === 'DRAFT' ? 'AI drafted — needs approval' : labelOf(OEM_PROGRAM_STATUS, r.status)} tone={r.source_document_id && r.status === 'DRAFT' ? 'ai' : toneOf(OEM_PROGRAM_STATUS, r.status)} />,
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (r) => (
          <div className="flex justify-end gap-1.5">
            {r.status === 'DRAFT' && (
              <>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(r)}>
                  Edit
                </button>
                <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirm({ program: r, status: 'ACTIVE' })}>
                  Approve
                </button>
              </>
            )}
            {r.status === 'ACTIVE' && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => setConfirm({ program: r, status: 'EXPIRED' })}>
                Expire
              </button>
            )}
          </div>
        ),
      },
    ],
    [vendors],
  );

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
        <Segments<Seg>
          label="Program status"
          value={seg}
          onChange={(v) => list.setFilter('status', v === 'ALL' ? null : v)}
          options={[
            { value: 'DRAFT', label: 'Drafts' },
            { value: 'ACTIVE', label: 'Active' },
            { value: 'EXPIRED', label: 'Expired' },
            { value: 'ALL', label: 'All' },
          ]}
        />
        <div className="flex gap-2">
          <Link href={dealerLinks.imports()} className="btn-secondary btn-sm">
            Draft from a bulletin (AI)
          </Link>
          <button type="button" className="btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus size={13} /> New program
          </button>
        </div>
      </div>
      <TableToolbar>
        <div className="relative w-full max-w-xs">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input aria-label="Search programs" value={state.search} onChange={(e) => list.setSearch(e.target.value)} placeholder="Program name or code…" className="input pl-8" />
        </div>
        <div className="w-56">
          <LookupPicker kind="vendors" aria-label="Filter by manufacturer" value={state.filters.oem_vendor_id ?? null} onChange={(v) => list.setFilter('oem_vendor_id', v)} placeholder="All manufacturers" />
        </div>
      </TableToolbar>
      <DealerTable<OemProgramRecord>
        caption="Manufacturer programs"
        columns={columns}
        rows={rows}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        sort={state.sort}
        dir={state.dir}
        onSort={list.setSort}
        page={state.page}
        perPage={state.perPage}
        total={list.data?.total ?? 0}
        noun="programs"
        onPageChange={list.setPage}
        keyboard={false}
        empty={
          state.search || state.filters.status || state.filters.oem_vendor_id
            ? { icon: Search, title: 'No programs match', description: 'Try another status, manufacturer or search.' }
            : {
                icon: Gift,
                title: 'No manufacturer programs yet',
                description: 'Add the dealer rebates, volume bonuses, co-op and holdback programs this client earns — or let AI draft them from a program bulletin.',
                action: (
                  <button type="button" className="btn-primary btn-sm" onClick={() => setCreating(true)}>
                    <Plus size={13} /> New program
                  </button>
                ),
              }
        }
      />
      <ProgramForm open={creating || !!editing} onClose={() => { setCreating(false); setEditing(null); }} initial={editing} locationId={locationId} onSaved={() => void list.refetch()} />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => {
          setConfirm(null);
          setError(null);
        }}
        title={confirm?.status === 'ACTIVE' ? `Approve “${confirm?.program.name ?? ''}”?` : `Expire “${confirm?.program.name ?? ''}”?`}
        confirmLabel={confirm?.status === 'ACTIVE' ? 'Approve program' : 'Expire program'}
        danger={confirm?.status === 'EXPIRED'}
        busy={busy}
        body={
          confirm?.status === 'ACTIVE' ? (
            <div className="space-y-2">
              <p>
                Approving turns the program on: incentives can be recorded under it, and they post as <span className="text-slate-100">{labelOf(TREATMENT, confirm.program.treatment).toLowerCase()}</span>.
              </p>
              {confirm.program.source_document_id && <p className="text-indigo-300">AI drafted this program from a bulletin. Check the type, dates and claim deadline against the bulletin first.</p>}
              <p className="text-xs text-slate-500">Needs the settings permission; your approval is recorded on the program.</p>
            </div>
          ) : (
            <p>No new incentives can be recorded under it. Claims already earned stay open until they’re paid or written off.</p>
          )
        }
        error={error ? <ErrorPanel error={error} compact /> : null}
        onConfirm={() => setStatus()}
      />
    </section>
  );
}
