'use client';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { AccountPeek } from './account-peek';
import { AccountDrawer } from './account-drawer';
import { AccountsGroupedView, type GroupedAccount, type AccountBalance } from './accounts-grouped-view';
import { GlDetailModal } from './gl-detail-modal';
import { AccountFlags } from './account-flags';

import { useState, useCallback, useMemo } from 'react';
import {
  Button,
  Check,
  Field,
  InlineNotice,
  Input,
  Keyhints,
  Search,
  Seg,
  Select,
  Status,
  Tabs,
  Tag,
  Textarea,
  cx,
  useListKeynav,
} from '@meritbooks/merit-ui';
import { useQuery, useMutation, addToast } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { PageHeader, EmptyState, TableSkeleton } from '@/components/ui';
import s from './coa.module.css';

// ─── Types ──────────────────────────────────────────────────

interface AccountRow {
  id: string;
  accountNumber: string;
  name: string;
  accountType: string;
  groupName: string;
  subTypeName: string;
  typeName: string;
  normalBalance: string;
  isActive: boolean;
  isControlAccount: boolean;
  isCompanySpecific: boolean;
  isBankAccount: boolean;
  isCreditCard: boolean;
  approvalStatus: string;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  requireDepartment: boolean;
  requireClass: boolean;
  requireItem: boolean;
  createdAt: string;
}

interface AccountsResponse {
  data: AccountRow[];
  counts: { pending: number; approved: number; total: number };
}

interface BalancesResponse {
  balances: Record<string, AccountBalance>;
  period: { year: number; month: number; periodStart: string; periodEnd: string; yearStart: string; ytdEnd: string; label: string };
  meta: { linesScanned: number; truncated: boolean };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const TYPE_LABELS: Record<string, string> = {
  ASSET: 'Asset',
  LIABILITY: 'Liability',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  COGS: 'Cost of goods sold',
  OPEX: 'Operating expense',
  OTHER: 'Other income/expense',
};

function ApprovalStatus({ status }: { status: string }) {
  if (status === 'PENDING') return <Status kind="risk">Pending</Status>;
  if (status === 'APPROVED') return <Status kind="ready">Active</Status>;
  return <Status kind="blocked">Rejected</Status>;
}

// ─── Main Page ──────────────────────────────────────────────

export default function ChartOfAccountsPage() {
  const [showRequest, setShowRequest] = useState(false);
  const [tab, setTab] = useState<'all' | 'pending'>('all');
  const [view, setView] = useState<'grouped' | 'list'>('grouped');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [refreshKey, setRefreshKey] = useState(0);

  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);

  const { activeCompanyId } = useActiveCompany();
  const scopedLocation = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;

  const params: Record<string, string> = {};
  if (tab === 'pending') params.approval_status = 'PENDING';
  if (typeFilter) params.account_type = typeFilter;

  const { data, isLoading, error } = useQuery<AccountsResponse>(
    '/api/accounts', Object.keys(params).length > 0 ? params : undefined,
    { key: String(refreshKey) }
  );

  // Per-account ledger activity (POSTED only), scoped to the active company via
  // the shared hook. Only needed for the grouped balance view / list balances.
  const { data: balData, isLoading: balLoading, error: balError } = useQuery<BalancesResponse>(
    '/api/accounts/balances',
    { year: String(year), period_month: String(month) },
    { key: String(refreshKey) }
  );
  const balances = balData?.balances ?? {};
  const periodLabel = balData?.period.label ?? `${MONTHS[month - 1]} ${year}`;

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [ledgerAccount, setLedgerAccount] = useState<GroupedAccount | null>(null);
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<{ id: string }>();

