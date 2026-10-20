'use client';

/**
 * Submit accepted import rows through the D1 routes, a few at a time, with importBatchId
 * on every row-creating call. Every row lands PROPOSED (or as an opening balance with no
 * GL); a person approves postings in the screens the done-step links to. Re-importing
 * the same row is reported as "already imported" — never as an error.
 */

import type { LenderStatementBody, OemStatementBody, RowPlan } from '@/lib/dealer/imports/targets';
import { explainDealerError } from '@/lib/dealer/ui/errors';
import { dealerSend, type DealerResult } from '../../_lib/use-dealer';

export type OutcomeStatus = 'created' | 'proposed' | 'posted' | 'existing' | 'failed';

export interface RowOutcome {
  /** Row index in the review list. */
  index: number;
  /** 1-based file row (or null for AI rows). */
  sourceRow: number | null;
  status: OutcomeStatus;
  message?: string;
}

const PATH: Record<Exclude<RowPlan['target'], 'lenderLine' | 'oemLine'>, string> = {
  unit: '/api/dealer/units',
  floor: '/api/dealer/floor',
  sale: '/api/dealer/sales',
  warranty: '/api/dealer/warranty',
  program: '/api/dealer/oem-programs',
};

function isAlready(res: DealerResult<unknown>): boolean {
  return res.error?.code === 'CONFLICT' && /already exists|duplicate key/i.test(res.error.error);
}

function classify(plan: RowPlan, res: DealerResult<unknown>, batchId: string): { status: OutcomeStatus; message?: string } {
  if (res.error) {
    if (isAlready(res)) return { status: 'existing', message: 'Already imported — nothing new was created.' };
    const x = explainDealerError(res.error);
    return { status: 'failed', message: `${x.title}. ${x.message}` };
  }
  if (plan.target === 'floor') {
    const d = res.data as { disposition?: string; reason?: string } | null;
    if (d?.disposition === 'EXISTING') return { status: 'existing', message: 'This flooring was already imported — nothing posted.' };
    if (d?.disposition === 'POSTED') return { status: 'posted', message: 'Posted automatically under your autonomy setting (exact match to the dealer system).' };
    if (d?.disposition === 'OPENING') return { status: 'created', message: 'Opening balance loaded (no journal entry).' };
    return { status: 'proposed', message: 'Flooring proposed — awaiting approval.' };
  }
  if (plan.target === 'sale') {
    const d = res.data as { sale?: { import_batch_id?: string | null } } | null;
    if (d?.sale && d.sale.import_batch_id !== batchId) return { status: 'existing', message: 'This deal number was already imported.' };
    return { status: 'proposed', message: 'Deal proposed — awaiting approval.' };
  }
  if (plan.target === 'program') return { status: 'proposed', message: 'Saved as a draft program.' };
  if (plan.target === 'warranty') return { status: 'created', message: 'Draft claim created.' };
  return { status: 'created' };
}

export interface SubmitItem {
  index: number;
  sourceRow: number | null;
  plan: RowPlan;
}

/** Create rows with up to 4 requests in flight. Stops early when `isCancelled()` turns true. */
export async function submitRows(
  locationId: string,
  batchId: string,
  items: SubmitItem[],
  onProgress: (done: number, outcome: RowOutcome) => void,
  isCancelled: () => boolean,
): Promise<RowOutcome[]> {
  const out: RowOutcome[] = [];
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length && !isCancelled()) {
      const it = items[next++];
      if (it.plan.target === 'lenderLine' || it.plan.target === 'oemLine') continue;
      const res = await dealerSend<unknown>('post', PATH[it.plan.target], locationId, it.plan.body as Record<string, unknown>);
      const c = classify(it.plan, res, batchId);
      const o: RowOutcome = { index: it.index, sourceRow: it.sourceRow, ...c };
      out.push(o);
      done += 1;
      onProgress(done, o);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return out.sort((a, b) => a.index - b.index);
}

export type StatementOutcome =
  | { ok: true; statementId: string; lineCount: number; existing: boolean }
  | { ok: false; message: string; problems: string[] };

export async function submitLenderStatement(locationId: string, body: LenderStatementBody): Promise<StatementOutcome> {
  const res = await dealerSend<{ statement: { id: string }; lineCount: number }>('post', '/api/dealer/lender-statements', locationId, body as unknown as Record<string, unknown>);
  return statementOutcome(res, (d) => ({ id: d.statement.id, n: d.lineCount }));
}

export async function submitOemStatement(locationId: string, body: OemStatementBody): Promise<StatementOutcome> {
  const res = await dealerSend<{ id: string; lineCount: number }>('post', '/api/dealer/oem-statements', locationId, body as unknown as Record<string, unknown>);
  return statementOutcome(res, (d) => ({ id: d.id, n: d.lineCount }));
}

function statementOutcome<T>(res: DealerResult<T>, pick: (d: T) => { id: string; n: number }): StatementOutcome {
  if (res.error || !res.data) {
    if (isAlready(res as DealerResult<unknown>)) {
      return { ok: false, message: 'A statement for this line and date was already imported.', problems: [] };
    }
    const x = explainDealerError(res.error);
    const d = res.error?.details as { problems?: unknown } | undefined;
    const problems = Array.isArray(d?.problems) ? d!.problems.filter((p): p is string => typeof p === 'string') : [];
    return { ok: false, message: `${x.title}. ${x.message}`, problems };
  }
  const p = pick(res.data);
  return { ok: true, statementId: p.id, lineCount: p.n, existing: false };
}

export interface BatchError {
  row: number | null;
  message: string;
}

/** Record the outcome on the batch (PROPOSED when anything landed, else FAILED). */
export async function finishBatch(
  locationId: string,
  batchId: string,
  totals: { rowCount: number; accepted: number; rejected: number; errors: BatchError[] },
): Promise<DealerResult<unknown>> {
  return dealerSend('patch', '/api/dealer/imports', locationId, {
    id: batchId,
    status: totals.accepted > 0 ? 'PROPOSED' : 'FAILED',
    rowCount: totals.rowCount,
    acceptedCount: totals.accepted,
    rejectedCount: totals.rejected,
    errors: totals.errors.slice(0, 5000),
  });
}

/** Mark an abandoned upload so it doesn't sit as "Uploaded" forever. */
export async function abandonBatch(locationId: string, batchId: string, message = 'Cancelled before anything was imported.'): Promise<void> {
  await dealerSend('patch', '/api/dealer/imports', locationId, { id: batchId, status: 'FAILED', errors: [{ row: null, message }] });
}
