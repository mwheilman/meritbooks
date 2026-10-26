'use client';

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
  Seg,
  Select,
  Tag,
  Textarea,
  useListKeynav,
  type PipKind,
} from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import { EmptyState, PageHeader, TableSkeleton } from '@/components/ui';
import { MatchBeforeCreate } from '@/components/parties/match-before-create';
import { useHoverPeek, HoverPeekCard } from '@/components/hover-peek';
import { useShellLine } from '@/components/layout/shell-context';
import { VendorDrawer } from './vendor-drawer';
import { VendorPeek } from './vendor-peek';
import s from './vendors.module.css';

interface Vendor {
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
  is_1099: boolean;
  missing_tin: boolean;
  ytd_spend_cents: number;
  tax_id: string | null;
  notes: string | null;
  website: string | null;
  ai_confidence: number;
  auto_approve: boolean;
  created_at: string;
  compliance: {
    w9: 'valid' | 'expired' | 'missing';
    glCoi: 'valid' | 'expired' | 'missing';
    wcCoi: 'valid' | 'expired' | 'missing';
    hasActiveHold: boolean;
  };
}

interface VendorFormData {
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
  is_1099: boolean;
  tax_id: string;
  notes: string;
  website: string;
}

const EMPTY_FORM: VendorFormData = {
  name: '', display_name: '', email: '', phone: '',
  address_line1: '', address_line2: '', city: '', state: '', zip: '',
  payment_terms: 'NET_30', is_1099: false, tax_id: '', notes: '', website: '',
};

const PAYMENT_TERMS = [
  { value: 'NET_10', label: 'Net 10' },
  { value: 'NET_15', label: 'Net 15' },
  { value: 'NET_30', label: 'Net 30' },
  { value: 'NET_45', label: 'Net 45' },
  { value: 'NET_60', label: 'Net 60' },
  { value: 'NET_90', label: 'Net 90' },
  { value: 'DUE_ON_RECEIPT', label: 'Due on receipt' },
  { value: '2_10_NET_30', label: '2/10 Net 30' },
];

/** The list API serves 50 per page (its default); the pager walks the rest. */
const PER_PAGE = 50;

type DocState = 'valid' | 'expired' | 'missing';
const DOC_LOOK: Record<DocState, { pip: PipKind; word: string }> = {
  valid: { pip: 'ready', word: 'Valid' },
  expired: { pip: 'risk', word: 'Expired' },
  missing: { pip: 'overdue', word: 'Missing' },
};

/** One compliance document: pip shape + short label; the state word for screen readers and on hover. */
function ComplianceDoc({ label, status }: { label: string; status: DocState }) {
  const look = DOC_LOOK[status];
  return (
    <span className={s.doc} title={`${label}: ${look.word}`}>
      <Pip kind={look.pip} />
      {label}
      <span className="sr">{look.word}</span>
    </span>
  );
}

