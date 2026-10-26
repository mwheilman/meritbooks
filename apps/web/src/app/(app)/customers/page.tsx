'use client';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { CustomerPeek } from './customer-peek';
import { CustomerDrawer } from './customer-drawer';

import { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Check,
  Field,
  InlineNotice,
  Input,
  Keyhints,
  ListPager,
  Pip,
  Search,
  Select,
  Tag,
  Textarea,
  useListKeynav,
} from '@meritbooks/merit-ui';
import { EmptyState, PageHeader, TableSkeleton } from '@/components/ui';
import { MatchBeforeCreate } from '@/components/parties/match-before-create';
import { useShellLine } from '@/components/layout/shell-context';
import s from './customers.module.css';

interface Customer {
  id: string;
  name: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payment_terms: string;
  credit_limit_cents: number | null;
  tax_exempt: boolean;
  contact_first_name: string | null;
  contact_last_name: string | null;
  is_portfolio_company: boolean;
  notes: string | null;
  website: string | null;
  created_at: string;
  ar: {
    totalOutstanding: number;
    overdueCount: number;
  };
}

interface CustomerFormData {
  name: string;
  display_name: string;
  email: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
  payment_terms: string;
  credit_limit: string;
  tax_exempt: boolean;
  contact_first_name: string;
  contact_last_name: string;
  is_portfolio_company: boolean;
  notes: string;
  website: string;
}

const EMPTY_FORM: CustomerFormData = {
  name: '', display_name: '', email: '', phone: '',
  address_line1: '', address_line2: '', city: '', state: '', zip: '',
  payment_terms: 'NET_30', credit_limit: '', tax_exempt: false,
  contact_first_name: '', contact_last_name: '',
  is_portfolio_company: false, notes: '', website: '',
};

const PAYMENT_TERMS = [
  { value: 'NET_10', label: 'Net 10' },
  { value: 'NET_15', label: 'Net 15' },
  { value: 'NET_30', label: 'Net 30' },
  { value: 'NET_45', label: 'Net 45' },
  { value: 'NET_60', label: 'Net 60' },
  { value: 'DUE_ON_RECEIPT', label: 'Due on receipt' },
];

