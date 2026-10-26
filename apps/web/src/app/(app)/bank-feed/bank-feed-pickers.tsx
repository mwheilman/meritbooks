'use client';

/**
 * Inline GL-account and job pickers for the bank-feed table, on the kit popover
 * (portal, so the queue's clipped cells never cut them off). Same data and verbs
 * as before: vendor recents first, then a debounced account search; jobs for the
 * line's company with "Clear job". Arrow keys + Enter pick; Esc closes and the
 * popover hands focus back to the cell.
 */

import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { Icon, Popover, PopoverGroup, PopoverHead, PopoverItem, PopoverList } from '@meritbooks/merit-ui';
import { useQuery, useDebounce } from '@/hooks';
import type { BankFeedRow, JobSearchResult } from '@meritbooks/shared';
import styles from './bank-feed.module.css';

interface AccountOption {
  id: string;
  account_number: string;
  name: string;
}

interface AccountSearchResponse {
  recent: AccountOption[];
  accounts: AccountOption[];
}

function useListCursor(length: number, resetKey: string) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [resetKey]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>, pick: (i: number) => void) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && length > 0) {
      e.preventDefault();
      pick(active);
    }
  };
  return { active, setActive, onKey };
}

export function AccountPickerPopover({
  open,
  anchorRef,
  txn,
  vendorId,
  onSelect,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  txn: BankFeedRow;
  vendorId: string | undefined;
  onSelect: (accountId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 200);

  const searchParams: Record<string, string> = {};
  if (debouncedSearch) searchParams.q = debouncedSearch;
  if (vendorId) searchParams.vendor_id = vendorId;

  const { data, isLoading, error } = useQuery<AccountSearchResponse>('/api/accounts/search', searchParams, { enabled: open });

  const recent = data?.recent ?? [];
  const accounts = data?.accounts ?? [];
  const flat = useMemo(() => [...recent, ...accounts], [recent, accounts]);
  const { active, setActive, onKey } = useListCursor(flat.length, debouncedSearch);
  const currentAccountId = (txn.final_account ?? txn.ai_account)?.id;

  const row = (a: AccountOption, i: number) => (
    <PopoverItem
      key={`${i}-${a.id}`}
      active={i === active}
      onMouseEnter={() => setActive(i)}
      onClick={() => onSelect(a.id)}
      right={a.id === currentAccountId ? <Icon name="check" label="Current account" /> : undefined}
    >
      <span className="code">{a.account_number}</span>
      <span className={styles.pickName}>{a.name}</span>
    </PopoverItem>
  );

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={360} role="dialog" aria-label="Change the GL account">
      <PopoverHead>
        <Icon name="search" />
        <input
          data-autofocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => onKey(e, (i) => flat[i] && onSelect(flat[i].id))}
          placeholder="Search accounts by number or name"
          aria-label="Search GL accounts"
        />
      </PopoverHead>
      <PopoverList className={styles.pickList} role="listbox" aria-label="GL accounts">
        {isLoading && !data && <li className={styles.pickEmpty}>Searching accounts…</li>}
        {error && <li className={styles.pickEmpty}>Accounts didn&apos;t load. Close and try again.</li>}
        {recent.length > 0 && <PopoverGroup label="This vendor's recent accounts" />}
        {recent.map((a, i) => row(a, i))}
        {accounts.length > 0 && <PopoverGroup label="All accounts" />}
        {accounts.map((a, i) => row(a, recent.length + i))}
        {data && flat.length === 0 && <li className={styles.pickEmpty}>No account matches “{debouncedSearch}”. Try a number or a shorter name.</li>}
      </PopoverList>
    </Popover>
  );
}

export function JobPickerPopover({
  open,
  anchorRef,
  txn,
  locationId,
  onSelect,
  onClear,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  txn: BankFeedRow;
  locationId: string | null;
  onSelect: (jobId: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 200);

  const effectiveLocation = locationId ?? txn.location?.id ?? null;
  const searchParams: Record<string, string> = {};
  if (effectiveLocation) searchParams.location_id = effectiveLocation;
  if (debouncedSearch) searchParams.q = debouncedSearch;

  const { data: jobs, isLoading } = useQuery<JobSearchResult[]>('/api/jobs/search', searchParams, {
    enabled: open && !!effectiveLocation,
  });
  const list = jobs ?? [];
  const { active, setActive, onKey } = useListCursor(list.length, debouncedSearch);
  const currentJobId = txn.final_job?.id;

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={320} role="dialog" aria-label="Assign a job">
      <PopoverHead>
        <Icon name="search" />
        <input
          data-autofocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => onKey(e, (i) => list[i] && onSelect(list[i].id))}
          placeholder={effectiveLocation ? 'Search jobs' : 'Choose a company first'}
          disabled={!effectiveLocation}
          aria-label="Search jobs"
        />
      </PopoverHead>
      <PopoverList className={styles.pickList} role="listbox" aria-label="Jobs">
        {currentJobId && (
          <PopoverItem onClick={onClear} right={<Icon name="x" />}>
            <span className={styles.pickName}>Clear the job</span>
          </PopoverItem>
        )}
        {isLoading && !jobs && effectiveLocation && <li className={styles.pickEmpty}>Searching jobs…</li>}
        {list.map((j, i) => (
          <PopoverItem
            key={j.id}
            active={i === active}
            onMouseEnter={() => setActive(i)}
            onClick={() => onSelect(j.id)}
            right={j.id === currentJobId ? <Icon name="check" label="Current job" /> : undefined}
          >
            <span className="code">{j.job_number}</span>
            <span className={styles.pickName}>{j.name}</span>
          </PopoverItem>
        ))}
        {(!effectiveLocation || (jobs && list.length === 0)) && (
          <li className={styles.pickEmpty}>{effectiveLocation ? 'This company has no active jobs.' : 'Choose a company first.'}</li>
        )}
      </PopoverList>
    </Popover>
  );
}
