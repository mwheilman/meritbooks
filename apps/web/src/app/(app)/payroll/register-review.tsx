'use client';

/**
 * Shared review pieces for BOTH payroll-register imports (AI/PDF and spreadsheet):
 * the account picker (this company's approved chart, in a kit Popover so it never
 * clips inside a scrolling dialog), the editable DR/CR line table with tying totals,
 * the balance notice that gates Post, and the done / error / working states.
 *
 * Presentation only — every amount stays a string the parent owns and converts with
 * its own `inputToCents`; nothing here does money arithmetic beyond echoing the
 * totals the parent computed.
 */

import { useRef, useState } from 'react';
import {
  Button,
  Icon,
  InlineNotice,
  Input,
  Popover,
  PopoverHead,
  PopoverList,
  Tag,
  cx,
} from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import s from './payroll.module.css';

export interface AccountOption {
  id: string;
  accountNumber: string;
  name: string;
  accountType: string;
  isActive: boolean;
  approvalStatus: string;
}

/** The fields of a review line the table needs (both imports' drafts satisfy it). */
export interface ReviewLine {
  key: string;
  side: 'DR' | 'CR';
  label: string;
  amountInput: string;
  accountId: string;
  degraded: boolean;
}

// ── Account picker ───────────────────────────────────────────────────────────
export function AccountPicker({
  value,
  accounts,
  onChange,
  placeholder,
  invalid,
  lineLabel,
}: {
  value: string;
  accounts: AccountOption[];
  onChange: (id: string) => void;
  placeholder: string;
  invalid: boolean;
  lineLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);

  const selected = accounts.find((a) => a.id === value);
  const q = search.trim().toLowerCase();
  const filtered = q
    ? accounts.filter((a) => a.accountNumber.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    : accounts;

  const close = () => {
    setOpen(false);
    setSearch('');
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx(s.pickerBtn, invalid && !selected && s.pickerInvalid)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={selected ? `Account for ${lineLabel}: ${selected.accountNumber} ${selected.name}` : `Choose the account for ${lineLabel}`}
      >
        <span className={selected ? undefined : s.pickerEmpty}>
          {selected ? `${selected.accountNumber} · ${selected.name}` : placeholder}
        </span>
        <span className={s.pickerChevron} aria-hidden="true">
          <Icon name="down" />
        </span>
      </button>
      <Popover open={open} onClose={close} anchorRef={anchor} width={320} aria-label={`Accounts for ${lineLabel}`}>
        <PopoverHead>
          <Icon name="search" />
          <input
            data-autofocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search accounts"
            aria-label="Search accounts"
          />
        </PopoverHead>
        <PopoverList className={s.pickerList} role="listbox" aria-label="Accounts">
          {filtered.length === 0 ? (
            <li className={cx('t-cap', s.pickerMsg)}>
              {accounts.length === 0 ? 'Choose a company first.' : 'No account matches.'}
            </li>
          ) : (
            filtered.slice(0, 40).map((a) => (
              <li key={a.id} role="option" aria-selected={a.id === value}>
                <button
                  type="button"
                  className="popover-item"
                  style={{ width: '100%', textAlign: 'left', font: 'inherit', minHeight: 32 }}
                  onClick={() => {
                    onChange(a.id);
                    close();
                  }}
                >
                  <span className={s.pickerNum}>{a.accountNumber}</span>
                  <span className="mb-trunc">{a.name}</span>
                </button>
              </li>
            ))
          )}
        </PopoverList>
      </Popover>
    </>
  );
}

// ── Editable DR/CR lines ─────────────────────────────────────────────────────
export function JournalLinesTable<L extends ReviewLine>({
  drafts,
  accounts,
  locationId,
  loadingAccounts,
  totalDebits,
  totalCredits,
  amountCents,
  onPatch,
}: {
  drafts: L[];
  accounts: AccountOption[];
  locationId: string;
  loadingAccounts: boolean;
  totalDebits: number;
  totalCredits: number;
  /** The parent's own string → cents conversion (unchanged money arithmetic). */
  amountCents: (input: string) => number;
  onPatch: (key: string, patch: Partial<L>) => void;
}) {
  return (
    <div className={s.lines}>
      <table className="tbl tbl-q tbl-q--compact" aria-label="Proposed payroll entry lines">
        <colgroup>
          <col />
          <col style={{ width: 260 }} />
          <col style={{ width: 136 }} />
          <col style={{ width: 136 }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Account</th>
            <th scope="col" className="n">Debit</th>
            <th scope="col" className="n">Credit</th>
          </tr>
        </thead>
        <tbody>
          {drafts.map((d) => {
            const cents = amountCents(d.amountInput);
            const amountField = (
              <Input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={d.amountInput}
                onChange={(e) => onPatch(d.key, { amountInput: e.target.value } as Partial<L>)}
                className="input--money"
                aria-label={`${d.side === 'DR' ? 'Debit' : 'Credit'} amount for ${d.label}`}
              />
            );
            return (
              <tr key={d.key} className={cx('q-row', s.cellTop)}>
                <td>
                  <span className="l1" style={{ whiteSpace: 'normal' }}>{d.label}</span>
                  {d.degraded && (
                    <span className="l2 warn" style={{ whiteSpace: 'normal' }}>No account role mapped — check the account</span>
                  )}
                </td>
                <td>
                  <AccountPicker
                    value={d.accountId}
                    accounts={accounts}
                    lineLabel={d.label}
                    invalid={cents > 0 && !d.accountId}
                    placeholder={!locationId ? 'Choose a company first' : loadingAccounts ? 'Loading accounts…' : 'Choose account'}
                    onChange={(id) => onPatch(d.key, { accountId: id } as Partial<L>)}
                  />
                </td>
                <td className="n">{d.side === 'DR' ? amountField : <span className={s.dash} aria-label="No debit">—</span>}</td>
                <td className="n">{d.side === 'CR' ? amountField : <span className={s.dash} aria-label="No credit">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Totals</td>
            <td className="n tnum">{formatMoney(totalDebits)}</td>
            <td className="n tnum">{formatMoney(totalCredits)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Balance notice — the Post button is gated on debits == credits ───────────
export function BalanceNotice({ totalDebits, totalCredits }: { totalDebits: number; totalCredits: number }) {
  const imbalance = totalDebits - totalCredits;
  if (totalDebits === 0) {
    return <InlineNotice title="Nothing to post yet.">Enter the register amounts above to build the balanced entry.</InlineNotice>;
  }
  if (imbalance === 0) {
    return (
      <InlineNotice tone="info" icon={<Icon name="check" />} title="Balanced.">
        Debits equal credits at <b className="tnum">{formatMoney(totalDebits)}</b>.
      </InlineNotice>
    );
  }
  return (
    <InlineNotice tone="neg" title={<>Out of balance by <span className="tnum">{formatMoney(Math.abs(imbalance))}</span>.</>}>
      Debits <span className="tnum">{formatMoney(totalDebits)}</span> vs credits{' '}
      <span className="tnum">{formatMoney(totalCredits)}</span>. Fix the amounts before posting.
    </InlineNotice>
  );
}

// ── Plain-English register totals (four hairline figure cells) ───────────────
export function RegisterFigures({
  gross,
  withheld,
  employerTax,
  net,
}: {
  gross: number;
  withheld: number;
  employerTax: number;
  net: number;
}) {
  const cell = (label: string, cents: number) => (
    <div className="fig">
      <span className="fig-l">{label}</span>
      <span className="fig-v fig-v--dense tnum">{formatMoney(cents)}</span>
    </div>
  );
  return (
    <div className={s.figs}>
      {cell('Gross wages', gross)}
      {cell('Withheld & deductions', withheld)}
      {cell('Employer taxes', employerTax)}
      {cell('Net pay', net)}
    </div>
  );
}

// ── Working / error / done states inside an import dialog ────────────────────
export function WorkingState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={s.phase} aria-busy="true">
      <div className={s.phaseBars} aria-hidden="true">
        <span className="mb-skel" style={{ width: '72%' }} />
        <span className="mb-skel" style={{ width: '56%' }} />
        <span className="mb-skel" style={{ width: '64%' }} />
      </div>
      <p className="t-head" role="status">{title}</p>
      <p className="ink-2">{detail}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="wg-state" role="alert" style={{ padding: '24px 0' }}>
      <Tag tone="neg">Not read</Tag>
      <p className="t-head">We couldn&apos;t read that file.</p>
      <p>{message ?? 'Something went wrong.'}</p>
      <Button onClick={onRetry}>Try another file</Button>
    </div>
  );
}

export function DoneState({ entryNumber, onAnother }: { entryNumber: string | null; onAnother: () => void }) {
  return (
    <div className="wg-state" role="status" style={{ padding: '24px 0' }}>
      <span className="wg-done-mark" aria-hidden="true">
        <Icon name="check" />
      </span>
      <p className="t-head">Payroll register posted{entryNumber ? ` as entry ${entryNumber}` : ''}.</p>
      <p>The balanced payroll entry is on the ledger. Open Journal entries to see it, or import the next register.</p>
      <Button onClick={onAnother}>Import another</Button>
    </div>
  );
}
