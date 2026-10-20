'use client';

/**
 * Cost build-up (FPB §3.6): every cost row on the unit with its source, status and
 * journal entry. The unit's cost is the sum of POSTED rows (DB trigger). Proposed
 * repair-order / journal rows can be posted or voided here; a proposed flooring
 * row is posted from its floor-plan note.
 */

import { useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Receipt } from 'lucide-react';
import { COST_SOURCE, COST_TYPE, ROW_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { COST_OFFSET, type CostOffset } from '@/lib/dealer/ui/unit-deal-labels';
import { dateLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { CostView, NoteView } from '@/lib/dealer/ui/unit-deal-types';
import { ConfirmDialog } from '../../_components/forms';
import { Empty, Money, Notice, Pill, Section } from '../../_components/ui';
import { dealerMutate } from '../../_lib/use-dealer';

export function CostTable({
  costs,
  notes,
  unitCostCents,
  serial,
  locationId,
  enabled,
  canAdd,
  onAdd,
  onChanged,
}: {
  costs: CostView[];
  notes: NoteView[];
  unitCostCents: number;
  serial: string;
  locationId: string;
  enabled: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const [posting, setPosting] = useState<CostView | null>(null);
  const [voiding, setVoiding] = useState<CostView | null>(null);
  const [busy, setBusy] = useState(false);
  const live = costs.filter((c) => c.status !== 'VOID');
  const proposed = costs.filter((c) => c.status === 'PROPOSED');
  const voided = costs.length - live.length;
  const [showVoid, setShowVoid] = useState(false);
  const rows = showVoid ? costs : live;
  const proposedTotal = proposed.reduce((s, c) => s + c.amount_cents, 0);
  const flooringNote = (c: CostView) => (c.source_type === 'FLOOR_PLAN_NOTE' ? notes.find((n) => n.id === c.source_id) ?? null : null);

  async function post(c: CostView, entryDate: string) {
    setBusy(true);
    const r = await dealerMutate('post', '/api/dealer/units/costs/post', locationId, { costId: c.id, entryDate }, `Posted ${money(c.amount_cents)} to the unit`);
    setBusy(false);
    if (!r.error) {
      setPosting(null);
      onChanged();
    }
  }
  async function voidCost(c: CostView) {
    setBusy(true);
    const r = await dealerMutate('post', '/api/dealer/units/costs/void', locationId, { costId: c.id }, 'Cost voided');
    setBusy(false);
    if (!r.error) {
      setVoiding(null);
      onChanged();
    }
  }

  const sourceDetail = (c: CostView): string => {
    if (c.source_type === 'INTERNAL_RO') {
      const parts = [`labor ${money(c.labor_cents)}`, `parts ${money(c.parts_cents)}`];
      return `${c.source_ref ? `RO ${c.source_ref} · ` : ''}${parts.join(' + ')}`;
    }
    if (c.source_type === 'JE' && c.offset_role) return COST_OFFSET[c.offset_role as CostOffset]?.label ?? '';
    return c.source_ref ?? '';
  };

  return (
    <Section
      title="Cost build-up"
      description={
        <span>
          Unit cost is the sum of posted rows: <span className="font-mono tabular-nums text-slate-200">{money(unitCostCents)}</span>
          {proposed.length > 0 && (
            <span className="text-amber-300">
              {' '}
              · <span className="font-mono tabular-nums">{money(proposedTotal)}</span> waiting to post
            </span>
          )}
        </span>
      }
      actions={
        <>
          {voided > 0 && (
            <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={() => setShowVoid((v) => !v)} aria-pressed={showVoid}>
              {showVoid ? 'Hide voided' : `Show ${voided} voided`}
            </button>
          )}
          {canAdd && (
            <button type="button" className="btn-secondary btn-sm" onClick={onAdd}>
              Add cost
            </button>
          )}
        </>
      }
    >
      {proposed.length > 0 && (
        <div className="px-5 pt-4">
          <Notice tone="warning">
            {proposed.length} cost row{proposed.length === 1 ? ' is' : 's are'} waiting to be posted. The unit can’t be sold until every row is posted or voided,
            so its cost ties to the general ledger.
          </Notice>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty
          icon={Receipt}
          title="No costs yet"
          description="Cost arrives when the unit is floored, a vendor bill line is linked, or setup and freight are added."
          action={
            canAdd ? (
              <button type="button" className="btn-secondary btn-sm" onClick={onAdd}>
                Add a cost
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <caption className="sr-only">Cost build-up for unit {serial}</caption>
            <thead>
              <tr className="border-b border-slate-800">
                {[
                  ['Date', 'left'],
                  ['Cost', 'left'],
                  ['Source', 'left'],
                  ['Amount', 'right'],
                  ['Status', 'left'],
                  ['Entry', 'left'],
                  ['', 'right'],
                ].map(([h, a], i) => (
                  <th
                    key={`${h}-${i}`}
                    scope="col"
                    className={clsx('whitespace-nowrap px-4 py-2.5 text-caption font-medium uppercase tracking-caps text-slate-500', a === 'right' ? 'text-right' : 'text-left')}
                  >
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {rows.map((c) => {
                const note = flooringNote(c);
                const postable = c.status === 'PROPOSED' && (c.source_type === 'INTERNAL_RO' || c.source_type === 'JE');
                return (
                  <tr key={c.id} className={clsx('table-row-hover', c.status === 'VOID' && 'opacity-50')}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-body-sm tabular-nums text-slate-400">{dateLabel((c.posted_at ?? c.created_at).slice(0, 10))}</td>
                    <td className="px-4 py-2.5 text-slate-200">
                      {labelOf(COST_TYPE, c.cost_type)}
                      {c.memo && <div className="max-w-xs truncate text-xs text-slate-500">{c.memo}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="text-body-sm text-slate-300">{labelOf(COST_SOURCE, c.source_type)}</div>
                      {sourceDetail(c) && <div className="text-xs text-slate-500">{sourceDetail(c)}</div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <Money cents={c.amount_cents} muted={c.status !== 'POSTED'} />
                    </td>
                    <td className="px-4 py-2.5">
                      <Pill label={labelOf(ROW_STATUS, c.status)} tone={toneOf(ROW_STATUS, c.status)} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-body-sm">
                      {c.gl_entry_id ? (
                        <Link href={dealerLinks.journalEntry(c.gl_entry_id)} className="text-slate-300 hover:text-white hover:underline">
                          View entry
                        </Link>
                      ) : c.source_type === 'OPENING' ? (
                        <span className="text-xs text-slate-500">Opening balance — no entry</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {postable ? (
                        <div className="inline-flex gap-2">
                          <button type="button" className="btn-secondary btn-sm" onClick={() => setPosting(c)} disabled={!enabled} title={enabled ? undefined : 'Switch the dealer pack on first'}>
                            Post
                          </button>
                          <button type="button" className="btn-ghost btn-sm text-red-300" onClick={() => setVoiding(c)}>
                            Void
                          </button>
                        </div>
                      ) : c.status === 'PROPOSED' && note ? (
                        <Link href={dealerLinks.note(note.id)} className="text-xs font-medium text-slate-300 hover:text-white">
                          Post on the note →
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={!!posting}
        onClose={() => !busy && setPosting(null)}
        busy={busy}
        title="Post this cost?"
        confirmLabel="Post"
        date={{ label: 'Entry date', initial: todayLocal() }}
        body={
          posting && (
            <p>
              Posts the journal entry for {labelOf(COST_TYPE, posting.cost_type).toLowerCase()} and adds{' '}
              <span className="font-mono tabular-nums text-white">{money(posting.amount_cents)}</span> to unit{' '}
              <span className="font-mono tabular-nums">{serial}</span>’s cost. Posted rows can’t be edited — correct them with an offsetting row.
            </p>
          )
        }
        onConfirm={({ date }) => {
          if (posting) void post(posting, date);
        }}
      />
      <ConfirmDialog
        open={!!voiding}
        onClose={() => !busy && setVoiding(null)}
        busy={busy}
        danger
        title="Void this cost?"
        confirmLabel="Void cost"
        body={voiding && <p>The {money(voiding.amount_cents)} {labelOf(COST_TYPE, voiding.cost_type).toLowerCase()} row is voided. Nothing was posted, so no entry changes.</p>}
        onConfirm={() => {
          if (voiding) void voidCost(voiding);
        }}
      />
    </Section>
  );
}