  const accounts = useMemo(() => data?.data ?? [], [data]);
  const counts = data?.counts;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter((a) => {
      if (statusFilter === 'active' && !a.isActive) return false;
      if (statusFilter === 'inactive' && a.isActive) return false;
      if (!q) return true;
      return (
        a.accountNumber.includes(search) ||
        a.name.toLowerCase().includes(q) ||
        a.groupName.toLowerCase().includes(q)
      );
    });
  }, [accounts, search, statusFilter]);

  // Approve/reject — check the response and tell the user either way (a failed
  // approve used to be silent; audit 06 §5 bug 6).
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const handleApproval = useCallback(async (accountId: string, action: 'approve' | 'reject') => {
    setApprovalBusyId(accountId);
    try {
      const res = await fetch('/api/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, action }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        account?: { account_number: string; name: string };
      };
      if (res.ok && json.success) {
        const label = json.account ? `${json.account.account_number} · ${json.account.name}` : 'Account';
        addToast('success', action === 'approve' ? `${label} approved` : `${label} rejected`);
        setRefreshKey((k) => k + 1);
      } else {
        addToast('error', json.error ?? `Could not ${action} account (${res.status})`);
      }
    } catch {
      addToast('error', `Network error — could not ${action} account`);
    } finally {
      setApprovalBusyId(null);
    }
  }, []);

  const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER'];
  const showGrouped = tab === 'all' && view === 'grouped';
  const yearOptions = [now.getUTCFullYear(), now.getUTCFullYear() - 1, now.getUTCFullYear() - 2];
  const anyFilter = !!search || !!typeFilter || statusFilter !== 'all';
  const overlayOpen = !!selectedAccountId || !!ledgerAccount || showRequest;

  // List view keys: J/K move · Enter opens the account. (The grouped view owns
  // its own keys; only one of the two is mounted.)
  const showList = !showGrouped && !isLoading && !error && filtered.length > 0;
  const { setActiveIndex, rowProps } = useListKeynav({
    count: showList ? filtered.length : 0,
    onOpen: (i) => { const a = filtered[i]; if (a) { close(); setSelectedAccountId(a.id); } },
    enabled: showList && !overlayOpen,
    owner: 'Chart of accounts (list)',
  });

  return (
    <div className={s.stack}>
      <PageHeader
        title="Chart of accounts"
        description={`${counts?.total ?? 0} accounts · ${counts?.pending ?? 0} pending approval`}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setShowRequest(true)}>
            Request account
          </Button>
        }
      />

      {showRequest && (
        <RequestAccountForm
          onClose={() => setShowRequest(false)}
          onSuccess={() => { setShowRequest(false); setRefreshKey((k) => k + 1); }}
        />
      )}

      <Tabs<'all' | 'pending'>
        aria-label="Account approval"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'all', label: 'All', count: counts?.total ?? 0 },
          { value: 'pending', label: 'Pending approval', count: counts?.pending ?? 0 },
        ]}
      />

      {/* Filters */}
      <div className={s.toolbar}>
        {tab === 'all' && (
          <Seg<'grouped' | 'list'>
            aria-label="View"
            value={view}
            onChange={setView}
            items={[
              { value: 'grouped', label: 'Grouped' },
              { value: 'list', label: 'List' },
            ]}
          />
        )}

        <Select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Filter accounts by type"
        >
          <option value="">All types</option>
          {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>)}
        </Select>

        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
          aria-label="Filter accounts by status"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </Select>

        {showGrouped && (
          <span className={s.period}>
            <Select value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Balance period month">
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </Select>
            <Select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Balance period year">
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </span>
        )}

        <span className={s.grow} />

        {showGrouped && balLoading && (
          <span className={cx('t-cap', s.loadingNote)} role="status">Loading balances…</span>
        )}
        {showGrouped && balError && !balLoading && (
          <Tag tone="neg" title={balError}>Balances didn&apos;t load</Tag>
        )}
        {showGrouped && balData?.meta.truncated && (
          <Tag tone="warn" title="Too many ledger lines to total in one pass">Balances partial</Tag>
        )}

        <Search
          className={s.searchBox}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search number, name or group"
          aria-label="Search accounts by number, name, or group"
          slashToFocus
        />
      </div>

      {/* Content */}
      {isLoading ? (
        <TableSkeleton rows={10} cols={6} />
      ) : error ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Couldn&apos;t load the chart of accounts.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => setRefreshKey((k) => k + 1)}>Try again</Button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={tab === 'pending' ? 'No pending requests' : anyFilter ? 'No accounts match' : 'No accounts yet'}
          description={
            tab === 'pending'
              ? 'New account requests awaiting approval will appear here.'
              : anyFilter
                ? 'No accounts match your search or filters. Try clearing them.'
                : 'Request your first account to start building the chart of accounts.'
          }
          action={
            tab === 'pending'
              ? undefined
              : anyFilter
                ? { label: 'Clear filters', onClick: () => { setSearch(''); setTypeFilter(''); setStatusFilter('all'); } }
                : { label: 'Request account', onClick: () => setShowRequest(true) }
          }
        />
      ) : showGrouped ? (
        <AccountsGroupedView
          accounts={filtered as GroupedAccount[]}
          balances={balances}
          periodLabel={periodLabel}
          onSelectAccount={(id) => { close(); setSelectedAccountId(id); }}
          onOpenLedger={(a) => setLedgerAccount(a)}
          keynavEnabled={!overlayOpen}
        />
      ) : (
        <div>
          <div className={s.tableWrap}>
            <table className="tbl tbl-q tbl-q--compact" aria-label="Chart of accounts">
              <colgroup>
                <col style={{ width: 104 }} />
                <col />
                <col style={{ width: 120 }} />
                <col />
                <col style={{ width: 120 }} />
                <col style={{ width: 176 }} />
                {tab === 'pending' && <col style={{ width: 200 }} />}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Group</th>
                  <th scope="col">Status</th>
                  <th scope="col">Flags</th>
                  {tab === 'pending' && <th scope="col" className="n">Decide</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((acct, i) => {
                  const { ref, 'data-active': active } = rowProps(i);
                  const busy = approvalBusyId === acct.id;
                  return (
                    <tr
                      key={acct.id}
                      ref={ref}
                      {...rowHandlers({ id: acct.id })}
                      onClick={() => { setActiveIndex(i); setSelectedAccountId(acct.id); }}
                      className={cx('q-row', active && 'is-cursor', !acct.isActive && 'ink-3')}
                      aria-current={active ? 'true' : undefined}
                      style={{ cursor: 'pointer' }}
                    >
                      <td><span className={s.num}>{acct.accountNumber}</span></td>
                      <td title={acct.name}>{acct.name}</td>
                      <td className="ink-2">{TYPE_LABELS[acct.accountType] ?? acct.accountType}</td>
                      <td className="ink-2" title={acct.groupName}>{acct.groupName}</td>
                      <td><ApprovalStatus status={acct.approvalStatus} /></td>
                      <td><AccountFlags account={acct} /></td>
                      {tab === 'pending' && (
                        <td className="n">
                          <span className="mb-row-acts">
                            <Button
                              variant="quiet"
                              onClick={(e) => { e.stopPropagation(); handleApproval(acct.id, 'reject'); }}
                              disabled={busy}
                              aria-busy={busy || undefined}
                              aria-label={`Reject account ${acct.accountNumber}`}
                            >
                              Reject
                            </Button>
                            <Button
                              variant="primary"
                              icon="check"
                              onClick={(e) => { e.stopPropagation(); handleApproval(acct.id, 'approve'); }}
                              disabled={busy}
                              aria-busy={busy || undefined}
                              aria-label={`Approve account ${acct.accountNumber}`}
                            >
                              {busy ? 'Saving…' : 'Approve'}
                            </Button>
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Keyhints
            className={s.hints}
            hints={[
              { chord: 'j k', label: 'Move' },
              { chord: 'enter', label: 'Open account' },
              { chord: '/', label: 'Search' },
            ]}
          />
        </div>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null}
        visible={!!peek}
        cardHandlers={cardHandlers}
        onOpen={peek ? () => { const id = peek.item.id; close(); setSelectedAccountId(id); } : undefined}
      >
        {peek && <AccountPeek accountId={peek.item.id} />}
      </HoverPeekCard>

      <AccountDrawer accountId={selectedAccountId} onClose={() => setSelectedAccountId(null)} />

      {ledgerAccount && balData && (
        <GlDetailModal
          accountId={ledgerAccount.id}
          accountNumber={ledgerAccount.accountNumber}
          accountName={ledgerAccount.name}
          startDate={balData.period.yearStart}
          endDate={balData.period.ytdEnd}
          periodStartDate={balData.period.periodStart}
          periodEndDate={balData.period.periodEnd}
          periodLabel={balData.period.label}
          locationId={scopedLocation}
          onClose={() => setLedgerAccount(null)}
        />
      )}
    </div>
  );
}

// ─── Request Account Form ───────────────────────────────────

function RequestAccountForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [accountNumber, setAccountNumber] = useState('');
  const [name, setName] = useState('');
  const [accountType, setAccountType] = useState('');
  const [groupId] = useState('');
  const [isCompanySpecific, setIsCompanySpecific] = useState(false);
  const [reqDept, setReqDept] = useState(false);
  const [reqClass, setReqClass] = useState(false);
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState('');

  const { mutate, isLoading: submitting, error: submitError } = useMutation<Record<string, unknown>, { success: boolean; message: string }>(
    '/api/accounts'
  );

  // Load account groups for the picker
  useQuery<{ id: string; name: string; display_order: number }[]>(
    '/api/accounts/search?meta=groups'
  );

  const handleSubmit = async () => {
    setFormError('');
    if (!accountNumber || !name || !accountType) {
      setFormError('Account number, name, and type are required');
      return;
    }

    const result = await mutate({
      account_number: accountNumber,
      name,
      account_type: accountType,
      account_group_id: groupId || undefined,
      is_company_specific: isCompanySpecific,
      require_department: reqDept,
      require_class: reqClass,
      notes: notes || undefined,
    });

    if (result?.success) {
      addToast('success', result.message ?? 'Account requested — pending approval');
      onSuccess();
    } else {
      setFormError('Failed to request account');
    }
  };

  const ready = !!accountNumber && !!name && !!accountType;

  return (
    <section className={s.form} aria-label="Request a new account">
      <div className={s.formHead}>
        <h2 className="t-section">Request a new account</h2>
        <Button variant="quiet" iconOnly icon="x" onClick={onClose} aria-label="Close request account form" />
      </div>
      <div className={s.formBody}>
        <InlineNotice tone="info">
          New accounts need CFO or Controller approval before they can receive postings.
        </InlineNotice>

        <div className={s.grid3}>
          <Field label="Account number" help="Up to 5 digits; the type sets the range.">
            <Input
              type="text"
              inputMode="numeric"
              className="tnum"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="e.g. 61500"
            />
          </Field>
          <Field label="Account name">
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Equipment rental"
            />
          </Field>
          <Field label="Account type">
            <Select value={accountType} onChange={(e) => setAccountType(e.target.value)}>
              <option value="">Select type…</option>
              <option value="ASSET">Asset (10000–19999)</option>
              <option value="LIABILITY">Liability (20000–29999)</option>
              <option value="EQUITY">Equity (30000–39999)</option>
              <option value="REVENUE">Revenue (40000–49999)</option>
              <option value="COGS">Cost of goods sold (50000–59999)</option>
              <option value="OPEX">Operating expense (60000–69999)</option>
              <option value="OTHER">Other income/expense (70000–99999)</option>
            </Select>
          </Field>
        </div>

        <div className={s.checks}>
          <Check label="Company-specific" checked={isCompanySpecific} onChange={(e) => setIsCompanySpecific(e.target.checked)} />
          <Check label="Require department" checked={reqDept} onChange={(e) => setReqDept(e.target.checked)} />
          <Check label="Require class" checked={reqClass} onChange={(e) => setReqClass(e.target.checked)} />
        </div>

        <Field label="Notes (visible to the approver)">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Why is this account needed?"
          />
        </Field>

        {formError && (
          <InlineNotice tone="neg" title={`${formError}.`}>
            {submitError ?? 'Check the fields and try again.'}
          </InlineNotice>
        )}

        <div className={s.formFoot}>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitting || !ready}
            aria-busy={submitting || undefined}
          >
            {submitting ? 'Requesting…' : 'Request account'}
          </Button>
        </div>
      </div>
    </section>
  );
}
