'use client';

/**
 * Vendor document intake — DROP-AND-PARSE W-9 / COI review-and-confirm modal.
 *
 * Drop a W-9 or a Certificate of Insurance; the AI (via the metered Core gateway)
 * proposes the fields; the human reviews (low-confidence fields highlighted, TIN
 * masked) and confirms. Nothing persists until confirm — manual entry stays the
 * fallback. One cohesive component drives both document types.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { centsToDollars, dollarsToCents } from '@meritbooks/shared';
import { addToast } from '@/hooks/use-toast';
import {
  UploadCloud, Loader2, X, Sparkles, AlertTriangle, Info, ShieldCheck, FileText, Lock,
} from 'lucide-react';

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

const inputCls =
  'w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-sm text-white focus:border-emerald-500 focus:outline-none';
const flagCls = 'border-amber-500/60 ring-1 ring-amber-500/30';
const labelCls = 'block text-[10px] text-slate-500 uppercase tracking-wider mb-1';

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

  // Escape closes the modal unless a parse/save is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'parsing' && phase !== 'confirming') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  const endpoint = mode === 'W9' ? '/api/vendors/w9-parse' : '/api/vendors/coi-parse';
  const title = mode === 'W9' ? 'Upload W-9' : 'Upload Certificate of Insurance';

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

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void parse(file);
  }

  const setW9Field = <K extends keyof W9Proposal>(k: K, v: W9Proposal[K]) =>
    setW9((p) => (p ? { ...p, [k]: v } : p));
  const setCoverage = (i: number, patch: Partial<Coverage>) =>
    setCoi((c) => (c ? { ...c, coverages: c.coverages.map((cov, idx) => (idx === i ? { ...cov, ...patch } : cov)) } : c));

  const flag = (fields: string[], f: string) => (fields.includes(f) ? flagCls : '');

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-3xl max-h-[92vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">{title}</h2>
              <p className="text-[11px] text-slate-500">
                {vendorName} · Drop the document — AI proposes the fields; you review and confirm. Nothing is saved until you confirm.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* Upload / parsing */}
        {(phase === 'upload' || phase === 'parsing') && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => phase === 'upload' && fileInput.current?.click()}
            className={clsx(
              'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors',
              phase === 'parsing'
                ? 'border-indigo-500/40 bg-indigo-500/5 cursor-default'
                : dragOver
                  ? 'border-emerald-500 bg-emerald-500/5 cursor-pointer'
                  : 'border-slate-700 hover:border-slate-600 cursor-pointer',
            )}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }}
            />
            {phase === 'parsing' ? (
              <>
                <Loader2 className="w-9 h-9 text-indigo-400 animate-spin mb-3" />
                <p className="text-sm text-slate-300">Reading the {mode === 'W9' ? 'W-9' : 'certificate'} and extracting fields…</p>
                <p className="text-[11px] text-slate-500 mt-1">This can take 10-20 seconds.</p>
              </>
            ) : (
              <>
                <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
                <p className="text-sm text-slate-200 font-medium">
                  Drop {mode === 'W9' ? 'a Form W-9' : 'a Certificate of Insurance'} here
                </p>
                <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 10MB</p>
              </>
            )}
          </div>
        )}

        {/* Review */}
        {(phase === 'review' || phase === 'confirming') && (
          <>
            <div className="mb-3 flex items-center gap-2 text-[11px] text-slate-400">
              <FileText size={13} className="text-indigo-400" />
              <span className="truncate max-w-[280px]">{meta?.fileName}</span>
            </div>
            {meta?.documentNote && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
                <Info size={13} className="mt-0.5 shrink-0 text-slate-500" /> {meta.documentNote}
              </div>
            )}

            {mode === 'W9' && w9 && (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className={labelCls}>Legal name (Line 1)</label>
                  <input className={clsx(inputCls, flag(w9.lowConfidenceFields, 'legal_name'))} value={w9.legal_name ?? ''} onChange={(e) => setW9Field('legal_name', e.target.value)} placeholder="As shown on the tax return" />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Business / DBA name (Line 2)</label>
                  <input className={inputCls} value={w9.business_name ?? ''} onChange={(e) => setW9Field('business_name', e.target.value || null)} placeholder="Optional" />
                </div>
                <div>
                  <label className={labelCls}>Federal tax classification</label>
                  <select className={clsx(inputCls, flag(w9.lowConfidenceFields, 'entity_type'))} value={w9.entity_type} onChange={(e) => setW9Field('entity_type', e.target.value)}>
                    {ENTITY_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                  </select>
                  <p className="text-[10px] text-slate-600 mt-1 flex items-center gap-1"><Lock size={9} /> Surfaced for review; not stored (no column).</p>
                </div>
                <div>
                  <label className={labelCls}>TIN / EIN {w9.tin_type ? `(${w9.tin_type})` : ''}</label>
                  <div className={clsx(inputCls, 'flex items-center gap-2 text-slate-300 font-mono', flag(w9.lowConfidenceFields, 'tin'))}>
                    <Lock size={12} className="text-slate-500" />
                    {w9.tin_masked ?? '— not read —'}
                  </div>
                  <p className="text-[10px] text-slate-600 mt-1">Masked · not persisted (Core-owned encryption).</p>
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Address</label>
                  <input className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-sm text-white focus:border-emerald-500 focus:outline-none mb-2" value={w9.address_line1 ?? ''} onChange={(e) => setW9Field('address_line1', e.target.value || null)} placeholder="Street" />
                  <div className="grid grid-cols-3 gap-2">
                    <input className={inputCls} value={w9.city ?? ''} onChange={(e) => setW9Field('city', e.target.value || null)} placeholder="City" />
                    <input className={inputCls} value={w9.state ?? ''} onChange={(e) => setW9Field('state', e.target.value || null)} placeholder="State" maxLength={2} />
                    <input className={inputCls} value={w9.zip ?? ''} onChange={(e) => setW9Field('zip', e.target.value || null)} placeholder="ZIP" />
                  </div>
                </div>
                <div className="col-span-2">
                  <label className={clsx('flex items-center gap-2 rounded-lg border px-3 py-2.5 cursor-pointer', flag(w9.lowConfidenceFields, 'is_1099_eligible') || 'border-slate-700', is1099 ? 'bg-emerald-500/5' : 'bg-slate-900')}>
                    <input type="checkbox" checked={is1099} onChange={(e) => setIs1099(e.target.checked)} className="accent-emerald-500" />
                    <span className="text-sm text-slate-200">1099-eligible vendor</span>
                    <span className="text-[11px] text-slate-500 ml-auto">
                      {w9.is_1099_eligible_signal === null ? 'AI unsure — please confirm' : `AI suggests ${w9.is_1099_eligible_signal ? 'eligible' : 'exempt'}`}
                    </span>
                  </label>
                </div>
              </div>
            )}

            {mode === 'COI' && coi && (
              <div className="space-y-3">
                {/* Certificate-level facts (read-only; not stored as columns) */}
                <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <CoiFact label="Carrier" value={coi.carrier} />
                  <CoiFact label="Policy #" value={coi.policy_number} />
                  <CoiFact label="Named insured" value={coi.named_insured} />
                  <CoiFact label="Additional insured" value={coi.additional_insured == null ? null : coi.additional_insured ? 'Yes' : 'No'} />
                  <p className="col-span-2 text-[10px] text-slate-600 flex items-center gap-1 mt-0.5">
                    <Lock size={9} /> Certificate detail surfaced for review; only the GL / WC coverage limits + expirations below are stored.
                  </p>
                </div>

                {coi.coverages.length === 0 ? (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-6 py-10 text-center text-sm text-slate-400">
                    No coverage lines were detected on this certificate.
                  </div>
                ) : (
                  coi.coverages.map((cov, i) => {
                    const persistable = cov.doc_type !== null;
                    return (
                      <div key={i} className={clsx('rounded-xl border p-3', persistable ? 'border-slate-800 bg-slate-950/40' : 'border-slate-800/60 bg-slate-900/30')}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            {persistable ? (
                              <input type="checkbox" checked={!!keep[i]} onChange={(e) => setKeep((k) => ({ ...k, [i]: e.target.checked }))} className="accent-emerald-500" />
                            ) : (
                              <Lock size={12} className="text-slate-600" />
                            )}
                            <span className="text-sm font-medium text-slate-200">{cov.coverage_type.replace(/_/g, ' ').toLowerCase()}</span>
                            {cov.doc_type && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">{cov.doc_type === 'GL_COI' ? 'GL' : 'WC'}</span>}
                          </div>
                          {!persistable && <span className="text-[10px] text-slate-500">Not stored — no doc type</span>}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className={labelCls}>Each-occurrence limit</label>
                            <div className="relative">
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                              <input
                                type="number" min={0} step={1000}
                                className={clsx(inputCls, 'pl-5', flag(cov.lowConfidenceFields, 'each_occurrence'))}
                                disabled={!persistable}
                                value={cov.each_occurrence_cents != null ? centsToDollars(cov.each_occurrence_cents) : ''}
                                onChange={(e) => setCoverage(i, { each_occurrence_cents: e.target.value === '' ? null : dollarsToCents(Number(e.target.value)) })}
                                placeholder="1000000"
                              />
                            </div>
                          </div>
                          <div>
                            <label className={labelCls}>Effective</label>
                            <input type="date" className={inputCls} disabled={!persistable} value={cov.effective_date ?? ''} onChange={(e) => setCoverage(i, { effective_date: e.target.value || null })} />
                          </div>
                          <div>
                            <label className={labelCls}>Expiration</label>
                            <input type="date" className={clsx(inputCls, flag(cov.lowConfidenceFields, 'expiration_date'))} disabled={!persistable} value={cov.expiration_date ?? ''} onChange={(e) => setCoverage(i, { expiration_date: e.target.value || null })} />
                          </div>
                        </div>
                        {persistable && cov.lowConfidenceFields.length > 0 && (
                          <p className="mt-2 flex items-center gap-1.5 text-[10px] text-amber-400/80">
                            <AlertTriangle size={11} /> Review the highlighted field(s) — the AI was unsure or the value was not stated.
                          </p>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <p className="text-[11px] text-slate-600 max-w-xs flex items-center gap-1.5">
                <ShieldCheck size={13} className="text-emerald-500 shrink-0" />
                {mode === 'W9' ? 'Confirm records the W-9 on file and flips 1099 readiness.' : 'Confirm records each coverage on the compliance monitor.'}
              </p>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                <button
                  onClick={() => (mode === 'W9' ? confirmW9() : confirmCoi())}
                  disabled={phase === 'confirming'}
                  className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                >
                  {phase === 'confirming' && <Loader2 size={14} className="animate-spin" />}
                  {mode === 'W9' ? 'Confirm W-9' : 'Confirm coverages'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CoiFact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 w-28 shrink-0">{label}</span>
      <span className="text-slate-300 truncate">{value ?? <span className="text-slate-600">— not read —</span>}</span>
    </div>
  );
}
