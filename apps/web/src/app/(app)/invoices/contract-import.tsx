'use client';

/**
 * Import from contract / SOW — DROP-AND-PARSE invoice + rev-rec setup.
 *
 * Drop a signed customer contract or SOW; the AI (via the metered Core AI gateway)
 * extracts the billing terms and this panel walks the user through a review →
 * confirm flow. Nothing is written until confirm. On confirm it creates the
 * invoice(s) through the EXISTING gated create paths — `POST /api/invoices`
 * (one per one-time bill or per milestone; post_to_gl defaults false → DRAFT) or
 * `POST /api/recurring-invoices` (the existing recurring template path) — and, when
 * the customer is new, `POST /api/customers`. Manual invoice creation stays the
 * fallback; this is an additive lane.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoney } from '@meritbooks/shared';
import { Button, Dialog, Field, Icon, InlineNotice, Input, MoneyInput, Select, Tag, cx } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks/use-query';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { acceptDocumentProposal, openDocument, type ProposalWithDoc } from '@/components/documents/intelligence-client';
import s from './invoices.module.css';

// ─── Types (mirror /api/invoices/parse-contract) ──────────────────────────────

type BillingKind = 'ONE_TIME' | 'MILESTONE' | 'RECURRING';
type RecurringFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
type RevRecMethod =
  | 'POINT_OF_SALE' | 'AS_BILLED' | 'PCT_COSTS_INCURRED' | 'PCT_COMPLETE'
  | 'COMPLETED_CONTRACT' | 'MILESTONE' | 'RATABLY' | 'SUBSCRIPTION' | 'CASH';

interface LineItem { description: string; quantity: number; unit_price_cents: number; amount_cents: number }
interface Milestone { name: string; description: string | null; due_date: string | null; amount_cents: number }
interface Recurring {
  cadence: RecurringFrequency; interval_count: number; amount_cents: number;
  start_date: string | null; end_date: string | null; occurrences: number | null;
}
interface RevRec {
  method: RevRecMethod; timing: string; pattern: string; recognizesAtBilling: boolean;
  reasoning: string | null; confidence: number;
}
interface Contract {
  customer: { name: string | null; email: string | null; matchKey: string };
  contract_title: string | null;
  total_contract_value_cents: number | null;
  start_date: string | null;
  end_date: string | null;
  currency: string | null;
  billing_kind: BillingKind;
  line_items: LineItem[];
  milestones: Milestone[];
  recurring: Recurring | null;
  rev_rec: RevRec;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
  notes: string | null;
}
interface CustomerCandidate { id: string; name: string; email: string | null; payment_terms_days: number | null }
type CustomerMatch =
  | { type: 'MATCHED'; customer: CustomerCandidate }
  | { type: 'PROPOSED'; name: string | null; email: string | null; candidates: CustomerCandidate[] };
interface ParseResponse {
  contract: Contract;
  customerMatch: CustomerMatch;
  meta: { fileName: string; model: string; documentNote: string | null; extractionMs: number };
}

interface LocationOption { id: string; name: string; short_code: string }
interface AccountOption { id: string; account_number: string; name: string; account_type: string }

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const REV_REC_OPTIONS: { value: RevRecMethod; label: string }[] = [
  { value: 'POINT_OF_SALE', label: 'Point of sale (recognize at billing)' },
  { value: 'AS_BILLED', label: 'Billing-based / as billed (recognize at billing)' },
  { value: 'PCT_COSTS_INCURRED', label: 'Percent of costs incurred (cost-to-cost)' },
  { value: 'PCT_COMPLETE', label: 'Percent complete (physical)' },
  { value: 'COMPLETED_CONTRACT', label: 'Completed contract (defer to completion)' },
  { value: 'MILESTONE', label: 'Milestone / point-in-time' },
  { value: 'RATABLY', label: 'Straight-line / ratable' },
  { value: 'SUBSCRIPTION', label: 'Subscription (ratable)' },
  { value: 'CASH', label: 'Cash basis' },
];

const CADENCE_OPTIONS: RecurringFrequency[] = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'];

const NEW_CUSTOMER = '__NEW__';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function ContractImport({
  onClose,
  onCreated,
  fromProposal = null,
}: {
  onClose: () => void;
  onCreated: () => void;
  /** Document intelligence: a contract AI found in Documents — opens pre-filled; creating links the document. */
  fromProposal?: ProposalWithDoc | null;
}) {
  const [phase, setPhase] = useState<'upload' | 'parsing' | 'review' | 'confirming'>(fromProposal ? 'parsing' : 'upload');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ParseResponse['meta'] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Esc closes through the kit Dialog (focus-trapped, modal).

  // Editable review state (populated from the parse response).
  const [contract, setContract] = useState<Contract | null>(null);
  const [lowFields, setLowFields] = useState<string[]>([]);
  const [locationId, setLocationId] = useState('');
  const [customerId, setCustomerId] = useState(''); // existing id, or NEW_CUSTOMER
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerEmail, setNewCustomerEmail] = useState('');
  const [revenueAccountId, setRevenueAccountId] = useState('');
  const [revRecMethod, setRevRecMethod] = useState<RevRecMethod>('AS_BILLED');
  const [lines, setLines] = useState<LineItem[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [recurring, setRecurring] = useState<Recurring | null>(null);
  const [billingKind, setBillingKind] = useState<BillingKind>('ONE_TIME');

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const { data: custData } = useQuery<{ customers: CustomerCandidate[] }>('/api/customers?per_page=500');
  const customers = custData?.customers ?? [];
  const { data: acctData } = useQuery<{ recent: AccountOption[]; accounts: AccountOption[] }>('/api/accounts/search');
  const revenueAccounts = [...(acctData?.recent ?? []), ...(acctData?.accounts ?? [])]
    .filter((a) => a.account_type === 'REVENUE')
    .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i);

  const parse = useCallback(async (file: File) => {
    setError(null);
    if (!ALLOWED.includes(file.type)) { setError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('File too large. Maximum 10MB.'); return; }
    setPhase('parsing');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/invoices/parse-contract', { method: 'POST', body: formData });
      const body = (await res.json()) as ParseResponse | { error: string };
      if (!res.ok || 'error' in body) {
        setError('error' in body ? body.error : 'Failed to parse contract');
        setPhase('upload');
        return;
      }
      applyParse(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setPhase('upload');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Load a parse response (fresh upload or a stored document proposal) into the review form. */
  function applyParse(body: ParseResponse) {
      const c = body.contract;
      setMeta(body.meta);
      setContract(c);
      setLowFields(c.lowConfidenceFields ?? []);
      setBillingKind(c.billing_kind);
      setLines(c.line_items.length > 0 ? c.line_items : [{ description: c.contract_title ?? 'Contract charge', quantity: 1, unit_price_cents: c.total_contract_value_cents ?? 0, amount_cents: c.total_contract_value_cents ?? 0 }]);
      setMilestones(c.milestones);
      setRecurring(
        c.recurring ??
          (c.billing_kind === 'RECURRING'
            ? { cadence: 'MONTHLY', interval_count: 1, amount_cents: 0, start_date: c.start_date, end_date: c.end_date, occurrences: null }
            : null),
      );
      setRevRecMethod(c.rev_rec.method);
      // Customer default: matched → its id; else create-new prefilled with the parsed name.
      if (body.customerMatch.type === 'MATCHED') {
        setCustomerId(body.customerMatch.customer.id);
      } else {
        setCustomerId(NEW_CUSTOMER);
        setNewCustomerName(body.customerMatch.name ?? '');
        setNewCustomerEmail(body.customerMatch.email ?? '');
      }
      setPhase('review');
  }

  // Pre-fill from the stored CONTRACT_EXTRACT result once the customer list is in (to match the customer).
  const appliedProposal = useRef(false);
  useEffect(() => {
    if (!fromProposal || appliedProposal.current || !custData) return;
    appliedProposal.current = true;
    const payload = fromProposal.payload as Partial<ParseResponse>;
    if (fromProposal.location_id) setLocationId(fromProposal.location_id);
    if (!payload.contract) {
      setPhase('upload');
      setError('AI hasn’t read this contract yet — drop the file here to read it now.');
      return;
    }
    const key = payload.contract.customer.matchKey;
    const fold = (n: string) => n.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(llc|inc|corp|co|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const exact = key ? customers.filter((c) => fold(c.name) === key) : [];
    applyParse({
      ...(payload as ParseResponse),
      meta: { ...(payload.meta as ParseResponse['meta']), fileName: payload.meta?.fileName ?? fromProposal.document?.file_name ?? 'Document' },
      customerMatch: exact.length === 1
        ? { type: 'MATCHED', customer: exact[0] }
        : { type: 'PROPOSED', name: payload.contract.customer.name, email: payload.contract.customer.email, candidates: [] },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromProposal, custData]);

  /** Link the stored document to what the contract created. Never blocks the create. */
  async function linkFromDocument(targetType: string, id: string | null | undefined) {
    if (!fromProposal || !id) return;
    const err = await acceptDocumentProposal(fromProposal.id, targetType, id);
    if (err) addToast('error', `Created, but linking the document failed: ${err}`);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void parse(file);
  }

  /** Low-confidence fields get an ochre ring so the reviewer checks them first. */
  const flag = (field: string) => (lowFields.includes(field) ? s.lowConf : undefined);

  // Derived totals for the review summary.
  const oneTimeTotal = lines.reduce((s, l) => s + Math.round(l.quantity * l.unit_price_cents), 0);
  const milestoneTotal = milestones.reduce((s, m) => s + m.amount_cents, 0);

  // ── Line editing ─────────────────────────────────────────────────────────────
  const setLine = (i: number, patch: Partial<LineItem>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { description: '', quantity: 1, unit_price_cents: 0, amount_cents: 0 }]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls));

  const setMs = (i: number, patch: Partial<Milestone>) =>
    setMilestones((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const addMs = () => setMilestones((ms) => [...ms, { name: '', description: null, due_date: null, amount_cents: 0 }]);
  const removeMs = (i: number) => setMilestones((ms) => ms.filter((_, j) => j !== i));

  // ── Confirm ──────────────────────────────────────────────────────────────────
  async function confirm() {
    if (!contract) return;
    setError(null);

    if (!locationId) { addToast('error', 'Pick a company for the invoice.'); return; }
    if (!revenueAccountId) { addToast('error', 'Pick a revenue GL account.'); return; }
    if (customerId === NEW_CUSTOMER && !newCustomerName.trim()) { addToast('error', 'Enter a name for the new customer.'); return; }
    if (!customerId) { addToast('error', 'Pick or create a customer.'); return; }

    const methodLabel = REV_REC_OPTIONS.find((m) => m.value === revRecMethod)?.label ?? revRecMethod;
    const revRecNote = `Rev-rec: ${methodLabel}`;

    setPhase('confirming');
    try {
      // 1. Resolve the customer (create if new).
      let custId = customerId;
      let termsDays = 30;
      if (customerId === NEW_CUSTOMER) {
        const created = await api.post<{ customer: { id: string } }>('/api/customers', {
          name: newCustomerName.trim(),
          email: newCustomerEmail.trim() || undefined,
          location_id: locationId,
        });
        if (created.error || !created.data) {
          setError(created.error?.error ?? 'Failed to create customer');
          setPhase('review');
          return;
        }
        custId = created.data.customer.id;
      } else {
        termsDays = customers.find((c) => c.id === customerId)?.payment_terms_days ?? 30;
      }

      const baseMemo = contract.contract_title ? `${contract.contract_title} — ${revRecNote}` : revRecNote;

      if (billingKind === 'RECURRING') {
        if (!recurring || recurring.amount_cents <= 0) { setError('Recurring amount must be greater than zero.'); setPhase('review'); return; }
        const start = recurring.start_date ?? contract.start_date ?? todayISO();
        const r = await api.post<{ id: string }>('/api/recurring-invoices', {
          name: contract.contract_title ?? `${newCustomerNameOr(custId)} recurring`,
          location_id: locationId,
          customer_id: custId,
          frequency: recurring.cadence,
          interval_count: recurring.interval_count,
          start_date: start,
          end_date: recurring.end_date ?? undefined,
          occurrences: recurring.occurrences ?? undefined,
          auto_send: false,
          memo: baseMemo,
          tax_cents: 0,
          terms: termsDays,
          lines: [{ description: contract.contract_title ?? 'Recurring charge', account_id: revenueAccountId, quantity: 1, unit_price_cents: recurring.amount_cents }],
        });
        if (r.error) { setError(r.error.error); setPhase('review'); return; }
        await linkFromDocument('customer_contract', r.data?.id);
        addToast('success', 'Recurring billing schedule created from the contract.');
        onCreated();
        return;
      }

      if (billingKind === 'MILESTONE') {
        if (milestones.length === 0) { setError('Add at least one milestone.'); setPhase('review'); return; }
        let ok = 0;
        let failed = 0;
        for (const m of milestones) {
          const invDate = m.due_date ?? todayISO();
          const res = await api.post<{ invoice_id: string }>('/api/invoices', {
            location_id: locationId,
            customer_id: custId,
            invoice_date: invDate,
            due_date: addDays(invDate, termsDays),
            memo: `${m.name}${m.description ? ` — ${m.description}` : ''} · ${baseMemo}`,
            tax_cents: 0,
            lines: [{ description: m.name || 'Milestone', account_id: revenueAccountId, quantity: 1, unit_price_cents: m.amount_cents }],
          });
          if (res.error) failed += 1;
          else {
            ok += 1;
            if (ok === 1) await linkFromDocument('invoice', res.data?.invoice_id);
          }
        }
        if (failed > 0) { addToast('error', `${ok} invoice(s) created · ${failed} failed`); }
        else addToast('success', `${ok} milestone invoice${ok === 1 ? '' : 's'} created (draft).`);
        onCreated();
        return;
      }

      // ONE_TIME
      const invDate = contract.start_date ?? todayISO();
      const res = await api.post<{ invoice_id: string }>('/api/invoices', {
        location_id: locationId,
        customer_id: custId,
        invoice_date: invDate,
        due_date: addDays(invDate, termsDays),
        memo: baseMemo,
        tax_cents: 0,
        lines: lines.map((l) => ({
          description: l.description || 'Contract charge',
          account_id: revenueAccountId,
          quantity: l.quantity,
          unit_price_cents: l.unit_price_cents,
        })),
      });
      if (res.error) { setError(res.error.error); setPhase('review'); return; }
      await linkFromDocument('invoice', res.data?.invoice_id);
      addToast('success', 'Invoice created from the contract (draft).');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
      setPhase('review');
    }
  }

  function newCustomerNameOr(id: string): string {
    if (id === NEW_CUSTOMER || customerId === NEW_CUSTOMER) return newCustomerName || 'Customer';
    return customers.find((c) => c.id === id)?.name ?? 'Customer';
  }

  const busy = phase === 'confirming';
  const reviewing = (phase === 'review' || phase === 'confirming') && !!contract;
  const confirmLabel = billingKind === 'RECURRING'
    ? 'Create recurring schedule'
    : billingKind === 'MILESTONE'
      ? `Create ${milestones.length} milestone invoice${milestones.length === 1 ? '' : 's'}`
      : 'Create invoice';
  const aiMethod = contract ? REV_REC_OPTIONS.find((m) => m.value === contract.rev_rec.method)?.label.split(' (')[0] : null;

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title="Import from contract or SOW"
      width={900}
      className={s.tallDialog}
      dismissOnScrim={!busy}
      footNote={reviewing ? 'Created as drafts through the standard invoice and recurring paths — same numbering, rev-rec and validation as manual entry.' : 'Nothing is saved until you confirm.'}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          {reviewing && (
            <Button variant="primary" onClick={() => void confirm()} disabled={busy} aria-busy={busy || undefined}>
              {busy ? 'Creating…' : confirmLabel}
            </Button>
          )}
        </>
      }
    >
      <div className={s.form}>
        <p className="ink-2">
          Drop a signed customer contract. AI proposes the invoices and the rev-rec method; you review and confirm.
        </p>

        {error && <InlineNotice tone="neg" title="Couldn't continue.">{error}</InlineNotice>}

        {/* Upload / parsing */}
        {(phase === 'upload' || phase === 'parsing') && (
          <div
            role="button"
            tabIndex={phase === 'upload' ? 0 : -1}
            aria-label="Upload a contract or SOW"
            aria-busy={phase === 'parsing' || undefined}
            data-over={dragOver}
            data-busy={phase === 'parsing'}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => phase === 'upload' && fileInput.current?.click()}
            onKeyDown={(e) => {
              if (phase === 'upload' && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                fileInput.current?.click();
              }
            }}
            className={s.drop}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,image/*"
              className={s.hiddenInput}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }}
            />
            {phase === 'parsing' ? (
              <>
                <span className={cx('wg-loading', s.dropBar)} aria-hidden="true"><span className="bar-l" style={{ width: '100%' }} /></span>
                <span className="t-head" role="status">Reading the contract and pulling out the billing terms…</span>
                <span className="t-cap">This can take 15–30 seconds for a long agreement.</span>
              </>
            ) : (
              <>
                <span className="wg-empty-mark" aria-hidden="true">
                  <Icon name="upload" />
                </span>
                <span className="t-head">Drop a signed contract or SOW here</span>
                <span className="t-cap">or click to browse · PDF, PNG, JPEG · up to 10MB</span>
              </>
            )}
          </div>
        )}

        {fromProposal && (
          <p className="t-cap" data-testid="from-document">
            From document: <b className="ink">{fromProposal.document?.file_name ?? 'stored document'}</b>
            {' · '}
            <button type="button" className={s.linkBtn} onClick={() => { void openDocument(fromProposal.document_id).then((e) => { if (e) addToast('error', e); }); }}>
              Open the document
            </button>
          </p>
        )}

        {/* Review */}
        {reviewing && contract && (
          <>
            <div className={s.metaLine}>
              <span className="ink-2">{meta?.fileName}</span>
              <Tag>{billingKind.replace('_', ' ').toLowerCase()}</Tag>
            </div>
            {meta?.documentNote && <InlineNotice tone="info">{meta.documentNote}</InlineNotice>}

            {/* Customer + company */}
            <div className={s.grid2}>
              <div className={s.form}>
                <Field label="Customer" className={flag('customer')}>
                  <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                    <option value={NEW_CUSTOMER}>+ Create new{contract.customer.name ? ` — "${contract.customer.name}"` : ''}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </Select>
                </Field>
                {customerId === NEW_CUSTOMER && (
                  <div className={s.grid2}>
                    {/* match-before-create */}
                    <Field label="New customer name">
                      <Input placeholder="Customer name" value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} />
                    </Field>
                    <Field label="Billing email">
                      <Input type="email" placeholder="Optional" value={newCustomerEmail} onChange={(e) => setNewCustomerEmail(e.target.value)} />
                    </Field>
                  </div>
                )}
              </div>
              <Field label="Company *">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Select company</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* Revenue account + rev-rec method */}
            <div className={s.grid2}>
              <Field label="Revenue GL account *">
                <Select value={revenueAccountId} onChange={(e) => setRevenueAccountId(e.target.value)}>
                  <option value="">Select revenue account</option>
                  {revenueAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.account_number} · {a.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Rev-rec method" help={aiMethod ? `AI suggested: ${aiMethod}` : undefined} className={flag('rev_rec')}>
                <Select value={revRecMethod} onChange={(e) => setRevRecMethod(e.target.value as RevRecMethod)}>
                  {REV_REC_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </Select>
              </Field>
            </div>
            {contract.rev_rec.reasoning && (
              <InlineNotice tone="info" title="Why AI suggested this method">&ldquo;{contract.rev_rec.reasoning}&rdquo;</InlineNotice>
            )}

            {/* Schedule editor */}
            {billingKind === 'ONE_TIME' && (
              <div>
                <div className={s.linesHead}>
                  <span className="eyebrow">Lines</span>
                  <Button variant="quiet" icon="plus" onClick={addLine}>Add line</Button>
                </div>
                <div className={s.lineRows}>
                  <div className={cx(s.lineGrid, s.lineGridContract)} aria-hidden="true">
                    <span className="field-label">Description</span>
                    <span className={cx('field-label', s.num)}>Qty</span>
                    <span className={cx('field-label', s.num)}>Unit price</span>
                    <span />
                  </div>
                  {lines.map((l, i) => (
                    <div key={i} className={cx(s.lineGrid, s.lineGridContract)}>
                      <Input placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label={`Line ${i + 1} description`} />
                      <Input className={s.num} type="number" min={0} step={0.01} value={l.quantity} onChange={(e) => setLine(i, { quantity: parseFloat(e.target.value) || 0 })} aria-label={`Line ${i + 1} quantity`} />
                      <MoneyInput valueCents={l.unit_price_cents} onChangeCents={(c) => setLine(i, { unit_price_cents: c ?? 0 })} aria-label={`Line ${i + 1} unit price`} />
                      <Button variant="quiet" iconOnly icon="x" onClick={() => removeLine(i)} aria-label={`Remove line ${i + 1}`} />
                    </div>
                  ))}
                </div>
                <div className={s.totals}>
                  <div className={cx(s.totRow, s.totGrand)}><span>Total</span><span>{formatMoney(oneTimeTotal)}</span></div>
                </div>
              </div>
            )}

            {billingKind === 'MILESTONE' && (
              <div className={cx(flag('milestones') && s.lowConfBlock)}>
                <div className={s.linesHead}>
                  <span className="eyebrow">Milestones — one invoice each</span>
                  <Button variant="quiet" icon="plus" onClick={addMs}>Add milestone</Button>
                </div>
                <div className={s.lineRows}>
                  <div className={cx(s.lineGrid, s.lineGridMilestone)} aria-hidden="true">
                    <span className="field-label">Milestone</span>
                    <span className="field-label">Invoice date</span>
                    <span className={cx('field-label', s.num)}>Amount</span>
                    <span />
                  </div>
                  {milestones.map((m, i) => (
                    <div key={i} className={cx(s.lineGrid, s.lineGridMilestone)}>
                      <Input placeholder="Milestone name" value={m.name} onChange={(e) => setMs(i, { name: e.target.value })} aria-label={`Milestone ${i + 1} name`} />
                      <Input type="date" value={m.due_date ?? ''} onChange={(e) => setMs(i, { due_date: e.target.value || null })} aria-label={`Milestone ${i + 1} date`} />
                      <MoneyInput valueCents={m.amount_cents} onChangeCents={(c) => setMs(i, { amount_cents: c ?? 0 })} aria-label={`Milestone ${i + 1} amount`} />
                      <Button variant="quiet" iconOnly icon="x" onClick={() => removeMs(i)} aria-label={`Remove milestone ${i + 1}`} />
                    </div>
                  ))}
                </div>
                <div className={s.totals}>
                  <div className={cx(s.totRow, s.totGrand)}><span>Total</span><span>{formatMoney(milestoneTotal)}</span></div>
                </div>
              </div>
            )}

            {billingKind === 'RECURRING' && recurring && (
              <>
                <div className={s.grid4}>
                  <Field label="Cadence">
                    <Select value={recurring.cadence} onChange={(e) => setRecurring({ ...recurring, cadence: e.target.value as RecurringFrequency })}>
                      {CADENCE_OPTIONS.map((c) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}
                    </Select>
                  </Field>
                  <Field label="Every">
                    <Input className={s.num} type="number" min={1} value={recurring.interval_count} onChange={(e) => setRecurring({ ...recurring, interval_count: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                  </Field>
                  <Field label="Amount per period" className={flag('recurring_amount')}>
                    <MoneyInput valueCents={recurring.amount_cents} onChangeCents={(c) => setRecurring({ ...recurring, amount_cents: c ?? 0 })} />
                  </Field>
                  <Field label="Periods" help="Blank = no limit">
                    <Input className={s.num} type="number" min={1} placeholder="∞" value={recurring.occurrences ?? ''} onChange={(e) => setRecurring({ ...recurring, occurrences: e.target.value === '' ? null : Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                  </Field>
                </div>
                <div className={s.grid4}>
                  <Field label="Start" className={flag('start_date')}>
                    <Input type="date" value={recurring.start_date ?? ''} onChange={(e) => setRecurring({ ...recurring, start_date: e.target.value || null })} />
                  </Field>
                  <Field label="End" help="Optional">
                    <Input type="date" value={recurring.end_date ?? ''} onChange={(e) => setRecurring({ ...recurring, end_date: e.target.value || null })} />
                  </Field>
                </div>
              </>
            )}

            {lowFields.length > 0 && (
              <InlineNotice tone="warn" title={`Check the highlighted field${lowFields.length === 1 ? '' : 's'}.`}>
                The AI was unsure, or the contract didn&apos;t state the value.
              </InlineNotice>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
