'use client';

/**
 * Import batch detail — header, counts, refused rows, the rows the batch created and
 * Undo (POST /api/dealer/imports/undo). Undo is refused while anything in the batch has
 * posted; the blockers are listed in plain English.
 */

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileText, Undo2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import type { NoteStatus, RowStatus, UnitStatus, WarrantyStatus } from '@/lib/dealer/types';
import { FILE_KIND, IMPORT_STATUS, NOTE_STATUS, ROW_STATUS, STATEMENT_KIND, STATEMENT_STATUS, UNIT_STATUS, WARRANTY_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { explainDealerError, type DealerApiError } from '@/lib/dealer/ui/errors';
import { useDealerPack } from '../../_components/dealer-shell';
import { ConfirmDialog } from '../../_components/forms';
import { DefList, Empty, ErrorPanel, Money, Mono, Notice, Pill, Section, Spinner } from '../../_components/ui';
import { dealerGet, dealerSend, type ListPage } from '../../_lib/use-dealer';
import { whenLabel, type BatchRow } from './imports-screen';

export interface BatchStatementRow {
  id: string;
  type: 'lender' | 'oem';
  kind: string | null;
  statementDate: string;
  status: string;
  totalCents: number | null;
}

interface BatchErrorItem {
  row: number | null;
  message: string;
}

function parseErrors(v: unknown): BatchErrorItem[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e) => {
    if (typeof e === 'string') return [{ row: null, message: e }];
    if (e && typeof e === 'object') {
      const o = e as { row?: unknown; message?: unknown };
      return [{ row: typeof o.row === 'number' ? o.row : null, message: typeof o.message === 'string' ? o.message : JSON.stringify(e) }];
    }
    return [];
  });
}

interface UnitRow { id: string; serial_number: string; model: string | null; status: UnitStatus }
interface NoteRow { id: string; lender_invoice_number: string; principal_balance_cents: number; status: NoteStatus; unit_id: string | null }
interface SaleRow { id: string; external_deal_ref: string | null; sale_date: string; sale_price_cents: number; status: RowStatus }
interface ClaimRow { id: string; oem_claim_number: string | null; dealer_claim_ref: string | null; repair_order_ref: string | null; claimed_cents: number; status: WarrantyStatus }

