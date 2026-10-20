'use client';

/**
 * Dealer imports — every import batch for the client (when, what, file, source, rows
 * accepted / rejected, status) with the "Import a file" wizard on top. Server-paginated
 * and sortable over GET /api/dealer/imports.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Inbox, Rocket } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import type { ImportFileKind, ImportStatus } from '@/lib/dealer/types';
import { FILE_KIND, IMPORT_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { Select } from '../../_components/forms';
import { Mono, Pill } from '../../_components/ui';
import { useDealerList } from '../../_lib/use-dealer';
import { ImportWizard } from './import-wizard';

export interface BatchRow {
  id: string;
  location_id: string;
  source_system: string;
  file_kind: ImportFileKind;
  file_name: string | null;
  document_id: string | null;
  row_count: number;
  accepted_count: number;
  rejected_count: number;
  errors: unknown;
  status: ImportStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_SEGMENTS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'PROPOSED', label: 'Awaiting approval' },
  { value: 'UPLOADED,VALIDATED', label: 'In progress' },
  { value: 'POSTED', label: 'Posted' },
  { value: 'FAILED,UNDONE', label: 'Failed / undone' },
];

const KIND_OPTIONS = (Object.keys(FILE_KIND) as ImportFileKind[]).map((k) => ({ value: k, label: FILE_KIND[k].label }));

export function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ImportsScreen({ initialWizard }: { initialWizard: { open: boolean; kind: ImportFileKind | null } }) {
  const router = useRouter();
  const pack = useDealerPack();
  const [wizard, setWizard] = useState<{ open: boolean; kind: ImportFileKind | null; key: number }>({ ...initialWizard, key: 0 });
  const list = useDealerList<BatchRow>('/api/dealer/imports', { sort: 'created_at', dir: 'desc' });
  const { state, setFilter, setSort, setPage } = list;
  const rows = list.data?.rows ?? [];
  const statusValue = state.filters.status ?? 'all';

  const columns: DealerColumn<BatchRow>[] = [
    { key: 'when', header: 'When', sortKey: 'created_at', render: (b) => <Mono className="whitespace-nowrap text-slate-300">{whenLabel(b.created_at)}</Mono> },
    { key: 'kind', header: 'What', sortKey: 'file_kind', render: (b) => <span className="text-slate-200">{labelOf(FILE_KIND, b.file_kind)}</span> },
    { key: 'file', header: 'File', render: (b) => <span className="block max-w-[16rem] truncate font-mono text-xs text-slate-400" title={b.file_name ?? ''}>{b.file_name ?? '—'}</span> },
    { key: 'source', header: 'Source', render: (b) => <span className="text-slate-400">{b.source_system}</span> },
    { key: 'rows', header: 'Rows', align: 'right', render: (b) => <Mono className="text-slate-300">{b.row_count.toLocaleString()}</Mono> },
    { key: 'ok', header: 'Accepted', align: 'right', render: (b) => <Mono className={b.accepted_count ? 'text-emerald-400' : 'text-slate-500'}>{b.accepted_count.toLocaleString()}</Mono> },
    { key: 'bad', header: 'Rejected', align: 'right', render: (b) => <Mono className={b.rejected_count ? 'text-amber-300' : 'text-slate-500'}>{b.rejected_count.toLocaleString()}</Mono> },
    { key: 'status', header: 'Status', sortKey: 'status', render: (b) => <Pill label={labelOf(IMPORT_STATUS, b.status)} tone={toneOf(IMPORT_STATUS, b.status)} /> },
  ];

  const open = (kind: ImportFileKind | null) => setWizard((w) => ({ open: true, kind, key: w.key + 1 }));

  return (
    <div>
      <PageHeader
        title="Imports"
        description="Bring in dealer-system exports, lender statements and manufacturer statements. Every row lands as a proposal — nothing posts until a person approves it."
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => open('OPENING')} disabled={!pack.locationId}>
              <Rocket size={13} /> Go-live opening import
            </button>
            <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => open(null)} disabled={!pack.locationId}>
              <FileUp size={13} /> Import a file
            </button>
          </>
        }
      />

      {wizard.open && (
        <ImportWizard
          key={wizard.key}
          initialKind={wizard.kind}
          onClose={() => setWizard((w) => ({ ...w, open: false }))}
          onFinished={() => void list.refetch()}
        />
      )}

      <div className="card overflow-hidden">
        <TableToolbar>
          <Segments label="Import status" value={statusValue} onChange={(v) => setFilter('status', v === 'all' ? null : v)} options={STATUS_SEGMENTS} />
          <div className="w-52">
            <Select<ImportFileKind | ''>
              aria-label="Filter by kind"
              value={(state.filters.file_kind as ImportFileKind | undefined) ?? ''}
              onChange={(v) => setFilter('file_kind', v || null)}
              options={KIND_OPTIONS}
              placeholder="Every kind"
            />
          </div>
        </TableToolbar>
        <DealerTable<BatchRow>
          columns={columns}
          rows={rows}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={state.sort}
          dir={state.dir}
          onSort={setSort}
          onRowClick={(b) => router.push(dealerLinks.importBatch(b.id))}
          empty={{
            icon: Inbox,
            title: state.filters.status || state.filters.file_kind ? 'No imports match' : 'No imports yet',
            description: 'No imports yet — export from your dealer system or forward the lender’s statement.',
            action: (
              <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={() => open(null)} disabled={!pack.locationId}>
                <FileUp size={13} /> Import a file
              </button>
            ),
          }}
          page={list.data?.page ?? state.page}
          perPage={list.data?.perPage ?? state.perPage}
          total={list.data?.total ?? 0}
          noun="imports"
          onPageChange={setPage}
          caption="Import batches"
        />
      </div>
    </div>
  );
}