/** The list API serves 50 per page (its default); the pager walks the rest. */
const PER_PAGE = 50;

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ search, sort_by: sortBy, sort_dir: sortDir, page: String(page), per_page: String(PER_PAGE) });
      const res = await fetch(`/api/customers?${params}`);
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data?.error ?? 'The customer list did not load.');
        setCustomers([]);
        return;
      }
      setCustomers(data.customers ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setLoadError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
    // reloadKey re-runs the fetch for "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sortBy, sortDir, page, reloadKey]);

  useEffect(() => {
    const timer = setTimeout(fetchCustomers, 300);
    return () => clearTimeout(timer);
  }, [fetchCustomers]);

  // A new search / sort starts from the first page.
  useEffect(() => { setPage(1); }, [search, sortBy, sortDir]);

  const handleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Customer name is required'); return; }
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          credit_limit_cents: form.credit_limit ? Math.round(parseFloat(form.credit_limit) * 100) : null,
          create_anyway: createAnyway,
        }),
      });
      const data = await res.json();

      if (res.status === 409) {
        setError(`Duplicate: ${data.duplicates?.map((d: { name: string }) => d.name).join(', ')}`);
        setSaving(false);
        return;
      }

      if (!res.ok) {
        setError(data.error || 'Failed to create customer');
        setSaving(false);
        return;
      }

      setShowCreate(false);
      setForm(EMPTY_FORM);
      fetchCustomers();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/customers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId,
          ...form,
          credit_limit_cents: form.credit_limit ? Math.round(parseFloat(form.credit_limit) * 100) : null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to update customer');
        setSaving(false);
        return;
      }

      setEditingId(null);
      setForm(EMPTY_FORM);
      fetchCustomers();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  // "Already in Merit" (migration 194): the person chose to create despite a possible match.
  const [createAnyway, setCreateAnyway] = useState(false);
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<Customer>();

  const startEdit = (c: Customer) => {
    setEditingId(c.id);
    setShowCreate(false);
    setForm({
      name: c.name,
      display_name: c.display_name || '',
      email: c.email || '',
      phone: c.phone || '',
      address_line1: c.address_line1 || '',
      address_line2: '',
      city: c.city || '',
      state: c.state || '',
      zip: c.zip || '',
      payment_terms: c.payment_terms || 'NET_30',
      credit_limit: c.credit_limit_cents ? (c.credit_limit_cents / 100).toString() : '',
      tax_exempt: c.tax_exempt,
      contact_first_name: c.contact_first_name || '',
      contact_last_name: c.contact_last_name || '',
      is_portfolio_company: c.is_portfolio_company,
      notes: c.notes || '',
      website: c.website || '',
    });
  };

  const openCreate = () => { setShowCreate(true); setEditingId(null); setForm(EMPTY_FORM); setError(null); setCreateAnyway(false); };
  const closeForm = () => { setShowCreate(false); setEditingId(null); setError(null); };

  const isFormOpen = showCreate || editingId !== null;
  // The empty state carries the page's one primary verb; the header button steps down.
  const listEmpty = !loading && !loadError && customers.length === 0;
  const nameMissing = !!error && !form.name.trim();
  const creditInvalid = form.credit_limit !== '' && (Number.isNaN(parseFloat(form.credit_limit)) || parseFloat(form.credit_limit) < 0);

  // J / K move the cursor, Enter opens the customer, E edits. Off while the drawer owns the keys.
  const { activeIndex, setActiveIndex, rowProps } = useListKeynav({
    count: customers.length,
    onOpen: (i) => { const c = customers[i]; if (c) setSelectedCustomerId(c.id); },
    onAction: (i) => { const c = customers[i]; if (c) startEdit(c); },
    actionKey: 'e',
    enabled: !selectedCustomerId && !loading,
    owner: 'Customers list',
  });

  const overdueOnPage = customers.filter((c) => c.ar.overdueCount > 0).length;
  useShellLine(
    loading && customers.length === 0
      ? null
      : [
          { label: `${total.toLocaleString()} customer${total !== 1 ? 's' : ''}`, strong: true },
          overdueOnPage > 0 ? `${overdueOnPage} with overdue invoices on this page` : 'Nothing overdue on this page',
          ...(search ? [`Matching “${search}”`] : []),
        ],
    `${total}:${overdueOnPage}:${search}:${loading && customers.length === 0}`,
  );

  return (
    <div>
      <PageHeader
        eyebrow={['Receivables', 'Customers']}
        title="Customers"
        description={`${total.toLocaleString()} customer${total !== 1 ? 's' : ''} — who you invoice, their terms, open balances, statements and portal access.`}
        actions={
          <Button variant={isFormOpen || listEmpty ? 'default' : 'primary'} icon="plus" chord="n" bindChord={!isFormOpen} onClick={openCreate}>
            New customer
          </Button>
        }
      />

      <div className={s.toolbar}>
        <Search
          className={s.searchBox}
          aria-label="Search customers"
          placeholder="Search name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slashToFocus
        />
        <span className={s.grow} />
        <Keyhints
          hints={[
            { chord: 'j', label: 'Next' },
            { chord: 'k', label: 'Previous' },
            { chord: 'enter', label: 'Open' },
            { chord: 'e', label: 'Edit' },
          ]}
        />
      </div>

      {isFormOpen && (
        <section className={s.form} aria-label={showCreate ? 'New customer' : 'Edit customer'}>
          <div className={s.formHead}>
            <h2 className="t-head">{showCreate ? 'New customer' : 'Edit customer'}</h2>
            <Button variant="quiet" iconOnly icon="x" aria-label="Close the form" onClick={closeForm} />
          </div>

          {error && (
            <div className={s.formNotices}>
              <InlineNotice tone={error.startsWith('Duplicate:') ? 'warn' : 'neg'} title={error.startsWith('Duplicate:') ? 'This may be a customer you already have.' : 'Not saved.'}>
                {error}
              </InlineNotice>
            </div>
          )}

          <div className={s.formGrid}>
            {showCreate && (
              <MatchBeforeCreate
                className={s.span2}
                kind="customer"
                name={form.name}
                email={form.email}
                phone={form.phone}
                address={[form.address_line1, [form.city, form.state, form.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
                onDecision={(d) => setCreateAnyway(d === 'create_anyway')}
                onUseExisting={(m) => { closeForm(); setForm(EMPTY_FORM); setSelectedCustomerId(m.id); }}
              />
            )}
            <Field label="Customer name *" error={nameMissing ? 'Enter the customer’s name.' : undefined}>
              <Input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Acme Corp" autoFocus />
            </Field>
            <Field label="Display name">
              <Input type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            </Field>
            <Field label="Payment terms">
              <Select value={form.payment_terms} onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}>
                {PAYMENT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </Field>
            <Field label="Primary contact first name">
              <Input type="text" value={form.contact_first_name} onChange={(e) => setForm({ ...form, contact_first_name: e.target.value })} />
            </Field>
            <Field label="Primary contact last name">
              <Input type="text" value={form.contact_last_name} onChange={(e) => setForm({ ...form, contact_last_name: e.target.value })} />
            </Field>
            <Field label="Email" help="Statements and portal links go here.">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <Field label="Credit limit ($)" error={creditInvalid ? 'Enter a dollar amount of zero or more.' : undefined}>
              <Input type="number" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })}
                placeholder="0.00" step="0.01" min={0} className="tnum" />
            </Field>
            <Field label="Address" className={s.span2}>
              <Input type="text" value={form.address_line1} onChange={(e) => setForm({ ...form, address_line1: e.target.value })} />
            </Field>
            <div className={s.cityRow}>
              <Field label="City">
                <Input type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="City" />
              </Field>
              <Field label="State">
                <Input type="text" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} placeholder="IA" maxLength={2} />
              </Field>
              <Field label="ZIP">
                <Input type="text" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} placeholder="ZIP" />
              </Field>
            </div>
            <div className={`${s.checks} ${s.span2}`}>
              <Check label="Tax exempt" checked={form.tax_exempt} onChange={(e) => setForm({ ...form, tax_exempt: e.target.checked })} />
              <Check label="Internal company" checked={form.is_portfolio_company} onChange={(e) => setForm({ ...form, is_portfolio_company: e.target.checked })} />
            </div>
            <Field label="Notes" className={s.span3}>
              <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
            </Field>
          </div>

          <div className={s.formFoot}>
            <Button variant="quiet" onClick={() => { setShowCreate(false); setEditingId(null); }}>Cancel</Button>
            <Button variant="primary" onClick={showCreate ? handleCreate : handleUpdate} disabled={saving || creditInvalid} aria-busy={saving || undefined}>
              {saving ? 'Saving…' : showCreate ? 'Create customer' : 'Save changes'}
            </Button>
          </div>
        </section>
      )}

      {loading && customers.length === 0 ? (
        <TableSkeleton rows={8} cols={6} />
      ) : loadError ? (
        <div className={`wg-state ${s.errorState}`} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <span className="t-head">The customer list didn’t load.</span>
          <p className="ink-2">{loadError}</p>
          <Button onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
        </div>
      ) : customers.length === 0 ? (
        <div className={s.state}>
          {search ? (
            <EmptyState
              title="No customers match."
              description={`Nothing matches “${search}”. Try another name or email.`}
              action={{ label: 'Clear search', onClick: () => setSearch('') }}
            />
          ) : (
            <EmptyState
              title="No customers yet."
              description="Add the people and companies you invoice. Invoices, statements, payments and the customer portal hang off each customer."
              action={{ label: 'Create your first customer', onClick: () => { setShowCreate(true); setForm(EMPTY_FORM); } }}
            />
          )}
        </div>
      ) : (
        <>
          <div className={s.tableWrap} aria-busy={loading || undefined}>
            <table className="tbl tbl-q" aria-label="Customers">
              <thead>
                <tr>
                  <th scope="col" aria-sort={sortBy === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <button type="button" className={sortBy === 'name' ? 'th-sort' : 'mb-th-btn'} onClick={() => handleSort('name')} aria-label="Sort by customer name">
                      Customer{sortBy === 'name' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                  </th>
                  <th scope="col">Contact</th>
                  <th scope="col">Terms</th>
                  <th scope="col" className="n">Outstanding</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="n"><span className="sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c, i) => {
                  const rp = rowProps(i);
                  return (
                    <tr
                      key={c.id}
                      ref={rp.ref}
                      data-active={rp['data-active']}
                      {...rowHandlers(c)}
                      onClick={(e) => {
                        setActiveIndex(i);
                        if ((e.target as HTMLElement).closest('a,button,input')) return;
                        setSelectedCustomerId(c.id);
                      }}
                      className={`q-row${activeIndex === i ? ' is-cursor' : ''}${c.ar.overdueCount > 0 ? ' is-attn' : ''}`}
                      aria-current={activeIndex === i ? 'true' : undefined}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <span className="l1">{c.display_name || c.name}</span>
                        {c.city && c.state && <span className="l2">{c.city}, {c.state}</span>}
                      </td>
                      <td>
                        {(c.contact_first_name || c.contact_last_name) && (
                          <span className="l1">{c.contact_first_name} {c.contact_last_name}</span>
                        )}
                        {c.email && <span className="l2">{c.email}</span>}
                        {c.phone && <span className="l2">{c.phone}</span>}
                        {!c.contact_first_name && !c.contact_last_name && !c.email && !c.phone && <span className="ink-3">—</span>}
                      </td>
                      <td>
                        <span className="ink-2">
                          {PAYMENT_TERMS.find((t) => t.value === c.payment_terms)?.label || c.payment_terms}
                        </span>
                      </td>
                      <td className="n">
                        {c.ar.totalOutstanding > 0 ? (
                          <>
                            <span className="l1 tnum">{formatMoney(c.ar.totalOutstanding)}</span>
                            {c.ar.overdueCount > 0 && (
                              <span className={`l2 ${s.overdue}`}>
                                <Pip kind="overdue" />
                                <span className="tnum">{c.ar.overdueCount}</span> overdue
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="tnum ink-3">$0.00</span>
                        )}
                      </td>
                      <td>
                        {c.is_portfolio_company ? <Tag tone="ai">Internal</Tag> : <Tag>External</Tag>}
                      </td>
                      <td className="n">
                        <span className="mb-row-acts">
                          <Button variant="quiet" onClick={(e) => { e.stopPropagation(); startEdit(c); }}>Edit</Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={s.foot}>
            <span className="t-cap">Hover a customer for a preview · click or press Enter for the full record.</span>
            <ListPager page={page} perPage={PER_PAGE} total={total} onPage={setPage} noun="customers" />
          </div>
        </>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null}
        visible={!!peek}
        cardHandlers={cardHandlers}
        onOpen={peek ? () => { const id = peek.item.id; close(); setSelectedCustomerId(id); } : undefined}
      >
        {peek && <CustomerPeek customerId={peek.item.id} />}
      </HoverPeekCard>

      <CustomerDrawer
        customerId={selectedCustomerId}
        onClose={() => setSelectedCustomerId(null)}
        onEdit={selectedCustomerId ? () => { const c = customers.find((x) => x.id === selectedCustomerId); setSelectedCustomerId(null); if (c) startEdit(c); } : undefined}
      />
    </div>
  );
}