function SortHead({ label, col, sortBy, sortDir, onSort }: { label: string; col: string; sortBy: string; sortDir: 'asc' | 'desc'; onSort: (col: string) => void }) {
  const on = sortBy === col;
  return (
    <button type="button" className={on ? 'th-sort' : 'mb-th-btn'} onClick={() => onSort(col)} aria-label={`Sort by ${label.toLowerCase()}`}>
      {label}
      {on ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
}

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<VendorFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<Array<{ id: string; name: string }> | null>(null);
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter1099, setFilter1099] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  // "Already in Merit" (migration 194): the person chose to create despite a possible match.
  const [createAnyway, setCreateAnyway] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { peek, rowHandlers, cardHandlers, close } = useHoverPeek<Vendor>();

  const fetchVendors = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({
        search, sort_by: sortBy, sort_dir: sortDir,
        page: String(page), per_page: String(PER_PAGE),
        ...(filter1099 ? { is_1099: 'true' } : {}),
      });
      const res = await fetch(`/api/vendors?${params}`);
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data?.error ?? 'The vendor list did not load.');
        setVendors([]);
        return;
      }
      setVendors(data.vendors ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setLoadError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
    // reloadKey re-runs the fetch for "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sortBy, sortDir, filter1099, page, reloadKey]);

  useEffect(() => {
    const timer = setTimeout(fetchVendors, 300);
    return () => clearTimeout(timer);
  }, [fetchVendors]);

  // A new search / filter / sort starts from the first page.
  useEffect(() => { setPage(1); }, [search, filter1099, sortBy, sortDir]);

  const handleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Vendor name is required'); return; }
    setSaving(true);
    setError(null);
    setDuplicateWarning(null);

    try {
      const res = await fetch('/api/vendors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, create_anyway: createAnyway }),
      });
      const data = await res.json();

      if (res.status === 409) {
        setDuplicateWarning(data.duplicates);
        setSaving(false);
        return;
      }

      if (!res.ok) {
        setError(data.error || 'Failed to create vendor');
        setSaving(false);
        return;
      }

      setShowCreate(false);
      setForm(EMPTY_FORM);
      fetchVendors();
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
      const res = await fetch('/api/vendors', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingId, ...form }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to update vendor');
        setSaving(false);
        return;
      }

      setEditingId(null);
      setForm(EMPTY_FORM);
      fetchVendors();
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (vendor: Vendor) => {
    setEditingId(vendor.id);
    setShowCreate(false);
    setForm({
      name: vendor.name,
      display_name: vendor.display_name || '',
      email: vendor.email || '',
      phone: vendor.phone || '',
      address_line1: vendor.address_line1 || '',
      address_line2: '',
      city: vendor.city || '',
      state: vendor.state || '',
      zip: vendor.zip || '',
      payment_terms: vendor.payment_terms || 'NET_30',
      is_1099: vendor.is_1099,
      tax_id: vendor.tax_id || '',
      notes: vendor.notes || '',
      website: vendor.website || '',
    });
  };

  const openCreate = () => { setShowCreate(true); setEditingId(null); setForm(EMPTY_FORM); setError(null); setDuplicateWarning(null); setCreateAnyway(false); };
  const closeForm = () => { setShowCreate(false); setEditingId(null); setError(null); setDuplicateWarning(null); };

  const isFormOpen = showCreate || editingId !== null;
  // The empty state carries the page's one primary verb; the header button steps down.
  const listEmpty = !loading && !loadError && vendors.length === 0;
  const nameMissing = !!error && !form.name.trim();

  // J / K move the cursor, Enter opens the 360, E edits. Off while the drawer owns the keys.
  const { activeIndex, setActiveIndex, rowProps } = useListKeynav({
    count: vendors.length,
    onOpen: (i) => { const v = vendors[i]; if (v) setDetailId(v.id); },
    onAction: (i) => { const v = vendors[i]; if (v) startEdit(v); },
    actionKey: 'e',
    enabled: !detailId && !loading,
    owner: 'Vendors list',
  });

  useShellLine(
    loading && vendors.length === 0
      ? null
      : [
          { label: `${total.toLocaleString()} vendor${total !== 1 ? 's' : ''}`, strong: true },
          filter1099 ? '1099 vendors only' : 'All vendors',
          ...(search ? [`Matching “${search}”`] : []),
        ],
    `${total}:${filter1099}:${search}:${loading && vendors.length === 0}`,
  );

  return (
    <div>
      <PageHeader
        eyebrow={['Payables', 'Vendors']}
        title="Vendors"
        description={`${total.toLocaleString()} vendor${total !== 1 ? 's' : ''} — payee identity, terms, compliance documents and 1099 status.`}
        actions={
          <Button variant={isFormOpen || listEmpty ? 'default' : 'primary'} icon="plus" chord="n" bindChord={!isFormOpen} onClick={openCreate}>
            New vendor
          </Button>
        }
      />

      {/* Filters */}
      <div className={s.toolbar}>
        <Search
          className={s.searchBox}
          aria-label="Search vendors"
          placeholder="Search name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slashToFocus
        />
        <Seg<'all' | '1099'>
          aria-label="Vendor filter"
          value={filter1099 ? '1099' : 'all'}
          onChange={(v) => setFilter1099(v === '1099')}
          items={[
            { value: 'all', label: 'All vendors' },
            { value: '1099', label: '1099 only' },
          ]}
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

      {/* Create/Edit Form */}
      {isFormOpen && (
        <section className={s.form} aria-label={showCreate ? 'New vendor' : 'Edit vendor'}>
          <div className={s.formHead}>
            <h2 className="t-head">{showCreate ? 'New vendor' : 'Edit vendor'}</h2>
            <Button variant="quiet" iconOnly icon="x" aria-label="Close the form" onClick={closeForm} />
          </div>

          {(error || duplicateWarning) && (
            <div className={s.formNotices}>
              {error && (
                <InlineNotice tone="neg" title="Not saved.">
                  {error}
                </InlineNotice>
              )}
              {duplicateWarning && (
                <InlineNotice tone="warn" title="This may be a vendor you already have.">
                  Similar vendor{duplicateWarning.length > 1 ? 's' : ''} already exist: {duplicateWarning.map((d) => d.name).join(', ')}.
                  Open the existing vendor instead, or change the name.
                </InlineNotice>
              )}
            </div>
          )}

          <div className={s.formGrid}>
            {showCreate && (
              <MatchBeforeCreate
                className={s.span2}
                kind="vendor"
                name={form.name}
                email={form.email}
                phone={form.phone}
                address={[form.address_line1, [form.city, form.state, form.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
                onDecision={(d) => setCreateAnyway(d === 'create_anyway')}
                onUseExisting={(m) => { closeForm(); setForm(EMPTY_FORM); setDetailId(m.id); }}
              />
            )}
            <Field label="Vendor name *" error={nameMissing ? 'Enter the vendor’s name.' : undefined}>
              <Input
                type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="ABC Supply Co."
                autoFocus
              />
            </Field>
            <Field label="Display name">
              <Input
                type="text" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                placeholder="ABC Supply"
              />
            </Field>
            <Field label="Payment terms">
              <Select value={form.payment_terms} onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}>
                {PAYMENT_TERMS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Email">
              <Input
                type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="ap@vendor.com"
              />
            </Field>
            <Field label="Phone">
              <Input
                type="text" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="(515) 555-0100"
              />
            </Field>
            <Field label="Website">
              <Input
                type="text" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })}
                placeholder="https://vendor.com"
              />
            </Field>
            <Field label="Address" className={s.span2}>
              <Input
                type="text" value={form.address_line1} onChange={(e) => setForm({ ...form, address_line1: e.target.value })}
                placeholder="123 Main St"
              />
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
            <div className={s.checkCell}>
              <Check
                label="1099 contractor"
                checked={form.is_1099}
                onChange={(e) => setForm({ ...form, is_1099: e.target.checked })}
              />
            </div>
            {form.is_1099 && (
              <Field label="Tax ID (EIN or SSN)" help="Stored encrypted; shown masked after saving.">
                <Input
                  type="text" value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })}
                  placeholder="XX-XXXXXXX"
                  autoComplete="off"
                />
              </Field>
            )}
            <Field label="Notes" className={s.span3}>
              <Textarea
                value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
              />
            </Field>
          </div>

          <div className={s.formFoot}>
            <Button variant="quiet" onClick={() => { setShowCreate(false); setEditingId(null); }}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={showCreate ? handleCreate : handleUpdate}
              disabled={saving}
              aria-busy={saving || undefined}
            >
              {saving ? 'Saving…' : showCreate ? 'Create vendor' : 'Save changes'}
            </Button>
          </div>
        </section>
      )}

      {/* Table */}
      {loading && vendors.length === 0 ? (
        <TableSkeleton rows={8} cols={7} />
      ) : loadError ? (
        <div className={`wg-state ${s.errorState}`} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <span className="t-head">The vendor list didn’t load.</span>
          <p className="ink-2">{loadError}</p>
          <Button onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
        </div>
      ) : vendors.length === 0 ? (
        <div className={s.state}>
          {search || filter1099 ? (
            <EmptyState
              title="No vendors match."
              description={search ? `Nothing matches “${search}”${filter1099 ? ' among 1099 vendors' : ''}. Try another name or email.` : 'No vendors are marked 1099 yet.'}
              action={{ label: 'Clear filters', onClick: () => { setSearch(''); setFilter1099(false); } }}
            />
          ) : (
            <EmptyState
              title="No vendors yet."
              description="Add the people and companies you pay. Bills, payments, W-9s and certificates of insurance hang off each vendor."
              action={{ label: 'Create your first vendor', onClick: () => { setShowCreate(true); setForm(EMPTY_FORM); } }}
            />
          )}
        </div>
      ) : (
        <>
          <div className={s.tableWrap} aria-busy={loading || undefined}>
            <table className="tbl tbl-q" aria-label="Vendors">
              <thead>
                <tr>
                  <th scope="col" aria-sort={sortBy === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <SortHead label="Vendor" col="name" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th scope="col">Contact</th>
                  <th scope="col" aria-sort={sortBy === 'payment_terms' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <SortHead label="Terms" col="payment_terms" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th scope="col" className="n">YTD spend</th>
                  <th scope="col">Compliance</th>
                  <th scope="col" aria-sort={sortBy === 'is_1099' ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <SortHead label="1099" col="is_1099" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th scope="col" className="n"><span className="sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v, i) => {
                  const rp = rowProps(i);
                  return (
                    <tr
                      key={v.id}
                      ref={rp.ref}
                      data-active={rp['data-active']}
                      {...rowHandlers(v)}
                      className={`q-row${activeIndex === i ? ' is-cursor' : ''}${v.compliance.hasActiveHold ? ' is-attn' : ''}`}
                      aria-current={activeIndex === i ? 'true' : undefined}
                      onClick={(e) => {
                        setActiveIndex(i);
                        if ((e.target as HTMLElement).closest('a,button,input')) return;
                        setDetailId(v.id);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <button type="button" className="l1 mb-row-link" onClick={() => setDetailId(v.id)}>
                          {v.display_name || v.name}
                        </button>
                        {v.display_name && v.display_name !== v.name ? (
                          <span className="l2">{v.name}{v.city && v.state ? ` · ${v.city}, ${v.state}` : ''}</span>
                        ) : v.city && v.state ? (
                          <span className="l2">{v.city}, {v.state}</span>
                        ) : null}
                      </td>
                      <td>
                        {v.email && <span className="l1">{v.email}</span>}
                        {v.phone && <span className="l2">{v.phone}</span>}
                        {!v.email && !v.phone && <span className="ink-3">—</span>}
                      </td>
                      <td>
                        <span className="ink-2">
                          {PAYMENT_TERMS.find((t) => t.value === v.payment_terms)?.label || v.payment_terms}
                        </span>
                      </td>
                      <td className="n">
                        {v.ytd_spend_cents > 0 ? (
                          <span className="tnum">{formatMoney(v.ytd_spend_cents, { compact: true })}</span>
                        ) : (
                          <span className="ink-3">—</span>
                        )}
                      </td>
                      <td>
                        <span className={s.docs}>
                          <ComplianceDoc label="W-9" status={v.compliance.w9} />
                          <ComplianceDoc label="GL" status={v.compliance.glCoi} />
                          <ComplianceDoc label="WC" status={v.compliance.wcCoi} />
                          {v.compliance.hasActiveHold && <Tag tone="neg">On hold</Tag>}
                        </span>
                      </td>
                      <td>
                        {v.is_1099 ? (
                          v.missing_tin ? (
                            <Tag tone="neg" title="1099-eligible but no TIN on file">No TIN</Tag>
                          ) : (
                            <Tag>1099</Tag>
                          )
                        ) : (
                          <span className="ink-3">—</span>
                        )}
                      </td>
                      <td className="n">
                        <span className="mb-row-acts">
                          <Button variant="quiet" onClick={() => setDetailId(v.id)}>View</Button>
                          <Button variant="quiet" onClick={() => startEdit(v)}>Edit</Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={s.foot}>
            <span className="t-cap">Hover a vendor for a preview · click or press Enter for the full record.</span>
            <ListPager page={page} perPage={PER_PAGE} total={total} onPage={setPage} noun="vendors" />
          </div>
        </>
      )}

      <HoverPeekCard
        rect={peek?.rect ?? null}
        visible={!!peek}
        cardHandlers={cardHandlers}
        onOpen={peek ? () => { const id = peek.item.id; close(); setDetailId(id); } : undefined}
      >
        {peek && <VendorPeek vendorId={peek.item.id} />}
      </HoverPeekCard>

      <VendorDrawer vendorId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
