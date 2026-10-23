'use client';

import { useState } from 'react';
import { Button, Check, ConfirmDialog, Dialog, Field, InlineNotice, Input, Select, Switch, Tag, api, money, toast, useQuery } from '@meritbooks/merit-ui';
import { VENDOR_TYPE_OPTIONS, centsToInput, dollarsToCentsInput, vendorTypeLabel, type ActionResponse, type RequirementSet, type RequirementsResponse } from './vc-types';
import s from './vendor-compliance.module.css';

interface Draft {
  id: string | null;
  name: string;
  location_id: string;
  vendor_type: string;
  tax_1099: 'any' | 'eligible' | 'not_eligible';
  work_type: string;
  w9_required: boolean;
  coi_required: boolean;
  gl_occ: string;
  gl_agg: string;
  auto: string;
  wc_required: boolean;
  wc_el: string;
  umbrella: string;
  require_additional_insured: boolean;
  require_waiver_of_subrogation: boolean;
  certificate_holder_name: string;
  expiry_lead_days: string;
  block_payment: boolean;
  grace_days: string;
}

const BLANK: Draft = {
  id: null,
  name: '',
  location_id: '',
  vendor_type: 'subcontractor',
  tax_1099: 'any',
  work_type: '',
  w9_required: true,
  coi_required: true,
  gl_occ: '1000000',
  gl_agg: '2000000',
  auto: '',
  wc_required: true,
  wc_el: '500000',
  umbrella: '',
  require_additional_insured: true,
  require_waiver_of_subrogation: false,
  certificate_holder_name: '',
  expiry_lead_days: '30',
  block_payment: true,
  grace_days: '0',
};

function fromSet(x: RequirementSet): Draft {
  return {
    id: x.id,
    name: x.name,
    location_id: x.locationId ?? '',
    vendor_type: x.vendorType ?? '',
    tax_1099: x.tax1099,
    work_type: x.workType ?? '',
    w9_required: x.w9Required,
    coi_required: x.coiRequired,
    gl_occ: centsToInput(x.minGlEachOccurrenceCents),
    gl_agg: centsToInput(x.minGlAggregateCents),
    auto: centsToInput(x.minAutoCents),
    wc_required: x.wcRequired,
    wc_el: centsToInput(x.minWcEachAccidentCents),
    umbrella: centsToInput(x.minUmbrellaCents),
    require_additional_insured: x.requireAdditionalInsured,
    require_waiver_of_subrogation: x.requireWaiverOfSubrogation,
    certificate_holder_name: x.certificateHolderNames[0] ?? '',
    expiry_lead_days: String(x.expiryLeadDays),
    block_payment: x.blockPayment,
    grace_days: String(x.graceDays),
  };
}

function summary(x: RequirementSet): string {
  const parts: string[] = [];
  if (x.w9Required) parts.push('W-9');
  const gl = [x.minGlEachOccurrenceCents !== null ? `${money(x.minGlEachOccurrenceCents, { decimals: 0, symbol: '$' })} occ.` : null, x.minGlAggregateCents !== null ? `${money(x.minGlAggregateCents, { decimals: 0, symbol: '$' })} agg.` : null].filter(Boolean);
  if (x.coiRequired || gl.length) parts.push(`GL${gl.length ? ` ${gl.join(' / ')}` : ''}`);
  if (x.minAutoCents !== null) parts.push(`Auto ${money(x.minAutoCents, { decimals: 0, symbol: '$' })}`);
  if (x.wcRequired) parts.push(`WC${x.minWcEachAccidentCents !== null ? ` EL ${money(x.minWcEachAccidentCents, { decimals: 0, symbol: '$' })}` : ''}`);
  if (x.minUmbrellaCents !== null) parts.push(`Umbrella ${money(x.minUmbrellaCents, { decimals: 0, symbol: '$' })}`);
  if (x.requireAdditionalInsured) parts.push('Additional insured');
  if (x.requireWaiverOfSubrogation) parts.push('Waiver of subrogation');
  if (x.certificateHolderNames.length) parts.push(`Holder “${x.certificateHolderNames[0]}”`);
  return parts.join(' · ');
}

