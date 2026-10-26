'use client';

/**
 * Vendor document intake — DROP-AND-PARSE W-9 / COI review-and-confirm modal.
 *
 * Drop a W-9 or a Certificate of Insurance; the AI (via the metered Core gateway)
 * proposes the fields; the human reviews (low-confidence fields highlighted, TIN
 * masked) and confirms. Nothing persists until confirm — manual entry stays the
 * fallback. One cohesive component drives both document types.
 *
 * Presentation: a kit dialog (.scrim/.dialog) rendered in place — it opens from the
 * vendor drawer, so it stays inside the drawer's tree (focus, keys) instead of portalling.
 */

import { useCallback, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { centsToDollars, dollarsToCents } from '@meritbooks/shared';
import { Button, Check, Field, Icon, InlineNotice, Input, Select, Tag, useFocusTrap } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks/use-toast';
import s from './vendors.module.css';

type Mode = 'W9' | 'COI';

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// ── Proposal shapes (mirror the API) ──────────────────────────────────────────

const ENTITY_OPTIONS: { value: string; label: string }[] = [
  { value: 'INDIVIDUAL_SOLE_PROP', label: 'Individual / sole proprietor' },
  { value: 'C_CORP', label: 'C corporation' },
  { value: 'S_CORP', label: 'S corporation' },
  { value: 'PARTNERSHIP', label: 'Partnership' },
  { value: 'TRUST_ESTATE', label: 'Trust / estate' },
  { value: 'LLC', label: 'Limited liability company' },
  { value: 'OTHER', label: 'Other' },
];

interface W9Proposal {
  legal_name: string | null;
  business_name: string | null;
  entity_type: string;
  llc_tax_class: 'C' | 'S' | 'P' | null;
  tin_masked: string | null;
  tin_type: 'EIN' | 'SSN' | null;
  tin_last4: string | null;
  exempt_payee_code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  is_1099_eligible_signal: boolean | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}

interface Coverage {
  coverage_type: string;
  doc_type: 'GL_COI' | 'WC_COI' | null;
  each_occurrence_cents: number | null;
  aggregate_cents: number | null;
  effective_date: string | null;
  expiration_date: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}
interface CoiProposal {
  carrier: string | null;
  policy_number: string | null;
  named_insured: string | null;
  certificate_holder: string | null;
  additional_insured: boolean | null;
  coverages: Coverage[];
}

interface Meta {
  fileName: string;
  decisionId: string | null;
  documentNote: string | null;
}

const LOW_HELP = 'Check this — the AI was unsure or it wasn’t stated.';

export function VendorDocIntake({
  vendorId,
  vendorName,
  mode,
  onClose,
  onConfirmed,
}: {
  vendorId: string;
  vendorName: string;
  mode: Mode;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [phase, setPhase] = useState<'upload' | 'parsing' | 'review' | 'confirming'>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [w9, setW9] = useState<W9Proposal | null>(null);
  const [is1099, setIs1099] = useState(false);
  const [coi, setCoi] = useState<CoiProposal | null>(null);
  const [keep, setKeep] = useState<Record<number, boolean>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  // Escape closes the modal unless a parse/save is in flight. The key stops here, so the
  // vendor drawer underneath stays open.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (phase !== 'parsing' && phase !== 'confirming') onClose();
  };

  const endpoint = mode === 'W9' ? '/api/vendors/w9-parse' : '/api/vendors/coi-parse';
  const title = mode === 'W9' ? 'Upload W-9' : 'Upload certificate of insurance';

  const parse = useCallback(
    async (file: File) => {
      setError(null);
      if (!ALLOWED.includes(file.type)) {
        setError('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError('File too large. Maximum 10MB.');
        return;
      }
      setPhase('parsing');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('vendor_id', vendorId);
      try {
        const res = await fetch(endpoint, { method: 'POST', body: fd });
        const body = await res.json();
        if (!res.ok || body.error) {
          setError(body.error ?? 'Failed to parse document');
          setPhase('upload');
          return;
        }
        setMeta(body.meta);
        if (mode === 'W9') {
          const p = body.proposal as W9Proposal;
          setW9(p);
          setIs1099(p.is_1099_eligible_signal ?? false);
        } else {
          const c = body.coi as CoiProposal;
          setCoi(c);
          // Default: keep every persistable (GL/WC) coverage that has an expiration.
          const k: Record<number, boolean> = {};
          c.coverages.forEach((cov, i) => {
            k[i] = cov.doc_type !== null && !!cov.expiration_date;
          });
          setKeep(k);
        }
        setPhase('review');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
        setPhase('upload');
      }
    },
    [endpoint, mode, vendorId],
  );

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void parse(file);
  }

  const setW9Field = <K extends keyof W9Proposal>(k: K, v: W9Proposal[K]) =>
    setW9((p) => (p ? { ...p, [k]: v } : p));
  const setCoverage = (i: number, patch: Partial<Coverage>) =>
    setCoi((c) => (c ? { ...c, coverages: c.coverages.map((cov, idx) => (idx === i ? { ...cov, ...patch } : cov)) } : c));

  /** Low-confidence fields get the ochre ring + a help line (layout class, not colour alone). */
  const flag = (fields: string[], f: string) => (fields.includes(f) ? s.lowConf : '');
  const lowHelp = (fields: string[], f: string) => (fields.includes(f) ? LOW_HELP : undefined);

  async function confirmW9() {
    if (!w9) return;
    if (!w9.legal_name || !w9.legal_name.trim()) {
      addToast('error', 'A legal name is required before confirming.');
      return;
    }
    setPhase('confirming');
    const res = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor_id: vendorId,
        decision_id: meta?.decisionId ?? undefined,
        legal_name: w9.legal_name.trim(),
        business_name: w9.business_name?.trim() || null,
        address_line1: w9.address_line1?.trim() || null,
        address_line2: w9.address_line2?.trim() || null,
        city: w9.city?.trim() || null,
        state: w9.state?.trim() || null,
        zip: w9.zip?.trim() || null,
        is_1099_eligible: is1099,
        tin_last4: w9.tin_last4 || null,
        mark_w9_on_file: true,
      }),
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      addToast('error', body.error ?? 'Failed to save W-9');
      setPhase('review');
      return;
    }
    addToast('success', `W-9 recorded for ${vendorName}`);
    onConfirmed();
  }

  async function confirmCoi() {
    if (!coi) return;
    const docs = coi.coverages
      .map((cov, i) => ({ cov, i }))
      .filter(({ cov, i }) => keep[i] && cov.doc_type && cov.expiration_date)
      .map(({ cov }) => ({
        doc_type: cov.doc_type as 'GL_COI' | 'WC_COI',
        coverage_amount_cents: cov.each_occurrence_cents ?? cov.aggregate_cents ?? null,
        effective_date: cov.effective_date,
        expiration_date: cov.expiration_date as string,
      }));
    if (docs.length === 0) {
      addToast('error', 'Select at least one GL / WC coverage with an expiration date to record.');
      return;
    }
    setPhase('confirming');
    const res = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor_id: vendorId, decision_id: meta?.decisionId ?? undefined, docs }),
    });
    const body = await res.json();
    if (!res.ok || body.error) {
      addToast('error', body.error ?? 'Failed to save COI');
      setPhase('review');
      return;
    }
    addToast('success', `${body.recorded} coverage line(s) recorded for ${vendorName}`);
    onConfirmed();
  }

  const reviewing = phase === 'review' || phase === 'confirming';

  return (
    <div
      className={`scrim scrim--fixed ${s.intakeScrim}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className={`dialog ${s.intake}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-hotkeys="off"
        onKeyDown={onKeyDown}
      >
        <div className="dialog-head">
          <div className="row row--between" style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <h2 className="t-section">{title}</h2>
                <Tag tone="ai">AI reads it</Tag>
              </div>
              <p className="t-cap" style={{ marginTop: 4 }}>
                {vendorName} · Drop the document — the AI proposes the fields; you review and confirm. Nothing is saved until you confirm.
              </p>
            </div>
            <Button variant="quiet" iconOnly icon="x" aria-label="Close" onClick={onClose} />
          </div>
        </div>

        <div className="dialog-body" style={{ flex: 1 }}>
          {error && (
            <div style={{ marginBottom: 16 }}>
              <InlineNotice tone="neg" title="That didn’t work.">{error}</InlineNotice>
            </div>
          )}

          {/* Upload / parsing */}
          {(phase === 'upload' || phase === 'parsing') && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => phase === 'upload' && fileInput.current?.click()}
              onKeyDown={(e) => { if (phase === 'upload' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileInput.current?.click(); } }}
              role="button"
              tabIndex={phase === 'upload' ? 0 : -1}
              aria-label={mode === 'W9' ? 'Choose a Form W-9 to upload' : 'Choose a certificate of insurance to upload'}
              aria-busy={phase === 'parsing' || undefined}
              className={`${s.drop} ${phase === 'parsing' ? s.dropBusy : dragOver ? s.dropOver : ''}`}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,image/*"
                className={s.hiddenInput}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }}
              />
              {phase === 'parsing' ? (
                <div className="wg-loading" style={{ display: 'grid', gap: 10, width: 320, justifyItems: 'center' }}>
                  <span className="bar-l" style={{ width: '100%' }} aria-hidden="true" />
                  <span className="bar-l" style={{ width: '70%' }} aria-hidden="true" />
                  <span className="t-head" role="status">Reading the {mode === 'W9' ? 'W-9' : 'certificate'} and extracting fields…</span>
                  <span className="t-cap">This can take 10–20 seconds.</span>
                </div>
              ) : (
                <>
                  <span className="wg-empty-mark" aria-hidden="true"><Icon name="upload" /></span>
                  <span className="t-head">
                    Drop {mode === 'W9' ? 'a Form W-9' : 'a certificate of insurance'} here
                  </span>
                  <span className="t-cap">or click to browse · PDF, PNG, JPEG · up to 10MB</span>
                </>
              )}
            </div>
          )}

          {/* Review */}
          {reviewing && (
            <div className={s.stack}>
              <div className="row t-cap" style={{ gap: 6 }}>
                <Icon name="file-text" />
                <span className="mb-trunc" style={{ maxWidth: 360 }}>{meta?.fileName}</span>
              </div>
              {meta?.documentNote && <InlineNotice tone="info">{meta.documentNote}</InlineNotice>}

              {mode === 'W9' && w9 && (
                <div className={s.grid2}>
                  <Field label="Legal name (line 1)" help={lowHelp(w9.lowConfidenceFields, 'legal_name')} className={`${s.full} ${flag(w9.lowConfidenceFields, 'legal_name')}`}>
                    <Input value={w9.legal_name ?? ''} onChange={(e) => setW9Field('legal_name', e.target.value)} placeholder="As shown on the tax return" />
                  </Field>
                  <Field label="Business / DBA name (line 2)" className={s.full}>
                    <Input value={w9.business_name ?? ''} onChange={(e) => setW9Field('business_name', e.target.value || null)} placeholder="Optional" />
                  </Field>
                  <Field
                    label="Federal tax classification"
                    help={lowHelp(w9.lowConfidenceFields, 'entity_type') ?? 'Shown for review; not stored.'}
                    className={flag(w9.lowConfidenceFields, 'entity_type')}
                  >
                    <Select value={w9.entity_type} onChange={(e) => setW9Field('entity_type', e.target.value)}>
                      {ENTITY_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                    </Select>
                  </Field>
                  <div className="field">
                    <span className="field-label">TIN / EIN {w9.tin_type ? `(${w9.tin_type})` : ''}</span>
                    <div className={`${s.readout} ${flag(w9.lowConfidenceFields, 'tin')}`}>
                      <Icon name="lock" />
                      <span className="tnum">{w9.tin_masked ?? '— not read —'}</span>
                    </div>
                    <span className="field-help">{lowHelp(w9.lowConfidenceFields, 'tin') ?? 'Masked · not stored here (Core-owned encryption).'}</span>
                  </div>
                  <div className={`${s.full} field`}>
                    <span className="field-label">Address</span>
                    <Input aria-label="Street" value={w9.address_line1 ?? ''} onChange={(e) => setW9Field('address_line1', e.target.value || null)} placeholder="Street" />
                    <div className={s.grid3} style={{ marginTop: 8 }}>
                      <Input aria-label="City" value={w9.city ?? ''} onChange={(e) => setW9Field('city', e.target.value || null)} placeholder="City" />
                      <Input aria-label="State" value={w9.state ?? ''} onChange={(e) => setW9Field('state', e.target.value || null)} placeholder="State" maxLength={2} />
                      <Input aria-label="ZIP" value={w9.zip ?? ''} onChange={(e) => setW9Field('zip', e.target.value || null)} placeholder="ZIP" />
                    </div>
                  </div>
                  <div className={`${s.full} ${s.check1099} ${flag(w9.lowConfidenceFields, 'is_1099_eligible') ? s.chipAttn : ''}`}>
                    <Check checked={is1099} onChange={(e) => setIs1099(e.target.checked)} label="1099-eligible vendor" />
                    <span className="t-cap">
                      {w9.is_1099_eligible_signal === null ? 'AI unsure — please confirm' : `AI suggests ${w9.is_1099_eligible_signal ? 'eligible' : 'exempt'}`}
                    </span>
                  </div>
                </div>
              )}

              {mode === 'COI' && coi && (
                <div className={s.stack}>
                  {/* Certificate-level facts (read-only; not stored as columns) */}
                  <div className={s.facts}>
                    <CoiFact label="Carrier" value={coi.carrier} />
                    <CoiFact label="Policy #" value={coi.policy_number} />
                    <CoiFact label="Named insured" value={coi.named_insured} />
                    <CoiFact label="Additional insured" value={coi.additional_insured == null ? null : coi.additional_insured ? 'Yes' : 'No'} />
                    <p className={`${s.full} t-cap row`} style={{ gap: 6 }}>
                      <Icon name="lock" /> Certificate detail is shown for review; only the GL / WC limits and expirations below are stored.
                    </p>
                  </div>

                  {coi.coverages.length === 0 ? (
                    <div className="wg-state" style={{ border: '1px dashed var(--line-2)', height: 'auto' }}>
                      <span className="t-head">No coverage lines were found on this certificate.</span>
                      <p className="ink-2">Close this and add the coverage by hand, or upload a clearer copy.</p>
                    </div>
                  ) : (
                    <div>
                      {coi.coverages.map((cov, i) => {
                        const persistable = cov.doc_type !== null;
                        return (
                          <div key={i} className={`${s.coverage} ${persistable ? '' : s.coverageOff}`}>
                            <div className={s.coverageHead}>
                              <span className="row" style={{ gap: 8 }}>
                                {persistable ? (
                                  <Check
                                    checked={!!keep[i]}
                                    onChange={(e) => setKeep((k) => ({ ...k, [i]: e.target.checked }))}
                                    aria-label={`Record ${cov.coverage_type.replace(/_/g, ' ').toLowerCase()}`}
                                  />
                                ) : (
                                  <Icon name="lock" />
                                )}
                                <span className="t-head">{cov.coverage_type.replace(/_/g, ' ').toLowerCase()}</span>
                                {cov.doc_type && <Tag tone="ai">{cov.doc_type === 'GL_COI' ? 'GL' : 'WC'}</Tag>}
                              </span>
                              {!persistable && <span className="t-cap">Not stored — no document type</span>}
                            </div>
                            <div className={s.grid3}>
                              <Field label="Each-occurrence limit ($)" className={flag(cov.lowConfidenceFields, 'each_occurrence')}>
                                <Input
                                  type="number" min={0} step={1000}
                                  className="tnum"
                                  disabled={!persistable}
                                  value={cov.each_occurrence_cents != null ? centsToDollars(cov.each_occurrence_cents) : ''}
                                  onChange={(e) => setCoverage(i, { each_occurrence_cents: e.target.value === '' ? null : dollarsToCents(Number(e.target.value)) })}
                                  placeholder="1000000"
                                />
                              </Field>
                              <Field label="Effective">
                                <Input type="date" disabled={!persistable} value={cov.effective_date ?? ''} onChange={(e) => setCoverage(i, { effective_date: e.target.value || null })} />
                              </Field>
                              <Field label="Expiration" className={flag(cov.lowConfidenceFields, 'expiration_date')}>
                                <Input type="date" disabled={!persistable} value={cov.expiration_date ?? ''} onChange={(e) => setCoverage(i, { expiration_date: e.target.value || null })} />
                              </Field>
                            </div>
                            {persistable && cov.lowConfidenceFields.length > 0 && (
                              <p className="t-cap row" style={{ marginTop: 8, gap: 6 }}>
                                <Tag tone="warn">Check</Tag> Review the outlined field(s) — the AI was unsure or the value was not stated.
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {reviewing && (
          <div className="dialog-foot">
            <span className="t-cap" style={{ maxWidth: 320 }}>
              {mode === 'W9' ? 'Confirm records the W-9 on file and updates 1099 readiness.' : 'Confirm records each coverage on the compliance monitor.'}
            </span>
            <span className="sp" />
            <Button variant="quiet" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => (mode === 'W9' ? confirmW9() : confirmCoi())}
              disabled={phase === 'confirming'}
              aria-busy={phase === 'confirming' || undefined}
            >
              {phase === 'confirming' ? 'Saving…' : mode === 'W9' ? 'Confirm W-9' : 'Confirm coverages'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function CoiFact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className={s.fact}>
      <span className={`${s.factLabel} eyebrow`}>{label}</span>
      <span className={value ? 'mb-trunc' : 'mb-trunc ink-3'}>{value ?? '— not read —'}</span>
    </div>
  );
}