function useBatchList<R>(path: string, locationId: string, batchId: string) {
  const [data, setData] = useState<ListPage<R> | null>(null);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void dealerGet<ListPage<R>>(path, locationId, { import_batch_id: batchId, per_page: 100, sort: 'created_at' }).then((res) => {
      if (cancelled) return;
      setData(res.data);
      setError(res.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [path, locationId, batchId, round]);
  return { data, error, isLoading, refetch: async () => setRound((n) => n + 1) };
}

function CreatedList<R extends { id: string }>({
  title,
  path,
  locationId,
  batchId,
  render,
}: {
  title: string;
  path: string;
  locationId: string;
  batchId: string;
  render: (r: R) => ReactNode;
}) {
  // The batch's OWN client is passed explicitly (it may differ from the active client).
  const q = useBatchList<R>(path, locationId, batchId);
  if (q.isLoading) return <div className="px-5 py-3 text-xs text-slate-500">Loading {title.toLowerCase()}…</div>;
  if (q.error) return <ErrorPanel error={q.error} onRetry={() => void q.refetch()} compact />;
  const rows = q.data?.rows ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-slate-800 first:border-t-0">
      <h3 className="px-5 pt-3 text-caption uppercase tracking-caps text-slate-500">
        {title} <span className="font-mono tabular-nums">{q.data?.total ?? rows.length}</span>
      </h3>
      <ul className="divide-y divide-slate-800/70 text-sm">{rows.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2">{render(r)}</li>)}</ul>
      {(q.data?.total ?? 0) > rows.length && <p className="px-5 pb-3 text-xs text-slate-500">Showing the first {rows.length}.</p>}
    </div>
  );
}

export function BatchDetail({ batch, statements, statementsError }: { batch: BatchRow; statements: BatchStatementRow[]; statementsError: string | null }) {
  const router = useRouter();
  const pack = useDealerPack();
  const [undoOpen, setUndoOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undoError, setUndoError] = useState<{ err: DealerApiError; blockers: string[] } | null>(null);
  const errors = parseErrors(batch.errors);
  const otherClient = pack.locationId !== null && pack.locationId !== batch.location_id;
  const loc = batch.location_id;

  async function undo() {
    setBusy(true);
    setUndoError(null);
    const res = await dealerSend<{ voided: Record<string, number> }>('post', '/api/dealer/imports/undo', loc, { id: batch.id });
    setBusy(false);
    if (res.error) {
      const d = res.error.details as { blockers?: unknown } | undefined;
      const blockers = Array.isArray(d?.blockers) ? d!.blockers.filter((x): x is string => typeof x === 'string') : [];
      setUndoError({ err: res.error, blockers });
      return;
    }
    const v = res.data?.voided ?? {};
    const n = Object.values(v).reduce((s, x) => s + x, 0);
    addToast('success', `Import undone — ${n} row${n === 1 ? '' : 's'} voided`);
    setUndoOpen(false);
    router.refresh();
  }

  async function openSource() {
    if (!batch.document_id) return;
    const res = await api.get<{ url?: string; signedUrl?: string }>(`/api/documents/${batch.document_id}/signed-url?download=0`);
    const url = res.data?.url ?? res.data?.signedUrl;
    if (res.error || !url) addToast('error', res.error?.error ?? 'Could not open the file');
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  const canUndo = batch.status !== 'UNDONE';

  return (
    <div>
      <Link href={dealerLinks.imports()} className="mb-3 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
        <ArrowLeft size={12} /> All imports
      </Link>
      <PageHeader
        title={`${labelOf(FILE_KIND, batch.file_kind)} import`}
        description={batch.file_name ?? undefined}
        actions={
          <>
            {batch.document_id && (
              <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => void openSource()}>
                <FileText size={13} /> View source file
              </button>
            )}
            {canUndo && (
              <button type="button" className="btn-danger btn-sm inline-flex items-center gap-1.5" onClick={() => setUndoOpen(true)}>
                <Undo2 size={13} /> Undo import
              </button>
            )}
          </>
        }
      />

      {otherClient && <Notice tone="info">This import belongs to a different client than the one selected. Its rows are shown for that client.</Notice>}

      <Section title="Summary">
        <div className="px-5 py-4">
          <DefList
            items={[
              { label: 'Status', value: <Pill label={labelOf(IMPORT_STATUS, batch.status)} tone={toneOf(IMPORT_STATUS, batch.status)} /> },
              { label: 'Imported', value: whenLabel(batch.created_at) },
              { label: 'Source', value: batch.source_system },
              { label: 'Rows read', value: batch.row_count.toLocaleString(), mono: true },
              { label: 'Accepted', value: <span className="text-emerald-400">{batch.accepted_count.toLocaleString()}</span>, mono: true },
              { label: 'Rejected', value: <span className={batch.rejected_count ? 'text-amber-300' : undefined}>{batch.rejected_count.toLocaleString()}</span>, mono: true },
            ]}
          />
        </div>
      </Section>

      {errors.length > 0 && (
        <Section title="Refused rows" description="Rows that weren’t imported, with the reason. Fix them in the source file and import again — rows already imported are recognized and skipped.">
          <ul className="max-h-80 divide-y divide-slate-800/70 overflow-y-auto text-sm">
            {errors.map((e, i) => (
              <li key={i} className="flex gap-4 px-5 py-2">
                <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-slate-500">{e.row ? `Row ${e.row}` : '—'}</span>
                <span className="text-amber-200/90">{e.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="What this import created" description="Everything lands as a proposal or a draft — a person approves postings on each screen.">
        {statementsError && <ErrorPanel error={{ error: statementsError, code: 'DB_ERROR' }} compact />}
        {statements.length > 0 && (
          <div>
            <h3 className="px-5 pt-3 text-caption uppercase tracking-caps text-slate-500">Statements</h3>
            <ul className="divide-y divide-slate-800/70 text-sm">
              {statements.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2">
                  <Link href={s.type === 'lender' ? dealerLinks.lenderStatement(s.id) : dealerLinks.oemStatement(s.id)} className="text-emerald-400 hover:text-emerald-300">
                    {s.type === 'lender' ? labelOf(STATEMENT_KIND, s.kind) : 'Manufacturer statement'} · {dateLabel(s.statementDate)}
                  </Link>
                  <span className="flex items-center gap-3">
                    <Money cents={s.totalCents} />
                    <Pill label={labelOf(STATEMENT_STATUS, s.status)} tone={toneOf(STATEMENT_STATUS, s.status)} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <CreatedList<UnitRow>
          title="Units"
          path="/api/dealer/units"
          locationId={loc}
          batchId={batch.id}
          render={(u) => (
            <>
              <Link href={dealerLinks.unit(u.id)} className="font-mono text-emerald-400 hover:text-emerald-300">{u.serial_number}</Link>
              <span className="flex items-center gap-3 text-slate-400">
                {u.model ?? ''}
                <Pill label={labelOf(UNIT_STATUS, u.status)} tone={toneOf(UNIT_STATUS, u.status)} />
              </span>
            </>
          )}
        />
        <CreatedList<NoteRow>
          title="Floor-plan notes"
          path="/api/dealer/notes"
          locationId={loc}
          batchId={batch.id}
          render={(n) => (
            <>
              <Link href={dealerLinks.note(n.id)} className="font-mono text-emerald-400 hover:text-emerald-300">{n.lender_invoice_number}</Link>
              <span className="flex items-center gap-3">
                <Money cents={n.principal_balance_cents} />
                <Pill label={labelOf(NOTE_STATUS, n.status)} tone={toneOf(NOTE_STATUS, n.status)} />
              </span>
            </>
          )}
        />
        <CreatedList<SaleRow>
          title="Deals"
          path="/api/dealer/sales"
          locationId={loc}
          batchId={batch.id}
          render={(s) => (
            <>
              <Link href={dealerLinks.deal(s.id)} className="text-emerald-400 hover:text-emerald-300">
                Deal <Mono>{s.external_deal_ref ?? '—'}</Mono> · {dateLabel(s.sale_date)}
              </Link>
              <span className="flex items-center gap-3">
                <Money cents={s.sale_price_cents} />
                <Pill label={labelOf(ROW_STATUS, s.status)} tone={toneOf(ROW_STATUS, s.status)} />
              </span>
            </>
          )}
        />
        <CreatedList<ClaimRow>
          title="Warranty claims"
          path="/api/dealer/warranty"
          locationId={loc}
          batchId={batch.id}
          render={(c) => (
            <>
              <Link href={dealerLinks.warranty({ claim: c.id })} className="font-mono text-emerald-400 hover:text-emerald-300">
                {c.oem_claim_number ?? c.dealer_claim_ref ?? c.repair_order_ref ?? 'Claim'}
              </Link>
              <span className="flex items-center gap-3">
                <Money cents={c.claimed_cents} />
                <Pill label={labelOf(WARRANTY_STATUS, c.status)} tone={toneOf(WARRANTY_STATUS, c.status)} />
              </span>
            </>
          )}
        />
        {batch.file_kind === 'PROGRAMS' && (
          <div className="border-t border-slate-800 px-5 py-3 text-sm text-slate-400">
            Programs from this import are drafts under{' '}
            <Link href={dealerLinks.incentives({ tab: 'programs' })} className="text-emerald-400 hover:text-emerald-300">Incentives → Programs</Link>.
          </div>
        )}
        {batch.accepted_count === 0 && statements.length === 0 && (
          <Empty icon={FileText} title="Nothing was created" description="This import didn’t create any rows." />
        )}
      </Section>

      <ConfirmDialog
        open={undoOpen}
        onClose={() => {
          setUndoOpen(false);
          setUndoError(null);
        }}
        onConfirm={() => void undo()}
        title="Undo this import?"
        busy={busy}
        danger
        confirmLabel="Undo import"
        body={
          <>
            Every unit, flooring, deal and claim this import created is voided, and its statements are removed. This only works while nothing from it has posted to
            the ledger.
          </>
        }
        error={
          undoError ? (
            <div role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] p-3 text-xs text-amber-100">
              {undoError.blockers.length > 0 ? (
                <>
                  <p className="font-medium">These rows were already posted, so the batch can’t be undone:</p>
                  <ul className="mt-1 list-disc pl-4">
                    {undoError.blockers.map((b) => <li key={b}>{b}</li>)}
                  </ul>
                  <p className="mt-1 text-amber-200/80">Reverse those postings first, then undo the import.</p>
                </>
              ) : (
                <p>{explainDealerError(undoError.err).message}</p>
              )}
            </div>
          ) : undefined
        }
      />
      {!pack.locationId && pack.isLoading && <Spinner />}
    </div>
  );
}