export function RequirementsTab() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error, isLoading, refetch } = useQuery<RequirementsResponse>('/api/vendor-compliance/requirements', undefined, { key: String(refreshKey), scope: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [retire, setRetire] = useState<RequirementSet | null>(null);
  const companyName = (id: string | null) => (id ? data?.companies.find((c) => c.id === id)?.name ?? 'One company' : 'Every company');

  const sets = data?.sets ?? [];
  return (
    <div>
      <div className={s.toolbar}>
        <p className="t-cap">What each kind of vendor owes. The most specific set wins: a company’s own set beats the firm-wide one; a vendor-type set beats “any vendor”. One certificate serves every company it satisfies.</p>
        <div className={s.grow} />
        <Button variant="primary" icon="plus" onClick={() => setDraft({ ...BLANK })}>
          New requirement set
        </Button>
      </div>

      {error ? (
        <div className={s.state} role="alert">
          <p className="t-head">Couldn’t load requirement sets.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : isLoading && !data ? (
        <div className={s.state} role="status">
          <p className="t-cap">Loading requirement sets…</p>
        </div>
      ) : sets.length === 0 ? (
        <div className={s.state}>
          <p className="t-head">No requirement sets yet.</p>
          <p className="ink-2">Start with subcontractors: W-9, general liability $1,000,000 / $2,000,000, workers’ comp, the company as additional insured and certificate holder. Payments wait until a person accepts a certificate that meets it.</p>
          <Button variant="primary" icon="plus" onClick={() => setDraft({ ...BLANK, name: 'Subcontractors' })} style={{ marginTop: 12 }}>
            Create the subcontractor set
          </Button>
        </div>
      ) : (
        <div className="panel" style={{ padding: '0 16px' }}>
          {sets.map((x) => (
            <div key={x.id} className={s.setRow}>
              <div>
                <div className="t-head">{x.name}</div>
                <div className="t-cap">
                  {companyName(x.locationId)} · {x.vendorType ? vendorTypeLabel(x.vendorType) : 'Any vendor type'}
                  {x.tax1099 !== 'any' ? ` · ${x.tax1099 === 'eligible' ? '1099 vendors' : 'Non-1099 vendors'}` : ''}
                  {x.workType ? ` · ${x.workType}` : ''}
                </div>
                <div className="ink-2" style={{ marginTop: 4 }}>{summary(x) || 'Nothing required'}</div>
                <div className="t-cap" style={{ marginTop: 4 }}>
                  {x.blockPayment ? <Tag tone="neg">Blocks payment</Tag> : <Tag>Warn only</Tag>} Renewal asked <span className="tnum">{x.expiryLeadDays}</span> days ahead
                  {x.graceDays > 0 ? <> · <span className="tnum">{x.graceDays}</span>-day grace after expiry</> : null}
                </div>
              </div>
              <div className={s.actions}>
                <Button onClick={() => setDraft(fromSet(x))}>Edit</Button>
                <Button variant="quiet" onClick={() => setRetire(x)}>
                  Retire
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && data && (
        <RequirementDialog
          draft={draft}
          companies={data.companies}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      <ConfirmDialog
        open={!!retire}
        onClose={() => setRetire(null)}
        title={`Retire “${retire?.name ?? ''}”?`}
        confirmLabel="Retire set"
        tone="danger"
        onConfirm={async () => {
          if (!retire) return;
          const res = await api.post<ActionResponse>('/api/vendor-compliance/requirements', { action: 'retire', id: retire.id });
          setRetire(null);
          if (res.error) {
            toast.error(res.error.error);
            return;
          }
          toast(res.data?.message ?? 'Retired.');
          setRefreshKey((k) => k + 1);
        }}
      >
        Vendors it governed fall back to the next most specific set (or to the documents tracked on them). Their holds are recomputed at the next payment.
      </ConfirmDialog>
    </div>
  );
}

function RequirementDialog({ draft, companies, onClose, onSaved }: { draft: Draft; companies: Array<{ id: string; name: string }>; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  const save = async () => {
    setErr(null);
    const cents: Record<string, number | null> = {};
    for (const [k, v] of [['gl_occ', d.gl_occ], ['gl_agg', d.gl_agg], ['auto', d.auto], ['wc_el', d.wc_el], ['umbrella', d.umbrella]] as const) {
      const c = dollarsToCentsInput(v);
      if (Number.isNaN(c)) return setErr('Limits are dollar amounts like 1000000 or 1,000,000.');
      cents[k] = c;
    }
    const lead = Number(d.expiry_lead_days);
    const grace = Number(d.grace_days);
    if (!Number.isInteger(lead) || lead < 0 || lead > 180) return setErr('Ask for renewals 0 to 180 days ahead.');
    if (!Number.isInteger(grace) || grace < 0 || grace > 90) return setErr('Grace is 0 to 90 days.');
    if (!d.name.trim()) return setErr('Name the set.');
    setBusy(true);
    const res = await api.post<ActionResponse>('/api/vendor-compliance/requirements', {
      action: 'save',
      id: d.id,
      name: d.name.trim(),
      location_id: d.location_id || null,
      vendor_type: d.vendor_type || null,
      tax_1099: d.tax_1099,
      work_type: d.work_type.trim() || null,
      w9_required: d.w9_required,
      coi_required: d.coi_required,
      min_gl_each_occurrence_cents: d.coi_required ? cents.gl_occ : null,
      min_gl_aggregate_cents: d.coi_required ? cents.gl_agg : null,
      min_auto_cents: d.coi_required ? cents.auto : null,
      wc_required: d.coi_required && d.wc_required,
      min_wc_each_accident_cents: d.coi_required && d.wc_required ? cents.wc_el : null,
      min_umbrella_cents: d.coi_required ? cents.umbrella : null,
      require_additional_insured: d.coi_required && d.require_additional_insured,
      require_waiver_of_subrogation: d.coi_required && d.require_waiver_of_subrogation,
      certificate_holder_name: d.coi_required ? d.certificate_holder_name.trim() || null : null,
      expiry_lead_days: lead,
      block_payment: d.block_payment,
      grace_days: grace,
    });
    setBusy(false);
    if (res.error) return setErr(res.error.error);
    toast(res.data?.message ?? 'Saved.');
    onSaved();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={640}
      dismissOnScrim={false}
      title={d.id ? 'Edit requirement set' : 'New requirement set'}
      actions={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save set'}
          </Button>
        </>
      }
      footNote="Limits are compared in whole cents against what is on the certificate. Changes apply to the next payment and the next chase run."
    >
      <div className={s.formGrid}>
        <Field label="Name"><Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Subcontractors on site" /></Field>
        <div className={s.threeCol}>
          <Field label="Company">
            <Select value={d.location_id} onChange={(e) => set({ location_id: e.target.value })}>
              <option value="">Every company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Vendor type">
            <Select value={d.vendor_type} onChange={(e) => set({ vendor_type: e.target.value })}>
              <option value="">Any vendor type</option>
              {VENDOR_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </Field>
          <Field label="1099 status">
            <Select value={d.tax_1099} onChange={(e) => set({ tax_1099: e.target.value as Draft['tax_1099'] })}>
              <option value="any">Any</option>
              <option value="eligible">1099 vendors only</option>
              <option value="not_eligible">Non-1099 vendors only</option>
            </Select>
          </Field>
        </div>
        <Field label="Work type (optional)" help="Only vendors tagged with this work type, e.g. roofing."><Input value={d.work_type} onChange={(e) => set({ work_type: e.target.value.toLowerCase() })} /></Field>

        <Check label="Form W-9 required" checked={d.w9_required} onChange={(e) => set({ w9_required: e.target.checked })} />
        <Check label="Certificate of insurance required" checked={d.coi_required} onChange={(e) => set({ coi_required: e.target.checked })} />

        {d.coi_required && (
          <>
            <div className={s.twoCol}>
              <Field label="General liability, each occurrence $"><Input inputMode="decimal" className="tnum" value={d.gl_occ} onChange={(e) => set({ gl_occ: e.target.value })} /></Field>
              <Field label="General liability, aggregate $"><Input inputMode="decimal" className="tnum" value={d.gl_agg} onChange={(e) => set({ gl_agg: e.target.value })} /></Field>
              <Field label="Auto liability (blank = not required) $"><Input inputMode="decimal" className="tnum" value={d.auto} onChange={(e) => set({ auto: e.target.value })} /></Field>
              <Field label="Umbrella (blank = not required) $"><Input inputMode="decimal" className="tnum" value={d.umbrella} onChange={(e) => set({ umbrella: e.target.value })} /></Field>
            </div>
            <Check label="Workers’ comp required (or a state exemption)" checked={d.wc_required} onChange={(e) => set({ wc_required: e.target.checked })} />
            {d.wc_required && <Field label="Employer’s liability, each accident $"><Input inputMode="decimal" className="tnum" value={d.wc_el} onChange={(e) => set({ wc_el: e.target.value })} /></Field>}
            <Check label="Certificate holder must be additional insured" checked={d.require_additional_insured} onChange={(e) => set({ require_additional_insured: e.target.checked })} />
            <Check label="Waiver of subrogation required" checked={d.require_waiver_of_subrogation} onChange={(e) => set({ require_waiver_of_subrogation: e.target.checked })} />
            <Field label="Certificate holder must read" help="Legal name as it should appear (punctuation and LLC/Inc are ignored when comparing)."><Input value={d.certificate_holder_name} onChange={(e) => set({ certificate_holder_name: e.target.value })} placeholder="Artistry Homes LLC" /></Field>
          </>
        )}

        <div className={s.twoCol}>
          <Field label="Ask for renewals this many days before expiry"><Input inputMode="numeric" className="tnum" value={d.expiry_lead_days} onChange={(e) => set({ expiry_lead_days: e.target.value })} /></Field>
          <Field label="Grace days after expiry before the hold"><Input inputMode="numeric" className="tnum" value={d.grace_days} onChange={(e) => set({ grace_days: e.target.value })} /></Field>
        </div>
        <Switch label="Block payment while anything is missing" checked={d.block_payment} onChange={(e) => set({ block_payment: e.target.checked })} />
        {!d.block_payment && <InlineNotice tone="warn" title="Warn only.">Gaps show on the dashboard and are chased, but payments are not held.</InlineNotice>}
        {err && <InlineNotice tone="neg" title="Can’t save yet.">{err}</InlineNotice>}
      </div>
    </Dialog>
  );
}
