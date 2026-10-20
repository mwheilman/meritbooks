'use client';

/** Wizard step 4 — progress while rows are created, then the outcome and where to approve. */

import Link from 'next/link';
import { ArrowRight, CheckCircle2, CircleSlash, Loader2, RotateCcw } from 'lucide-react';
import type { ImportFileKind } from '@/lib/dealer/types';
import { ROW_NOUN } from '@/lib/dealer/imports/fields';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { RowOutcome } from '../_lib/submit';

export interface DoneState {
  running: boolean;
  done: number;
  total: number;
  outcomes: RowOutcome[];
  /** Rows refused before submit (validation) — listed on the batch. */
  skipped: number;
  statement: { id: string; lineCount: number } | null;
  statementError: { message: string; problems: string[] } | null;
  finishError: string | null;
}

function nextLinks(kind: ImportFileKind, statementId: string | null, hasFloorings: boolean): Array<{ href: string; label: string; primary?: boolean }> {
  switch (kind) {
    case 'UNITS':
      return [
        ...(hasFloorings ? [{ href: dealerLinks.floorPlan('setup'), label: 'Approve proposed floorings', primary: true }] : []),
        { href: dealerLinks.units(), label: 'Open the unit register', primary: !hasFloorings },
      ];
    case 'OPENING':
      return [
        { href: dealerLinks.settings('enable'), label: 'Check the opening tie-out', primary: true },
        { href: dealerLinks.units(), label: 'Open the unit register' },
      ];
    case 'DEALS':
      return [{ href: dealerLinks.deals({ status: 'PROPOSED' }), label: 'Review the proposed deals', primary: true }];
    case 'WARRANTY':
      return [{ href: dealerLinks.warranty({ status: 'DRAFT' }), label: 'Review the draft claims', primary: true }];
    case 'LENDER_STATEMENT':
    case 'LENDER_AUDIT':
      return statementId ? [{ href: dealerLinks.lenderStatement(statementId), label: 'Reconcile this statement', primary: true }] : [{ href: dealerLinks.lenderStatements(), label: 'Lender statements' }];
    case 'OEM_STATEMENT':
      return statementId ? [{ href: dealerLinks.oemStatement(statementId), label: 'Match credits to claims', primary: true }] : [{ href: dealerLinks.oemStatements(), label: 'Manufacturer statements' }];
    case 'PROGRAMS':
      return [{ href: dealerLinks.incentives({ tab: 'programs' }), label: 'Approve the draft programs', primary: true }];
  }
}

export function StepDone({ kind, batchId, state, onAnother }: { kind: ImportFileKind; batchId: string; state: DoneState; onAnother: () => void }) {
  const noun = ROW_NOUN[kind];
  const count = (s: RowOutcome['status']) => state.outcomes.filter((o) => o.status === s).length;
  const created = count('created') + count('proposed');
  const posted = count('posted');
  const existing = count('existing');
  const failed = state.outcomes.filter((o) => o.status === 'failed');
  const hasFloorings = state.outcomes.some((o) => o.status === 'proposed' && /flooring/i.test(o.message ?? ''));
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 100;

  if (state.running) {
    return (
      <div className="py-10 text-center" role="status" aria-live="polite">
        <Loader2 size={22} className="mx-auto mb-3 animate-spin text-emerald-400" />
        <p className="text-sm text-slate-300">
          Importing <span className="font-mono tabular-nums">{state.done}</span> of <span className="font-mono tabular-nums">{state.total}</span>…
        </p>
        <div className="mx-auto mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-slate-800" aria-hidden>
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-3 text-xs text-slate-500">Keep this page open until it finishes.</p>
      </div>
    );
  }

  const links = nextLinks(kind, state.statement?.id ?? null, hasFloorings);

  return (
    <div className="space-y-5">
      {state.statementError ? (
        <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/[0.05] p-4 text-sm text-amber-100">
          <p className="font-medium">{state.statementError.message}</p>
          {state.statementError.problems.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-amber-200/90">
              {state.statementError.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] p-4">
          <CheckCircle2 size={18} className="mt-0.5 text-emerald-400" />
          <div className="text-sm text-slate-300">
            {state.statement ? (
              <p className="text-white">
                Statement imported with <span className="font-mono tabular-nums">{state.statement.lineCount}</span> lines. Matching and sign-off happen next.
              </p>
            ) : (
              <p className="text-white">
                <span className="font-mono tabular-nums">{created}</span> {noun}
                {created === 1 ? '' : 's'} created as proposals
                {posted > 0 && <>, <span className="font-mono tabular-nums">{posted}</span> posted under your autonomy setting</>}
                {existing > 0 && <>, <span className="font-mono tabular-nums">{existing}</span> already imported</>}.
              </p>
            )}
            <p className="mt-1 text-slate-400">Nothing posts to the ledger until a person approves it.</p>
          </div>
        </div>
      )}

      {(failed.length > 0 || state.skipped > 0) && (
        <div className="rounded-lg border border-slate-800">
          <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2 text-sm text-slate-300">
            <CircleSlash size={14} className="text-amber-400" />
            {failed.length > 0 && <span><span className="font-mono tabular-nums">{failed.length}</span> rows were refused</span>}
            {failed.length > 0 && state.skipped > 0 && <span>·</span>}
            {state.skipped > 0 && <span><span className="font-mono tabular-nums">{state.skipped}</span> skipped before import</span>}
          </div>
          {failed.length > 0 && (
            <ul className="max-h-64 divide-y divide-slate-800/70 overflow-y-auto text-xs">
              {failed.map((f) => (
                <li key={f.index} className="flex gap-3 px-4 py-2">
                  <span className="w-14 shrink-0 font-mono tabular-nums text-slate-500">Row {f.sourceRow ?? f.index + 1}</span>
                  <span className="text-amber-200/90">{f.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state.finishError && <p className="text-xs text-amber-300">The import record couldn’t be updated: {state.finishError}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className={`${l.primary ? 'btn-primary' : 'btn-secondary'} btn-sm inline-flex items-center gap-1.5`}>
            {l.label} <ArrowRight size={13} />
          </Link>
        ))}
        <Link href={dealerLinks.importBatch(batchId)} className="btn-secondary btn-sm">View this import</Link>
        <button type="button" className="btn-ghost btn-sm inline-flex items-center gap-1.5" onClick={onAnother}>
          <RotateCcw size={13} /> Import another file
        </button>
      </div>
    </div>
  );
}
