'use client';

import { useState, useEffect, useCallback, useRef, useMemo, type DragEvent } from 'react';
import { Button, Conf, Field, Icon, InlineNotice, Input, Select, Tag, cx } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { formatMoney, dollarsToCents } from '@meritbooks/shared';
import type { JobSearchResult } from '@meritbooks/shared';
import s from './bills.module.css';

// ─── Types ──────────────────────────────────────────────────

interface VendorOption {
  id: string;
  name: string;
  display_name: string | null;
  payment_terms_days: number;
  default_account_id: string | null;
}

interface LocationOption { id: string; name: string; short_code: string }

interface AccountOption {
  id: string;
  account_number: string;
  name: string;
  is_control_account: boolean;
}

type CostType = 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER';

interface BillLineState {
  key: string;
  description: string;
  account_id: string;
  accountLabel: string;
  quantity: string;
  unitCost: string;
  amount: string;
  confidence: number | null;
  job_id: string;
  jobLabel: string;
  cost_type: CostType;
}

interface ParsedResponse {
  parsed: {
    vendorName: string;
    vendorNameConfidence: number;
    billNumber: string | null;
    billNumberConfidence: number;
    billDate: string | null;
    billDateConfidence: number;
    dueDate: string | null;
    dueDateConfidence: number;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    totalConfidence: number;
    lines: Array<{ description: string; quantity: number; unitCostCents: number; amountCents: number; confidence: number }>;
    notes: string;
    parseTimeMs: number;
  };
  vendor: { id: string; name: string; confidence: number; paymentTermsDays: number; defaultAccountId: string | null } | null;
  suggestedAccount: { id: string; label: string } | null;
  duplicateWarning: string | null;
}

function genKey() { return Math.random().toString(36).slice(2, 8); }
function emptyLine(): BillLineState {
  return { key: genKey(), description: '', account_id: '', accountLabel: '', quantity: '1', unitCost: '', amount: '', confidence: null, job_id: '', jobLabel: '', cost_type: 'MATERIALS' };
}

/** AI confidence on an extracted field: the kit meter + number (0–100). */
function ConfBadge({ score }: { score: number | null }) {
  if (score === null) return null;
  return <Conf score={Math.round(score * 100)} label={`AI confidence ${Math.round(score * 100)} of 100`} />;
}

function useOutsideClose(open: boolean, setOpen: (v: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, setOpen]);
  return ref;
}

// ─── Account Picker ─────────────────────────────────────────

