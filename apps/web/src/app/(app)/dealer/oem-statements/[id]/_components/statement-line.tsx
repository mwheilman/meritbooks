'use client';

/**
 * One manufacturer-statement line in the matching workspace: what the manufacturer
 * said, and next to it the suggested claim (indigo — the machine proposed it) with
 * its confidence, how it was found, any short-pay, and Accept / Reject / Ignore — or,
 * with no suggestion, a hand-pick of this manufacturer's open claims.
 */

import { forwardRef, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { AlertTriangle, Check, CircleSlash, FileText, Loader2, X } from 'lucide-react';
import { ConfidenceBar } from '@/components/ui/confidence-bar';
import { OEM_LINE_TYPE, OEM_MATCH_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { MATCH_METHOD_EXPLAINED, lineClaimKind, type OemMatchProposal, type OemStatementLineRow } from '@/lib/dealer/ui/claims';
import { AiBadge, Money, Pill } from '../../../_components/ui';
import type { ClaimCandidate } from './use-open-claims';

export interface LineProps {
  line: OemStatementLineRow;
  proposal: OemMatchProposal | null;
  claim: ClaimCandidate | null;
  candidates: ClaimCandidate[];
  autoApplied: boolean;
  focused: boolean;
  busy: boolean;
  onFocus: () => void;
  onAccept: () => void;
  onReject: () => void;
  onIgnore: () => void;
  onPick: (c: ClaimCandidate) => void;
}

function rank(line: OemStatementLineRow, c: ClaimCandidate): number {
  const norm = (s: string | null) => (s ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  let score = 0;
  if (line.reference && c.reference && norm(line.reference) === norm(c.reference)) score += 100;
  if (line.serial_number && c.serial && norm(line.serial_number) === norm(c.serial)) score += 50;
  if (c.openCents === line.amount_cents) score += 25;
  if (c.openCents < line.amount_cents) score -= 1000;
  return score;
}

export const StatementLine = forwardRef<HTMLLIElement, LineProps>(function StatementLine(p, ref) {
  const { line, proposal, claim } = p;
  const settled = line.match_status === 'SETTLED';
  const ignored = line.match_status === 'IGNORED';
  const kind = lineClaimKind(line.line_type);
  const canSettle = line.amount_cents > 0;
  const [pick, setPick] = useState('');

  const pickable = canSettle
    ? p.candidates
        .filter((c) => (kind ? c.kind === kind : true))
        .sort((a, b) => rank(line, b) - rank(line, a) || a.openCents - b.openCents)
    : [];

  return (
    <li
      ref={ref}
      tabIndex={-1}
      onClick={p.onFocus}
      onFocus={p.onFocus}
      aria-current={p.focused || undefined}
      className={clsx(
        'grid gap-4 border-l-2 px-5 py-4 outline-none lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]',
        p.focused ? 'border-emerald-500 bg-slate-800/30' : 'border-transparent',
        (settled || ignored) && 'opacity-80',
      )}
    >
      {/* What the manufacturer says */}
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="font-mono text-2xs tabular-nums text-slate-600">{line.line_number ?? '—'}</span>
            <span className="text-xs text-slate-400">{labelOf(OEM_LINE_TYPE, line.line_type)}</span>
            {line.reference && <span className="truncate font-mono text-sm text-slate-100">{line.reference}</span>}
          </div>
          <Money cents={line.amount_cents} className="text-sm font-medium" />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
          {line.serial_number && <span className="font-mono">S/N {line.serial_number}</span>}
          {line.description && <span className="min-w-0 truncate">{line.description}</span>}
        </div>
      </div>

      {/* The match */}
      <div className="min-w-0">
        {settled ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Check size={14} className="text-emerald-400" />
            <span className="text-slate-200">{p.autoApplied ? 'Applied automatically' : 'Applied'}</span>
            {(line.matched_warranty_claim_id || line.matched_incentive_claim_id) && (
              <Link
                href={line.matched_warranty_claim_id ? dealerLinks.warranty({ claim: line.matched_warranty_claim_id }) : dealerLinks.incentives({ claim: line.matched_incentive_claim_id ?? undefined })}
                className="text-xs text-emerald-400 hover:text-emerald-300"
              >
                Open the claim
              </Link>
            )}
            {line.settlement_gl_entry_id && (
              <Link href={dealerLinks.journalEntry(line.settlement_gl_entry_id)} className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                <FileText size={11} /> Journal entry
              </Link>
            )}
            {p.autoApplied && <p className="w-full text-2xs text-slate-500">Exact claim number and amount; your autonomy setting allowed it.</p>}
          </div>
        ) : ignored ? (
          <Pill label={labelOf(OEM_MATCH_STATUS, 'IGNORED')} tone={toneOf(OEM_MATCH_STATUS, 'IGNORED')} />
        ) : proposal ? (
          <div className="rounded-lg border border-indigo-500/25 bg-indigo-500/[0.04] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <AiBadge confidenceBps={proposal.confidenceBps} title="Suggested by the matcher" />
                {claim ? (
                  <Link href={claim.href} className="truncate text-sm text-slate-100 hover:text-white" onClick={(e) => e.stopPropagation()}>
                    {claim.label}
                  </Link>
                ) : (
                  <span className="text-sm text-slate-400">A claim that is no longer open</span>
                )}
              </div>
              {claim && (
                <span className="text-xs text-slate-400">
                  open <span className="font-mono tabular-nums text-slate-200">{money(claim.openCents)}</span>
                </span>
              )}
            </div>
            <ConfidenceBar value={proposal.confidenceBps / 10_000} className="mt-2 max-w-[220px]" />
            <p className="mt-1.5 text-xs text-slate-400">{MATCH_METHOD_EXPLAINED[proposal.method]}.</p>
            {proposal.shortPayCents > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                The manufacturer paid {money(proposal.shortPayCents)} less — the claim stays partly paid until a manager accepts the short-pay or resubmits it.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn-primary btn-sm" disabled={p.busy || !claim} onClick={(e) => { e.stopPropagation(); p.onAccept(); }}>
                {p.busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Accept <kbd className="ml-1 rounded bg-white/10 px-1 font-mono text-2xs">a</kbd>
              </button>
              <button type="button" className="btn-secondary btn-sm" disabled={p.busy} onClick={(e) => { e.stopPropagation(); p.onReject(); }}>
                <X size={12} /> Reject <kbd className="ml-1 rounded bg-white/10 px-1 font-mono text-2xs">r</kbd>
              </button>
            </div>
          </div>
        ) : canSettle ? (
          <div className="flex flex-wrap items-center gap-2">
            {pickable.length === 0 ? (
              <span className="text-xs text-slate-500">No open {kind === 'WARRANTY' ? 'warranty' : kind === 'INCENTIVE' ? 'incentive' : ''} claims for this manufacturer to apply it to.</span>
            ) : (
              <>
                <label className="sr-only" htmlFor={`pick-${line.id}`}>
                  Apply line {line.line_number ?? ''} to a claim
                </label>
                <select
                  id={`pick-${line.id}`}
                  value={pick}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setPick(e.target.value)}
                  className="input max-w-sm flex-1 text-xs"
                >
                  <option value="">Choose the claim it pays…</option>
                  {pickable.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.openCents < line.amount_cents}>
                      {c.label} · open {money(c.openCents)}
                      {c.openCents < line.amount_cents ? ' (less than this credit)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  disabled={!pick || p.busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    const c = pickable.find((x) => x.id === pick);
                    if (c) p.onPick(c);
                  }}
                >
                  {p.busy && <Loader2 size={12} className="animate-spin" />} Apply
                </button>
              </>
            )}
          </div>
        ) : line.line_type === 'DEBIT' ? (
          <p className="text-xs text-slate-400">
            A debit (charge-back). Record it on the claim it relates to with <span className="text-slate-200">Charge-back debit</span> —{' '}
            <Link href={dealerLinks.warranty({ status: 'PAID' })} className="text-emerald-400 hover:text-emerald-300">
              find the claim
            </Link>
            — then ignore it here.
          </p>
        ) : (
          <p className="text-xs text-slate-400">Not a claim credit. Enter parts invoices as bills in payables; ignore the line here once it’s handled.</p>
        )}
        {!settled && !ignored && (
          <button type="button" className="btn-ghost btn-sm mt-2 -ml-2 text-slate-500" disabled={p.busy} onClick={(e) => { e.stopPropagation(); p.onIgnore(); }}>
            <CircleSlash size={12} /> Ignore line <kbd className="ml-1 rounded bg-white/10 px-1 font-mono text-2xs">i</kbd>
          </button>
        )}
      </div>
    </li>
  );
});
