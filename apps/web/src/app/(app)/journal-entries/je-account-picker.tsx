'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon, cx } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import s from './je.module.css';

export interface AccountOption {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  is_control_account?: boolean;
}

/**
 * /api/accounts/search answers `{ recent, accounts }` (vendor recents first). Older
 * callers read `data`, which the route never sent — so the picker listed nothing.
 * Read every shape the route has returned.
 */
interface AccountSearchResponse {
  recent?: AccountOption[];
  accounts?: AccountOption[];
  data?: AccountOption[];
}

function useOutsideClose(open: boolean, setOpen: (v: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, setOpen]);
  return ref;
}

/**
 * Searchable GL account picker (kit popover). Control accounts are hidden — they
 * only take postings from their sub-ledger. ↑/↓ move, Enter picks, Esc closes.
 */
export function AccountPicker({
  value,
  label,
  onChange,
  locationId,
  ariaLabel,
  invalid,
}: {
  value: string;
  label: string;
  onChange: (id: string, label: string, account: AccountOption) => void;
  locationId: string;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useOutsideClose(open, setOpen);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setHi(0); }, [debouncedSearch, open]);

  const params: Record<string, string> = {};
  if (debouncedSearch.length >= 1) params.q = debouncedSearch;
  if (locationId) params.location_id = locationId;

  const { data, isLoading, error } = useQuery<AccountSearchResponse>(
    open ? '/api/accounts/search' : null,
    Object.keys(params).length > 0 ? params : undefined,
  );

  const accounts = [...(data?.recent ?? []), ...(data?.accounts ?? []), ...(data?.data ?? [])]
    .filter((a) => !a.is_control_account)
    .slice(0, 30);

  const close = () => { setOpen(false); setSearch(''); btnRef.current?.focus(); };
  const pick = (acct: AccountOption) => {
    onChange(acct.id, `${acct.account_number} · ${acct.name}`, acct);
    close();
  };

  return (
    <div ref={ref} className={s.picker}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={cx(s.pickerBtn, invalid && s.pickerInvalid)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ? `${ariaLabel}${label ? `: ${label}` : ''}` : label ? `GL account: ${label}` : 'Choose a GL account'}
      >
        <span className={value ? undefined : s.pickerEmpty}>{label || 'Choose account'}</span>
        <span className={s.pickerChevron} aria-hidden="true"><Icon name="down" /></span>
      </button>

      {open && (
        <div
          className={cx('popover', s.pickerPop)}
          data-hotkeys="off"
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(i + 1, Math.max(accounts.length - 1, 0))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter' && accounts[hi]) { e.preventDefault(); pick(accounts[hi]); }
          }}
        >
          <div className="popover-head">
            <Icon name="search" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by number or name"
              aria-label="Search accounts by number or name"
              autoFocus
            />
          </div>
          <ul className={cx('popover-list', s.pickerList)} role="listbox" aria-label="GL accounts">
            {isLoading && accounts.length === 0 ? (
              <li className={cx('t-cap', s.pickerMsg)}>Searching…</li>
            ) : error ? (
              <li className={cx('t-cap', s.pickerMsg)} role="alert">Accounts didn&apos;t load — close and try again.</li>
            ) : accounts.length === 0 ? (
              <li className={cx('t-cap', s.pickerMsg)}>{debouncedSearch ? 'No account matches.' : 'Type a number or name.'}</li>
            ) : (
              accounts.map((acct, i) => (
                <li key={acct.id} role="none">
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === hi}
                    className={cx('popover-item', s.pickerItem)}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => pick(acct)}
                  >
                    <span className={s.pickerNum}>{acct.account_number}</span>
                    <span className="mb-trunc">{acct.name}</span>
                    <span className="r t-cap">{acct.id === value ? <Icon name="check" /> : acct.account_type}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="popover-foot">
            <span>↑ ↓ move</span>
            <span>↵ pick</span>
            <span>esc close</span>
          </div>
        </div>
      )}
    </div>
  );
}