function AccountPicker({ value, label, onChange, locationId }: {
  value: string; label: string;
  onChange: (id: string, label: string) => void;
  locationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const ref = useOutsideClose(open, setOpen);

  useEffect(() => { const t = setTimeout(() => setDebounced(search), 200); return () => clearTimeout(t); }, [search]);

  const params: Record<string, string> = {};
  if (debounced.length >= 1) params.q = debounced;
  if (locationId) params.location_id = locationId;

  // /api/accounts/search answers `{ recent, accounts }` (raw body — api.get does not unwrap).
  // Reading `data.data` (never sent) left this picker empty; read the real shape.
  const { data, isLoading } = useQuery<{ recent?: AccountOption[]; accounts?: AccountOption[] }>(open ? '/api/accounts/search' : null, Object.keys(params).length > 0 ? params : undefined);
  const accounts = [...(data?.recent ?? []), ...(data?.accounts ?? [])].filter((a) => !a.is_control_account);

  return (
    <div ref={ref} className={s.picker}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={s.pickerBtn}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label ? `GL account: ${label}` : 'Choose a GL account'}
      >
        <span className={value ? undefined : s.pickerEmpty}>{label || 'Choose account'}</span>
        <span className={s.pickerChevron} aria-hidden="true"><Icon name="down" /></span>
      </button>
      {open && (
        <div className={cx('popover', s.pickerPop)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
          <div className="popover-head">
            <Icon name="search" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search accounts" aria-label="Search accounts" autoFocus />
          </div>
          <ul className={cx('popover-list', s.pickerList)} role="listbox" aria-label="GL accounts">
            {isLoading && accounts.length === 0 ? (
              <li className={cx('t-cap', s.pickerMsg)}>Searching…</li>
            ) : accounts.length === 0 ? (
              <li className={cx('t-cap', s.pickerMsg)}>{debounced ? 'No account matches.' : 'Type to search.'}</li>
            ) : accounts.slice(0, 20).map((a) => (
              <li key={a.id} role="option" aria-selected={a.id === value}>
                <button
                  type="button"
                  className={cx('popover-item', s.pickerItem)}
                  onClick={() => { onChange(a.id, `${a.account_number} · ${a.name}`); setOpen(false); setSearch(''); }}
                >
                  <span className={s.pickerNum}>{a.account_number}</span>
                  <span className="mb-trunc">{a.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Job Picker ─────────────────────────────────────────────

function JobPicker({ value, label, onChange, locationId }: {
  value: string; label: string;
  onChange: (id: string, label: string) => void;
  locationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const ref = useOutsideClose(open, setOpen);

  useEffect(() => { const t = setTimeout(() => setDebounced(search), 200); return () => clearTimeout(t); }, [search]);

  const params: Record<string, string> = {};
  if (locationId) params.location_id = locationId;
  if (debounced.length >= 1) params.q = debounced;

  const { data, isLoading } = useQuery<JobSearchResult[]>(open && locationId ? '/api/jobs/search' : null, Object.keys(params).length > 0 ? params : undefined);
  const jobs = data ?? [];

  return (
    <div ref={ref} className={s.picker}>
      <button
        type="button"
        onClick={() => locationId && setOpen(!open)}
        disabled={!locationId}
        className={s.pickerBtn}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label ? `Job: ${label}` : 'Choose a job'}
        style={value ? { paddingRight: 56 } : undefined}
      >
        <span className={value ? undefined : s.pickerEmpty}>{label || (locationId ? 'No job' : 'Pick a company first')}</span>
        <span className={s.pickerChevron} aria-hidden="true"><Icon name="down" /></span>
      </button>
      {value && (
        <span className={s.pickerClear}>
          <Button variant="quiet" iconOnly icon="x" aria-label="Clear job" onClick={() => onChange('', '')} />
        </span>
      )}
      {open && (
        <div className={cx('popover', s.pickerPop)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
          <div className="popover-head">
            <Icon name="search" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search jobs" aria-label="Search jobs" autoFocus />
          </div>
          <ul className={cx('popover-list', s.pickerList)} role="listbox" aria-label="Jobs">
            <li role="option" aria-selected={!value}>
              <button type="button" className={cx('popover-item', s.pickerItem)} onClick={() => { onChange('', ''); setOpen(false); setSearch(''); }}>
                <span className="ink-2">No job (overhead)</span>
              </button>
            </li>
            {isLoading && jobs.length === 0 ? (
              <li className={cx('t-cap', s.pickerMsg)}>Searching…</li>
            ) : jobs.length === 0 ? (
              <li className={cx('t-cap', s.pickerMsg)}>{debounced ? 'No job matches.' : 'Type to search.'}</li>
            ) : jobs.map((j) => (
              <li key={j.id} role="option" aria-selected={j.id === value}>
                <button
                  type="button"
                  className={cx('popover-item', s.pickerItem)}
                  onClick={() => { onChange(j.id, `${j.job_number} · ${j.name}`); setOpen(false); setSearch(''); }}
                >
                  <span className={s.pickerNum}>{j.job_number}</span>
                  <span className="mb-trunc">{j.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Main Form ──────────────────────────────────────────────

export function BillForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [documentPreview, setDocumentPreview] = useState<string | null>(null);
  const [isAiParsed, setIsAiParsed] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [locationId, setLocationId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [vendorConfidence, setVendorConfidence] = useState<number | null>(null);
  const [billNumber, setBillNumber] = useState('');
  const [billNumberConf, setBillNumberConf] = useState<number | null>(null);
  const [billDate, setBillDate] = useState(new Date().toISOString().split('T')[0]);
  const [billDateConf, setBillDateConf] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState('');
  const [dueDateConf, setDueDateConf] = useState<number | null>(null);
  const [taxCents, setTaxCents] = useState(0);
  const [retainagePct, setRetainagePct] = useState(0);
  const [lines, setLines] = useState<BillLineState[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const { data: locData, isLoading: locLoading, error: locError } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const { data: vendorData, isLoading: vendorLoading, error: vendorError } = useQuery<{ data: VendorOption[] }>('/api/vendors?per_page=200');
  const vendors = vendorData?.data ?? [];

  const fileInputRef = useRef<HTMLInputElement>(null);

  const subtotalCents = useMemo(() =>
    lines.reduce((s, l) => s + dollarsToCents(parseFloat(l.amount) || 0), 0),
    [lines]
  );
  const retainageCents = useMemo(
    () => (retainagePct > 0 ? Math.round((subtotalCents * retainagePct) / 100) : 0),
    [subtotalCents, retainagePct],
  );
  const totalCents = subtotalCents + taxCents - retainageCents;

  useEffect(() => {
    if (vendorId && billDate && !isAiParsed) {
      const vendor = vendors.find((v) => v.id === vendorId);
      if (vendor) {
        const d = new Date(billDate);
        d.setDate(d.getDate() + vendor.payment_terms_days);
        setDueDate(d.toISOString().split('T')[0]);
      }
    }
  }, [vendorId, billDate, vendors, isAiParsed]);

  const updateLine = useCallback((key: string, field: keyof BillLineState, value: string) => {
    setLines((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const updated = { ...l, [field]: value };
      if (field === 'quantity' || field === 'unitCost') {
        const qty = parseFloat(field === 'quantity' ? value : l.quantity) || 0;
        const uc = parseFloat(field === 'unitCost' ? value : l.unitCost) || 0;
        updated.amount = (qty * uc).toFixed(2);
      }
      return updated;
    }));
  }, []);

  const handleFileUpload = useCallback(async (file: File) => {
    setUploading(true);
    setUploadError('');
    setDuplicateWarning('');

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => setDocumentPreview(e.target?.result as string);
      reader.readAsDataURL(file);
    } else {
      setDocumentPreview(null);
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/bills/parse', { method: 'POST', body: formData });
      const data: ParsedResponse | { error: string } = await res.json();
      if (!res.ok || 'error' in data) {
        setUploadError('error' in data ? data.error : 'Failed to parse document');
        setUploading(false);
        return;
      }
      const { parsed, vendor, suggestedAccount, duplicateWarning: dw } = data as ParsedResponse;
      setIsAiParsed(true);
      setVendorName(parsed.vendorName);
      setVendorConfidence(parsed.vendorNameConfidence);
      setBillNumber(parsed.billNumber ?? '');
      setBillNumberConf(parsed.billNumberConfidence);
      if (parsed.billDate) { setBillDate(parsed.billDate); setBillDateConf(parsed.billDateConfidence); }
      if (parsed.dueDate) { setDueDate(parsed.dueDate); setDueDateConf(parsed.dueDateConfidence); }
      setTaxCents(parsed.taxCents);
      if (vendor) { setVendorId(vendor.id); setVendorName(vendor.name); setVendorConfidence(vendor.confidence); }
      if (parsed.lines.length > 0) {
        setLines(parsed.lines.map((pl) => ({
          key: genKey(),
          description: pl.description,
          account_id: suggestedAccount?.id ?? '',
          accountLabel: suggestedAccount?.label ?? '',
          quantity: String(pl.quantity),
          unitCost: (pl.unitCostCents / 100).toFixed(2),
          amount: (pl.amountCents / 100).toFixed(2),
          confidence: pl.confidence,
          job_id: '',
          jobLabel: '',
          cost_type: 'MATERIALS',
        })));
      }
      if (dw) setDuplicateWarning(dw);
    } catch {
      setUploadError('Failed to upload file');
    }
    setUploading(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    setFormError('');
    setSuccessMsg('');
    if (!locationId) { setFormError('Select a company'); return; }
    if (!vendorId) { setFormError('Select or match a vendor'); return; }
    if (!billDate) { setFormError('Enter a bill date'); return; }
    if (!dueDate) { setFormError('Enter a due date'); return; }

    const validLines = lines.filter((l) => l.account_id && parseFloat(l.amount) > 0);
    if (validLines.length === 0) { setFormError('Add at least one line with an amount'); return; }

    setSubmitting(true);
    const payload = {
      location_id: locationId,
      vendor_id: vendorId,
      bill_number: billNumber || undefined,
      bill_date: billDate,
      due_date: dueDate,
      tax_cents: taxCents,
      retainage_pct: retainagePct,
      lines: validLines.map((l) => ({
        description: l.description || undefined,
        account_id: l.account_id,
        quantity: parseFloat(l.quantity) || 1,
        unit_cost_cents: dollarsToCents(parseFloat(l.unitCost) || 0),
        amount_cents: dollarsToCents(parseFloat(l.amount) || 0),
        job_id: l.job_id || undefined,
        cost_type: l.job_id ? l.cost_type : undefined,
      })),
    };

    try {
      const res = await fetch('/api/bills/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) {
        setFormError(result.error ?? 'Failed to create bill');
        setSubmitting(false);
        return;
      }
      const jobNote = result.committed_cost_lines > 0 ? ` · ${result.committed_cost_lines} job cost(s) committed` : '';
      setSuccessMsg(result.compliance_warning ? `Bill created (ON HOLD)${jobNote}` : `Bill created${jobNote}`);
      setTimeout(() => onSuccess(), 1400);
    } catch {
      setFormError('Network error');
    }
    setSubmitting(false);
  }, [locationId, vendorId, billNumber, billDate, dueDate, taxCents, retainagePct, lines, onSuccess]);

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !uploading) void handleFileUpload(f);
  };

  const cannotSubmit = submitting || !locationId || !vendorId || subtotalCents === 0;

  return (
    <section className={s.form} aria-label="New bill">
      <div className={s.formHead}>
        <div className="row">
          <h2 className="t-section">New bill</h2>
          {isAiParsed && <Tag tone="ai">Read by AI</Tag>}
        </div>
        <Button variant="quiet" iconOnly icon="x" aria-label="Close the new bill form" onClick={onClose} />
      </div>

      <div className={s.formBody}>
        {documentPreview && (
          <div className={s.preview}>
            <span className="eyebrow">Original document</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={documentPreview} alt="The uploaded vendor invoice" />
          </div>
        )}

        <div className={s.formMain}>
          {!isAiParsed && (
            <>
              <input ref={fileInputRef} type="file" className="sr" tabIndex={-1} aria-hidden="true" accept=".pdf,.jpg,.jpeg,.png,.webp"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); }} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                aria-busy={uploading || undefined}
                className={cx(s.drop, dragOver && s.dropOver)}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
              >
                {uploading ? (
                  <>
                    <span className="t-head" role="status">Reading the invoice…</span>
                    <span className="t-cap">Pulling out the vendor, amounts, line items and dates.</span>
                  </>
                ) : (
                  <>
                    <span className={s.dropIcon} aria-hidden="true"><Icon name="upload" /><Icon name="camera" /><Icon name="file-text" /></span>
                    <span className="t-head">Drop an invoice, or click to upload</span>
                    <span className="t-cap">PDF, JPEG, PNG or WebP. AI fills in every field for you to check.</span>
                  </>
                )}
              </button>
            </>
          )}

          {uploadError && (
            <InlineNotice tone="neg" title="Couldn't read that file.">{uploadError}</InlineNotice>
          )}
          {duplicateWarning && (
            <InlineNotice tone="warn" title="Possible duplicate.">{duplicateWarning}</InlineNotice>
          )}

          {!isAiParsed && !uploading && (
            <div className={cx('t-cap', s.or)}>or enter it by hand</div>
          )}

          {/* match-before-create */}
          <div className={s.grid4}>
            <Field label="Company" error={locError ? "Couldn't load companies — reopen the form to retry." : undefined}>
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">{locLoading ? 'Loading companies…' : 'Select…'}</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.short_code} · {l.name}</option>)}
              </Select>
            </Field>
            <Field
              label={<span className={s.labelRow}>Vendor <ConfBadge score={vendorConfidence} /></span>}
              error={vendorError ? "Couldn't load vendors — reopen the form to retry." : undefined}
            >
              <Select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setVendorConfidence(null); }}>
                <option value="">{vendorName && !vendorId ? `"${vendorName}" (no match)` : vendorLoading ? 'Loading vendors…' : 'Select vendor…'}</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.display_name ?? v.name}</option>)}
              </Select>
            </Field>
            <Field label={<span className={s.labelRow}>Bill # <ConfBadge score={billNumberConf} /></span>}>
              <Input type="text" className="tnum" value={billNumber} onChange={(e) => { setBillNumber(e.target.value); setBillNumberConf(null); }}
                placeholder="INV-001" />
            </Field>
            <Field label="Tax">
              <span className={s.money}>
                <span aria-hidden="true">$</span>
                <Input type="number" value={taxCents / 100} onChange={(e) => setTaxCents(Math.round(parseFloat(e.target.value || '0') * 100))}
                  step="0.01" min="0" />
              </span>
            </Field>
          </div>

          <div className={s.grid3}>
            <Field label={<span className={s.labelRow}>Bill date <ConfBadge score={billDateConf} /></span>}>
              <Input type="date" className="tnum" value={billDate} onChange={(e) => { setBillDate(e.target.value); setBillDateConf(null); }} />
            </Field>
            <Field
              label={<span className={s.labelRow}>Due date <ConfBadge score={dueDateConf} /></span>}
              help={!isAiParsed && vendorId ? "Set from the vendor's payment terms; change it if this bill differs." : undefined}
            >
              <Input type="date" className="tnum" value={dueDate} onChange={(e) => { setDueDate(e.target.value); setDueDateConf(null); }} />
            </Field>
            <Field label="Retainage %">
              <span className={s.pct}>
                <Input type="number" value={retainagePct || ''} onChange={(e) => setRetainagePct(Math.min(100, Math.max(0, parseFloat(e.target.value || '0'))))}
                  step="0.5" min="0" max="100" placeholder="0" />
                <span aria-hidden="true">%</span>
              </span>
            </Field>
          </div>

          {/* Line items */}
          <div className={s.lines}>
            <table className="tbl" aria-label="Bill lines">
              <colgroup>
                <col style={{ width: 64 }} />
                <col />
                <col style={{ width: 200 }} />
                <col style={{ width: 180 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 48 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Description</th>
                  <th scope="col">GL account</th>
                  <th scope="col">Job</th>
                  <th scope="col" className="n">Amount</th>
                  <th scope="col"><span className="sr">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={line.key}>
                    <td>
                      <span className={cx('tnum', s.lineNo)}>
                        {idx + 1}
                        {line.confidence !== null && <ConfBadge score={line.confidence} />}
                      </span>
                    </td>
                    <td>
                      <Input type="text" aria-label={`Line ${idx + 1} description`} value={line.description} onChange={(e) => updateLine(line.key, 'description', e.target.value)}
                        placeholder="Line description" />
                      <div className={s.qtyRow}>
                        <Input type="number" aria-label={`Line ${idx + 1} quantity`} className={s.qty} value={line.quantity} onChange={(e) => updateLine(line.key, 'quantity', e.target.value)}
                          min="0" step="1" title="Quantity" />
                        <span className="ink-3" aria-hidden="true">×</span>
                        <span className={s.money}>
                          <span aria-hidden="true">$</span>
                          <Input type="text" inputMode="decimal" aria-label={`Line ${idx + 1} unit cost`} value={line.unitCost} onChange={(e) => updateLine(line.key, 'unitCost', e.target.value.replace(/[^0-9.]/g, ''))}
                            placeholder="0.00" title="Unit cost" />
                        </span>
                      </div>
                    </td>
                    <td>
                      <AccountPicker value={line.account_id} label={line.accountLabel}
                        onChange={(id, lbl) => setLines((prev) => prev.map((l) => l.key === line.key ? { ...l, account_id: id, accountLabel: lbl } : l))}
                        locationId={locationId} />
                    </td>
                    <td>
                      <JobPicker value={line.job_id} label={line.jobLabel}
                        onChange={(id, lbl) => setLines((prev) => prev.map((l) => l.key === line.key ? { ...l, job_id: id, jobLabel: lbl } : l))}
                        locationId={locationId} />
                      {line.job_id && (
                        <Select aria-label={`Line ${idx + 1} cost type`} value={line.cost_type} onChange={(e) => updateLine(line.key, 'cost_type', e.target.value)}
                          style={{ marginTop: 6 }}>
                          <option value="MATERIALS">Materials</option>
                          <option value="SUBCONTRACTOR">Subcontractor</option>
                          <option value="EQUIPMENT">Equipment</option>
                          <option value="OTHER">Other</option>
                        </Select>
                      )}
                    </td>
                    <td>
                      <span className={s.money}>
                        <span aria-hidden="true">$</span>
                        <Input type="text" inputMode="decimal" aria-label={`Line ${idx + 1} amount`} value={line.amount} onChange={(e) => updateLine(line.key, 'amount', e.target.value.replace(/[^0-9.]/g, ''))}
                          placeholder="0.00" />
                      </span>
                    </td>
                    <td>
                      <Button
                        variant="quiet"
                        iconOnly
                        icon="x"
                        aria-label={`Remove line ${idx + 1}`}
                        onClick={() => lines.length > 1 && setLines((p) => p.filter((l) => l.key !== line.key))}
                        disabled={lines.length <= 1}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={s.subRow}>
                  <td colSpan={3}>
                    <Button variant="quiet" icon="plus" onClick={() => setLines((p) => [...p, emptyLine()])}>
                      Add line
                    </Button>
                  </td>
                  <td className="n ink-2">Subtotal</td>
                  <td className="n">{formatMoney(subtotalCents)}</td>
                  <td />
                </tr>
                {taxCents > 0 && (
                  <tr>
                    <td colSpan={4} className="n ink-2">Tax</td>
                    <td className="n">{formatMoney(taxCents)}</td>
                    <td />
                  </tr>
                )}
                {retainageCents > 0 && (
                  <tr>
                    <td colSpan={4} className="n ink-2">Retainage withheld ({retainagePct}%)</td>
                    <td className="n">−{formatMoney(retainageCents)}</td>
                    <td />
                  </tr>
                )}
                <tr className={s.totalRow}>
                  <td colSpan={4} className="n">{retainageCents > 0 ? 'Due now' : 'Total'}</td>
                  <td className="n">{formatMoney(totalCents)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {formError && (
            <InlineNotice tone="neg" title="Not saved.">{formError}</InlineNotice>
          )}
          {successMsg && (
            <InlineNotice icon={<Tag tone="pos">Done</Tag>} title={`${successMsg}.`}>Back to the list in a moment.</InlineNotice>
          )}

          <div className={s.formFoot}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={handleSubmit} disabled={cannotSubmit} aria-busy={submitting || undefined}>
              {submitting ? 'Saving…' : 'Create bill'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
