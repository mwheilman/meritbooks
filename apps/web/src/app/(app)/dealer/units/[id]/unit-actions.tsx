'use client';

/**
 * Unit status actions (POST /api/dealer/units/actions, schema `unitAction`):
 * demo on/off, move to rental, write-down, return to manufacturer, warranty
 * registration date, delivered, void. Every one confirms; the GL-moving ones say
 * exactly what posts, and those needing controller approval say so up front.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import { actionNeedsApproval, actionPostsGl, type UnitActionKey } from '@/lib/dealer/ui/unit-flags';
import type { NoteView, UnitView } from '@/lib/dealer/ui/unit-deal-types';
import { ConfirmDialog, DateInput, Field, Modal, MoneyInput, TextArea } from '../../_components/forms';
import { dealerMutate } from '../../_lib/use-dealer';

const MENU: Array<{ key: UnitActionKey; label: string; sub?: string }> = [
  { key: 'MARK_DEMO', label: 'Mark as demo', sub: 'Stays in inventory, no entry' },
  { key: 'UNMARK_DEMO', label: 'Return to new', sub: 'Clears the demo flag' },
  { key: 'RECORD_WARRANTY_REGISTRATION', label: 'Record warranty registration', sub: 'The manufacturer’s retail registration date' },
  { key: 'MARK_DELIVERED', label: 'Mark delivered', sub: 'The customer took delivery' },
  { key: 'MOVE_TO_RENTAL', label: 'Move to rental fleet', sub: 'Posts a transfer at cost' },
  { key: 'WRITE_DOWN', label: 'Write down', sub: 'Posts an inventory write-down' },
  { key: 'RETURN_TO_OEM', label: 'Return to manufacturer', sub: 'Posts the return and lender credit' },
  { key: 'VOID', label: 'Void unit', sub: 'Only with no cost, note or sale' },
];

export function UnitActions({
  unit,
  liveNote,
  available,
  enabled,
  locationId,
  onDone,
}: {
  unit: UnitView;
  liveNote: NoteView | null;
  available: Record<UnitActionKey, boolean>;
  enabled: boolean;
  locationId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<UnitActionKey | null>(null);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // two-step forms (amount + reason) before the confirm
  const [wdAmount, setWdAmount] = useState<number | null>(null);
  const [wdDate, setWdDate] = useState(todayLocal());
  const [wdReason, setWdReason] = useState('');
  const [rtCredit, setRtCredit] = useState<number | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'confirm'>('form');

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    setTimeout(() => wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus(), 0);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function start(a: UnitActionKey) {
    setOpen(false);
    setAction(a);
    setStep(a === 'WRITE_DOWN' || a === 'RETURN_TO_OEM' ? 'form' : 'confirm');
    setWdAmount(null);
    setWdDate(todayLocal());
    setWdReason('');
    setRtCredit(liveNote ? liveNote.principal_balance_cents : 0);
    setFormErr(null);
  }
  const close = () => {
    if (!busy) setAction(null);
  };

  async function run(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    const res = await dealerMutate('post', '/api/dealer/units/actions', locationId, { unitId: unit.id, action: body }, ok);
    setBusy(false);
    if (!res.error) {
      setAction(null);
      onDone();
    }
  }

  const approval = <p className="text-xs text-slate-400">Needs controller approval rights — if you don’t have them, ask your controller to do this step.</p>;
  const sn = <span className="font-mono tabular-nums text-white">{unit.serial_number}</span>;

  function menuItemDisabled(k: UnitActionKey): string | null {
    if (!available[k]) return 'Not available for this unit right now';
    if (actionPostsGl(k) && !enabled) return 'Switch the dealer pack on first';
    return null;
  }

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        className="btn-secondary btn-sm inline-flex items-center gap-1.5"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
      >
        More actions <ChevronDown size={13} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Unit actions"
          className="absolute right-0 z-30 mt-1 w-72 overflow-hidden rounded-lg border border-slate-700 bg-surface-900 py-1 shadow-xl"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === 'ArrowDown' ? items[(i + 1) % items.length] : items[(i - 1 + items.length) % items.length];
            next?.focus();
          }}
        >
          {MENU.map((m) => {
            const why = menuItemDisabled(m.key);
            return (
              <button
                key={m.key}
                type="button"
                role="menuitem"
                disabled={!!why}
                title={why ?? undefined}
                onClick={() => start(m.key)}
                className={clsx(
                  'block w-full px-3 py-2 text-left focus:bg-white/[0.04] focus:outline-none disabled:cursor-not-allowed disabled:opacity-40',
                  !why && 'hover:bg-white/[0.04]',
                  m.key === 'VOID' && 'border-t border-slate-800',
                )}
              >
                <span className={clsx('block text-body-sm', m.key === 'VOID' || m.key === 'WRITE_DOWN' ? 'text-red-300' : 'text-slate-200')}>{m.label}</span>
                <span className="block text-xs text-slate-500">
                  {why ?? m.sub}
                  {!why && actionNeedsApproval(m.key) ? ' · controller approval' : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={action === 'MARK_DEMO' || action === 'UNMARK_DEMO'}
        onClose={close}
        busy={busy}
        title={action === 'MARK_DEMO' ? 'Mark as demo' : 'Return to new'}
        confirmLabel={action === 'MARK_DEMO' ? 'Mark as demo' : 'Return to new'}
        body={
          action === 'MARK_DEMO' ? (
            <p>
              {sn} stays in inventory at cost — no accounting entry. Some lender programs curtail or call demo units; check the program’s demo terms.
            </p>
          ) : (
            <p>{sn} goes back to new condition. No accounting entry.</p>
          )
        }
        onConfirm={() => void run({ action: action ?? 'MARK_DEMO' }, action === 'MARK_DEMO' ? 'Marked as demo' : 'Returned to new')}
      />

      <ConfirmDialog
        open={action === 'RECORD_WARRANTY_REGISTRATION'}
        onClose={close}
        busy={busy}
        title="Record warranty registration"
        confirmLabel="Save date"
        date={{ label: 'Registration date', initial: unit.warranty_registered_date ?? todayLocal() }}
        body={
          <p>
            The date the manufacturer shows the unit registered to a retail customer. Lenders treat a registration as proof of sale — if Books has no sale
            for {sn}, it shows as sold out of trust until the sale is recorded.
          </p>
        }
        onConfirm={({ date }) => void run({ action: 'RECORD_WARRANTY_REGISTRATION', date }, 'Registration date saved')}
      />

      <ConfirmDialog
        open={action === 'MARK_DELIVERED'}
        onClose={close}
        busy={busy}
        title="Mark delivered"
        confirmLabel="Mark delivered"
        body={<p>The customer has taken delivery of {sn}. No accounting entry — the sale already posted.</p>}
        onConfirm={() => void run({ action: 'MARK_DELIVERED' }, 'Marked delivered')}
      />

      <ConfirmDialog
        open={action === 'MOVE_TO_RENTAL'}
        onClose={close}
        busy={busy}
        title="Move to the rental fleet"
        confirmLabel="Post the move"
        date={{ label: 'Move date', initial: todayLocal() }}
        body={
          <div className="space-y-2">
            <p>
              Posts a journal entry moving {sn}’s cost of <span className="font-mono tabular-nums text-white">{money(unit.cost_cents)}</span> from
              equipment inventory to rental inventory. The unit leaves the for-sale register.
            </p>
            <p className="text-xs text-slate-500">Rental depreciation isn’t calculated by the pack yet.</p>
            {approval}
          </div>
        }
        onConfirm={({ date }) => void run({ action: 'MOVE_TO_RENTAL', date }, 'Moved to the rental fleet')}
      />

      <ConfirmDialog
        open={action === 'VOID'}
        onClose={close}
        busy={busy}
        danger
        title="Void this unit"
        confirmLabel="Void unit"
        reason={{ label: 'Why is it being voided?', required: true, placeholder: 'e.g. Entered twice; duplicate of another serial' }}
        body={
          <div className="space-y-2">
            <p>Removes {sn} from the register. This can’t be undone. Only possible while it has no posted cost, no floor-plan note and no sale.</p>
            {approval}
          </div>
        }
        onConfirm={({ reason }) => void run({ action: 'VOID', reason }, 'Unit voided')}
      />

      {/* Write-down: form → confirm */}
      <Modal
        open={action === 'WRITE_DOWN' && step === 'form'}
        onClose={close}
        title="Write down this unit"
        description={`S/N ${unit.serial_number} · cost ${money(unit.cost_cents)}`}
        width="md"
        footer={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger btn-sm"
              onClick={() => {
                if (!wdAmount || wdAmount <= 0) return setFormErr('Enter the write-down amount');
                if (wdAmount > unit.cost_cents) return setFormErr(`Can’t write down more than the unit’s cost (${money(unit.cost_cents)})`);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(wdDate)) return setFormErr('Choose the entry date');
                if (!wdReason.trim()) return setFormErr('Give the reason (e.g. net realizable value)');
                setFormErr(null);
                setStep('confirm');
              }}
            >
              Review write-down
            </button>
          </>
        }
      >
        <WriteDownFields amount={wdAmount} setAmount={setWdAmount} date={wdDate} setDate={setWdDate} reason={wdReason} setReason={setWdReason} error={formErr} />
        <div className="mt-4">{approval}</div>
      </Modal>
      <ConfirmDialog
        open={action === 'WRITE_DOWN' && step === 'confirm'}
        onClose={() => setStep('form')}
        busy={busy}
        danger
        title="Post the write-down?"
        confirmLabel="Post write-down"
        body={
          <p>
            Posts a write-down of <span className="font-mono tabular-nums text-white">{money(wdAmount)}</span> on {sn} dated{' '}
            <span className="font-mono tabular-nums">{wdDate}</span>. The unit’s cost drops from{' '}
            <span className="font-mono tabular-nums">{money(unit.cost_cents)}</span> to{' '}
            <span className="font-mono tabular-nums text-white">{money(unit.cost_cents - (wdAmount ?? 0))}</span>, and the difference goes to inventory
            write-down expense. To reverse it later, post an offsetting entry.
          </p>
        }
        onConfirm={() => void run({ action: 'WRITE_DOWN', date: wdDate, amountCents: wdAmount ?? 0, reason: wdReason.trim() }, 'Write-down posted')}
      />

      {/* Return to manufacturer: form → confirm */}
      <Modal
        open={action === 'RETURN_TO_OEM' && step === 'form'}
        onClose={close}
        title="Return to the manufacturer"
        description={`S/N ${unit.serial_number} · cost ${money(unit.cost_cents)}`}
        width="md"
        footer={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger btn-sm"
              onClick={() => {
                if (rtCredit === null) return setFormErr('Enter the lender credit');
                if (liveNote && rtCredit !== liveNote.principal_balance_cents)
                  return setFormErr(`The lender credit must clear the note (${money(liveNote.principal_balance_cents)}). Record any difference as a curtailment first.`);
                if (!liveNote && rtCredit !== 0) return setFormErr('This unit isn’t on floor plan — the lender credit is zero.');
                if (!/^\d{4}-\d{2}-\d{2}$/.test(wdDate)) return setFormErr('Choose the return date');
                if (!wdReason.trim()) return setFormErr('Give the reason (e.g. repurchase, damaged in transit)');
                setFormErr(null);
                setStep('confirm');
              }}
            >
              Review return
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Return date" htmlFor="rt-date" required>
            <DateInput id="rt-date" value={wdDate} onChange={setWdDate} />
          </Field>
          <Field
            label="Lender credit"
            htmlFor="rt-credit"
            required
            hint={liveNote ? `Clears the floor-plan note’s balance of ${money(liveNote.principal_balance_cents)}.` : 'Not on floor plan — no lender credit.'}
          >
            <MoneyInput id="rt-credit" cents={rtCredit} onChange={setRtCredit} disabled={!liveNote} />
          </Field>
          <Field label="Reason" htmlFor="rt-reason" required>
            <TextArea id="rt-reason" value={wdReason} onChange={setWdReason} rows={2} maxLength={500} />
          </Field>
          {formErr && (
            <p className="text-xs text-red-400" role="alert">
              {formErr}
            </p>
          )}
          {approval}
        </div>
      </Modal>
      <ConfirmDialog
        open={action === 'RETURN_TO_OEM' && step === 'confirm'}
        onClose={() => setStep('form')}
        busy={busy}
        danger
        title="Post the return?"
        confirmLabel="Post return"
        body={
          <p>
            {sn}’s cost of <span className="font-mono tabular-nums text-white">{money(unit.cost_cents)}</span> leaves inventory
            {liveNote ? (
              <>
                , the lender’s credit of <span className="font-mono tabular-nums text-white">{money(rtCredit)}</span> clears the floor-plan note
              </>
            ) : null}
            , and any difference goes to inventory write-down. The unit is marked returned. This can’t be undone from here.
          </p>
        }
        onConfirm={() => void run({ action: 'RETURN_TO_OEM', date: wdDate, lenderCreditCents: rtCredit ?? 0, reason: wdReason.trim() }, 'Return posted')}
      />
    </div>
  );
}

function WriteDownFields({
  amount,
  setAmount,
  date,
  setDate,
  reason,
  setReason,
  error,
}: {
  amount: number | null;
  setAmount: (c: number | null) => void;
  date: string;
  setDate: (d: string) => void;
  reason: string;
  setReason: (r: string) => void;
  error: string | null;
}) {
  const id = useId();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Write down by" htmlFor={`${id}-a`} required>
          <MoneyInput id={`${id}-a`} cents={amount} onChange={setAmount} />
        </Field>
        <Field label="Entry date" htmlFor={`${id}-d`} required>
          <DateInput id={`${id}-d`} value={date} onChange={setDate} />
        </Field>
      </div>
      <Field label="Reason" htmlFor={`${id}-r`} required hint="e.g. Aged unit written down to net realizable value.">
        <TextArea id={`${id}-r`} value={reason} onChange={setReason} rows={2} maxLength={500} />
      </Field>
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
