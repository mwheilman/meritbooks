'use client';

/**
 * Manufacturer statements (oem_statements): every statement this client has
 * entered or imported, newest first, opening into the credit-matching workspace.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileSpreadsheet, Plus, Upload } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { OEM_STATEMENT_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel, money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { OemStatementRow } from '@/lib/dealer/ui/claims';
import type { OemStatementStatus } from '@/lib/dealer/types';
import { nameOf, useDealerList, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { LookupPicker } from '../../_components/lookup-picker';
import { Mono, Pill } from '../../_components/ui';
import { StatementEntryModal } from './statement-entry-modal';

type Seg = 'ALL' | OemStatementStatus;

export function StatementsList() {
  const { locationId } = useDealerPack();
  const router = useRouter();
  const list = useDealerList<OemStatementRow>('/api/dealer/oem-statements', { sort: 'statement_date' });
  const { state } = list;
  const rows = list.data?.rows ?? [];
  const vendors = useNames('vendors', rows.map((r) => r.oem_vendor_id));
  const [entering, setEntering] = useState(false);

  const columns = useMemo<DealerColumn<OemStatementRow>[]>(
    () => [
      { key: 'date', header: 'Statement date', sortKey: 'statement_date', render: (r) => <Mono className="text-slate-200">{dateLabel(r.statement_date)}</Mono> },
      { key: 'oem', header: 'Manufacturer', render: (r) => <span className="text-slate-200">{nameOf(vendors, r.oem_vendor_id)}</span> },
      { key: 'source', header: 'Source', render: (r) => <span className="text-xs text-slate-400">{r.import_batch_id ? 'Imported' : r.document_id ? 'From a document' : 'Entered by hand'}</span> },
      { key: 'total', header: 'Statement total', align: 'right', render: (r) => <Mono className={r.footer_total_cents !== null && r.footer_total_cents < 0 ? 'text-red-400' : 'text-white'}>{money(r.footer_total_cents)}</Mono> },
      { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <Pill label={labelOf(OEM_STATEMENT_STATUS, r.status)} tone={toneOf(OEM_STATEMENT_STATUS, r.status)} /> },
    ],
    [vendors],
  );

  if (!locationId) return null;
  const seg = (state.filters.status as Seg | undefined) ?? 'ALL';

  return (
    <div>
      <PageHeader
        title="Manufacturer statements"
        description="Match the credits on each manufacturer statement to the warranty and incentive claims they pay."
        actions={
          <>
            <Link href={dealerLinks.imports()} className="btn-secondary btn-sm">
              <Upload size={13} /> Import (AI / CSV)
            </Link>
            <button type="button" className="btn-primary btn-sm" onClick={() => setEntering(true)}>
              <Plus size={13} /> Enter statement
            </button>
          </>
        }
      />
      <section className="card overflow-hidden">
        <div className="border-b border-slate-800 px-5 py-3">
          <Segments<Seg>
            label="Statement status"
            value={seg}
            onChange={(v) => list.setFilter('status', v === 'ALL' ? null : v)}
            options={[
              { value: 'IMPORTED', label: 'Not matched yet' },
              { value: 'MATCHING', label: 'Matching' },
              { value: 'SETTLED', label: 'All applied' },
              { value: 'ALL', label: 'All' },
            ]}
          />
        </div>
        <TableToolbar>
          <div className="w-56">
            <LookupPicker kind="vendors" aria-label="Filter by manufacturer" value={state.filters.oem_vendor_id ?? null} onChange={(v) => list.setFilter('oem_vendor_id', v)} placeholder="All manufacturers" />
          </div>
        </TableToolbar>
        <DealerTable<OemStatementRow>
          caption="Manufacturer statements"
          columns={columns}
          rows={rows}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={() => void list.refetch()}
          sort={state.sort}
          dir={state.dir}
          onSort={list.setSort}
          onRowClick={(r) => router.push(dealerLinks.oemStatement(r.id))}
          page={state.page}
          perPage={state.perPage}
          total={list.data?.total ?? 0}
          noun="statements"
          onPageChange={list.setPage}
          empty={
            state.filters.status || state.filters.oem_vendor_id
              ? { icon: FileSpreadsheet, title: 'No statements match', description: 'Try another status or manufacturer.' }
              : {
                  icon: FileSpreadsheet,
                  title: 'No manufacturer statements yet',
                  description: 'Enter a statement by hand or import the PDF / spreadsheet — then match its credits to open warranty and incentive claims.',
                  action: (
                    <div className="flex gap-2">
                      <button type="button" className="btn-primary btn-sm" onClick={() => setEntering(true)}>
                        <Plus size={13} /> Enter statement
                      </button>
                      <Link href={dealerLinks.imports()} className="btn-secondary btn-sm">
                        Import
                      </Link>
                    </div>
                  ),
                }
          }
        />
      </section>
      <StatementEntryModal open={entering} onClose={() => setEntering(false)} locationId={locationId} />
    </div>
  );
}
