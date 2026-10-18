'use client';

import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  UploadCloud, FileText, Loader2, X, Trash2, Sparkles, AlertTriangle, Info,
  Plus, ShieldCheck, CheckCircle2, ChevronRight, Pencil, Ban, Store,
} from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { StatusBadge, EmptyState, TableSkeleton } from '@/components/ui';

// ── Ruleset shape (mirrors lib/policy/ap-schema.ts; all money in CENTS) ──
type Severity = 'WARN' | 'BLOCK';
interface VendorRule {
  label?: string;
  matchVendorId: string | null;
  matchKeywords: string[];
  prohibited: boolean;
  perBillLimitCents: number | null;
  severity: Severity;
}
interface CategoryRule {
  category: string;
  label?: string;
  matchAccountIds: string[];
  matchAccountNumbers: string[];
  matchKeywords: string[];
  perLineLimitCents: number | null;
  perBillLimitCents: number | null;
  prohibited: boolean;
  severity: Severity;
}
interface ApprovalTier { uptoCents: number | null; tier: string }
interface UnmappedClause { text: string; note?: string }
interface Ruleset {
  schemaVersion: 1;
  currency: string;
  vendors: VendorRule[];
  categories: CategoryRule[];
  approvalTiers: ApprovalTier[];
  perBillCeilingCents: number | null;
  perBillCeilingSeverity: Severity;
  requirePoOverCents: number | null;
  requirePoSeverity: Severity;
  requireThreeWayMatchOverCents: number | null;
  threeWayMatchSeverity: Severity;
  duplicateBillBlock: boolean;
  duplicateBillSeverity: Severity;
  unmappedClauses: UnmappedClause[];
  sourceSummary: string | null;
}

interface PolicyRow {
  id: string;
  name: string;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  compiled_rules: Ruleset;
  source_note: string | null;
  activated_at: string | null;
  created_at: string;
}
interface ListResponse { data: PolicyRow[]; active: PolicyRow | null }

const EMPTY_RULESET: Ruleset = {
  schemaVersion: 1,
  currency: 'USD',
  vendors: [],
  categories: [],
  approvalTiers: [],
  perBillCeilingCents: null,
  perBillCeilingSeverity: 'BLOCK',
  requirePoOverCents: null,
  requirePoSeverity: 'BLOCK',
  requireThreeWayMatchOverCents: null,
  threeWayMatchSeverity: 'BLOCK',
  duplicateBillBlock: false,
  duplicateBillSeverity: 'BLOCK',
  unmappedClauses: [],
  sourceSummary: null,
};

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const inputCls =
  'w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';

/** cents → dollar string for an input value ('' when null). */
const dollars = (c: number | null): string => (c === null ? '' : String(c / 100));
/** dollar input → integer cents (null when empty). */
const toCents = (v: string): number | null => {
  const s = v.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

export function ApPolicyClient() {
  const { data, isLoading, error, refetch } = useQuery<ListResponse>('/api/bills/policy');
  const [showCompile, setShowCompile] = useState(false);
  const [editor, setEditor] = useState<{ ruleset: Ruleset; name: string; sourceNote: string; decisionId?: string } | null>(null);

  const policies = data?.data ?? [];
  const active = data?.active ?? null;

  const openEditorFromParse = useCallback(
    (ruleset: Ruleset, name: string, sourceNote: string, decisionId?: string) => {
      setShowCompile(false);
      setEditor({ ruleset, name, sourceNote, decisionId });
    },
    []
  );

  async function activateExisting(id: string) {
    const res = await api.post(`/api/bills/policy/${id}/activate`, {});
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Policy activated');
    refetch();
  }

  if (editor) {
    return (
      <PolicyEditor
        initial={editor}
        onClose={() => setEditor(null)}
        onSaved={() => { setEditor(null); refetch(); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* Actions */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-slate-500 max-w-xl">
          The AI compiles a bill-approval policy document into a schema-validated ruleset (config, never code). Clauses it
          can&rsquo;t express are flagged for you. Nothing enforces until you activate a version — then every bill is checked
          on create and approval.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditor({ ruleset: structuredClone(EMPTY_RULESET), name: 'AP Approval Policy', sourceNote: '' })}
            className="btn-ghost btn-sm inline-flex items-center gap-1.5"
          >
            <Pencil size={14} /> Create manually
          </button>
          <button onClick={() => setShowCompile(true)} className="btn-primary btn-sm inline-flex items-center gap-1.5">
            <Sparkles size={14} /> Compile from document
          </button>
        </div>
      </div>

      {/* Active policy card */}
      {active ? (
        <div className="card p-4 border-emerald-500/30">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheck size={18} className="text-emerald-400" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{active.name}</span>
                  <StatusBadge status="ACTIVE" />
                  <span className="text-2xs text-slate-500 font-mono">v{active.version}</span>
                </div>
                <p className="text-[11px] text-slate-500">
                  {active.compiled_rules.vendors.length} vendor rules · {active.compiled_rules.categories.length} category rules · {active.compiled_rules.approvalTiers.length} approval tiers
                  {active.compiled_rules.unmappedClauses.length > 0 && (
                    <span className="text-amber-400"> · {active.compiled_rules.unmappedClauses.length} unmapped clause(s)</span>
                  )}
                </p>
              </div>
            </div>
            <button
              onClick={() => setEditor({ ruleset: structuredClone(active.compiled_rules), name: active.name, sourceNote: active.source_note ?? '' })}
              className="btn-ghost btn-sm inline-flex items-center gap-1.5"
            >
              <Pencil size={13} /> New version from this
            </button>
          </div>
          <RulesetSummary ruleset={active.compiled_rules} />
        </div>
      ) : (
        !isLoading && !error && (
          <div className="card p-4 border-amber-500/20 bg-amber-500/[0.03]">
            <div className="flex items-center gap-2 text-amber-300 text-sm">
              <Info size={16} /> No active AP policy — bills use conservative defaults (nothing is blocked).
            </div>
          </div>
        )
      )}

      {/* Version history */}
      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Version history</h3>
        {isLoading ? (
          <TableSkeleton />
        ) : error ? (
          <EmptyState icon={AlertTriangle} title="Couldn’t load policies" description={error} />
        ) : policies.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No policy versions yet"
            description="Compile your written bill-approval policy into a ruleset, review it, and activate to start enforcing."
            action={{ label: 'Compile from document', onClick: () => setShowCompile(true) }}
          />
        ) : (
          <div className="card divide-y divide-slate-800/70">
            {policies.map((p) => (
              <div key={p.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white truncate">{p.name}</span>
                    <span className="text-2xs text-slate-500 font-mono">v{p.version}</span>
                    <StatusBadge status={p.status} />
                  </div>
                  <p className="text-[11px] text-slate-500">
                    {new Date(p.created_at).toLocaleDateString()} · {p.compiled_rules.categories.length} category rules
                    {p.source_note ? ` · ${p.source_note}` : ''}
                  </p>
                </div>
                {p.status !== 'ACTIVE' && (
                  <button onClick={() => activateExisting(p.id)} className="btn-ghost btn-sm inline-flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 size={13} /> Activate
                  </button>
                )}
                <button
                  onClick={() => setEditor({ ruleset: structuredClone(p.compiled_rules), name: p.name, sourceNote: p.source_note ?? '' })}
                  className="p-1.5 rounded-md text-slate-500 hover:text-white hover:bg-slate-800"
                  aria-label="Edit as new version"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCompile && <CompileModal onClose={() => setShowCompile(false)} onCompiled={openEditorFromParse} />}
    </div>
  );
}

// ── Read-only summary chips of a ruleset ──────────────────────────────────────
function RulesetSummary({ ruleset }: { ruleset: Ruleset }) {
  const chips: string[] = [];
  if (ruleset.perBillCeilingCents !== null) chips.push(`Bill ceiling ${formatMoney(ruleset.perBillCeilingCents)}`);
  if (ruleset.requirePoOverCents !== null) chips.push(`PO required ≥ ${formatMoney(ruleset.requirePoOverCents)}`);
  if (ruleset.requireThreeWayMatchOverCents !== null) chips.push(`3-way match ≥ ${formatMoney(ruleset.requireThreeWayMatchOverCents)}`);
  if (ruleset.duplicateBillBlock) chips.push('Duplicate bills blocked');
  if (ruleset.approvalTiers.length > 0) chips.push(`${ruleset.approvalTiers.length} approval tiers`);
  if (chips.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c} className="text-2xs text-slate-300 bg-slate-800/70 rounded px-2 py-0.5">{c}</span>
      ))}
    </div>
  );
}

// ── Drop-and-compile modal ────────────────────────────────────────────────────
function CompileModal({
  onClose,
  onCompiled,
}: {
  onClose: () => void;
  onCompiled: (ruleset: Ruleset, name: string, sourceNote: string, decisionId?: string) => void;
}) {
  const [phase, setPhase] = useState<'upload' | 'parsing'>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const parse = useCallback(async (file: File) => {
    setErr(null);
    if (!ALLOWED.includes(file.type)) { setErr('Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.'); return; }
    if (file.size > 10 * 1024 * 1024) { setErr('File too large. Maximum 10MB.'); return; }
    setPhase('parsing');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/bills/policy/parse', { method: 'POST', body: fd });
      const body = (await res.json()) as { ruleset: Ruleset; meta: { fileName: string; documentNote: string | null; decisionId: string | null } } | { error: string };
      if (!res.ok || 'error' in body) { setErr('error' in body ? body.error : 'Failed to compile'); setPhase('upload'); return; }
      const note = body.meta.documentNote ? `From ${body.meta.fileName}: ${body.meta.documentNote}` : `Compiled from ${body.meta.fileName}`;
      onCompiled(body.ruleset, 'AP Approval Policy', note, body.meta.decisionId ?? undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
      setPhase('upload');
    }
  }, [onCompiled]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">Compile a bill-approval policy</h2>
              <p className="text-[11px] text-slate-500">Drop your written AP policy — AI compiles it into a ruleset you review. Nothing is saved until you activate.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-white" aria-label="Close"><X size={18} /></button>
        </div>
        {err && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
          </div>
        )}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void parse(f); }}
          onClick={() => phase === 'upload' && fileInput.current?.click()}
          className={clsx(
            'flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors',
            phase === 'parsing' ? 'border-indigo-500/40 bg-indigo-500/5 cursor-default'
              : dragOver ? 'border-emerald-500 bg-emerald-500/5 cursor-pointer'
              : 'border-slate-700 hover:border-slate-600 cursor-pointer'
          )}
        >
          <input ref={fileInput} type="file" accept=".pdf,image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }} />
          {phase === 'parsing' ? (
            <>
              <Loader2 className="w-9 h-9 text-indigo-400 animate-spin mb-3" />
              <p className="text-sm text-slate-300">Reading the policy and compiling the ruleset…</p>
            </>
          ) : (
            <>
              <UploadCloud className="w-10 h-10 text-slate-500 mb-3" />
              <p className="text-sm text-slate-200 font-medium">Drop your bill-approval policy here</p>
              <p className="text-[11px] text-slate-500 mt-1">or click to browse · PDF, PNG, JPEG · up to 10MB</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Full editor for a compiled ruleset ────────────────────────────────────────
function PolicyEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: { ruleset: Ruleset; name: string; sourceNote: string; decisionId?: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rs, setRs] = useState<Ruleset>(initial.ruleset);
  const [name, setName] = useState(initial.name);
  const [saving, setSaving] = useState<null | 'draft' | 'activate'>(null);

  const patch = (p: Partial<Ruleset>) => setRs((r) => ({ ...r, ...p }));

  const patchVendor = (i: number, p: Partial<VendorRule>) =>
    setRs((r) => ({ ...r, vendors: r.vendors.map((v, idx) => (idx === i ? { ...v, ...p } : v)) }));
  const removeVendor = (i: number) => setRs((r) => ({ ...r, vendors: r.vendors.filter((_, idx) => idx !== i) }));
  const addVendor = () => setRs((r) => ({
    ...r,
    vendors: [...r.vendors, { label: '', matchVendorId: null, matchKeywords: [], prohibited: false, perBillLimitCents: null, severity: 'BLOCK' }],
  }));

  const patchCat = (i: number, p: Partial<CategoryRule>) =>
    setRs((r) => ({ ...r, categories: r.categories.map((c, idx) => (idx === i ? { ...c, ...p } : c)) }));
  const removeCat = (i: number) => setRs((r) => ({ ...r, categories: r.categories.filter((_, idx) => idx !== i) }));
  const addCat = () => setRs((r) => ({
    ...r,
    categories: [...r.categories, {
      category: 'NEW_CATEGORY', matchAccountIds: [], matchAccountNumbers: [], matchKeywords: [],
      perLineLimitCents: null, perBillLimitCents: null, prohibited: false, severity: 'BLOCK',
    }],
  }));

  const patchTier = (i: number, p: Partial<ApprovalTier>) =>
    setRs((r) => ({ ...r, approvalTiers: r.approvalTiers.map((t, idx) => (idx === i ? { ...t, ...p } : t)) }));
  const addTier = () => setRs((r) => ({ ...r, approvalTiers: [...r.approvalTiers, { uptoCents: null, tier: 'CFO' }] }));
  const removeTier = (i: number) => setRs((r) => ({ ...r, approvalTiers: r.approvalTiers.filter((_, idx) => idx !== i) }));
  const removeUnmapped = (i: number) => setRs((r) => ({ ...r, unmappedClauses: r.unmappedClauses.filter((_, idx) => idx !== i) }));

  async function save(activate: boolean) {
    setSaving(activate ? 'activate' : 'draft');
    const res = await api.post('/api/bills/policy', {
      name: name.trim() || 'AP Approval Policy',
      compiled_rules: rs,
      source_note: initial.sourceNote || undefined,
      source_decision_id: initial.decisionId,
      activate,
    });
    setSaving(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', activate ? 'Policy activated' : 'Draft saved');
    onSaved();
  }

  const sevSelect = (value: Severity, onChange: (v: Severity) => void) => (
    <select className={clsx(inputCls, 'w-auto')} value={value} onChange={(e) => onChange(e.target.value as Severity)}>
      <option value="WARN">Warn</option>
      <option value="BLOCK">Block</option>
    </select>
  );

  const keywordsInput = (value: string[], onChange: (v: string[]) => void) => (
    <input
      className={inputCls}
      value={value.join(', ')}
      onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))}
      placeholder="keywords, comma-separated"
    />
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <input className={clsx(inputCls, 'w-64 text-sm')} value={name} onChange={(e) => setName(e.target.value)} placeholder="Policy name" />
          {rs.unmappedClauses.length > 0 && (
            <span className="text-2xs text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded inline-flex items-center gap-1">
              <AlertTriangle size={11} /> {rs.unmappedClauses.length} unmapped
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="btn-ghost btn-sm">Cancel</button>
          <button onClick={() => save(false)} disabled={saving !== null} className="btn-ghost btn-sm inline-flex items-center gap-1.5">
            {saving === 'draft' && <Loader2 size={13} className="animate-spin" />} Save draft
          </button>
          <button onClick={() => save(true)} disabled={saving !== null} className="btn-primary btn-sm inline-flex items-center gap-1.5">
            {saving === 'activate' && <Loader2 size={13} className="animate-spin" />} <ShieldCheck size={13} /> Activate
          </button>
        </div>
      </div>

      {/* Global controls */}
      <div className="card p-4 space-y-3">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Global controls</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Per-bill ceiling ($)">
            <input className={inputCls} type="number" step="1" value={dollars(rs.perBillCeilingCents)}
              onChange={(e) => patch({ perBillCeilingCents: toCents(e.target.value) })} placeholder="50000" />
          </Field>
          <Field label="Require PO over ($)">
            <input className={inputCls} type="number" step="1" value={dollars(rs.requirePoOverCents)}
              onChange={(e) => patch({ requirePoOverCents: toCents(e.target.value) })} placeholder="10000" />
          </Field>
          <Field label="Require 3-way match over ($)">
            <input className={inputCls} type="number" step="1" value={dollars(rs.requireThreeWayMatchOverCents)}
              onChange={(e) => patch({ requireThreeWayMatchOverCents: toCents(e.target.value) })} placeholder="25000" />
          </Field>
          <Field label="Ceiling rule">{sevSelect(rs.perBillCeilingSeverity, (v) => patch({ perBillCeilingSeverity: v }))}</Field>
          <Field label="PO rule">{sevSelect(rs.requirePoSeverity, (v) => patch({ requirePoSeverity: v }))}</Field>
          <Field label="3-way match rule">{sevSelect(rs.threeWayMatchSeverity, (v) => patch({ threeWayMatchSeverity: v }))}</Field>
          <Field label="Block duplicate bills">
            <label className="inline-flex items-center gap-2 text-xs text-slate-300 pt-1.5">
              <input type="checkbox" checked={rs.duplicateBillBlock} onChange={(e) => patch({ duplicateBillBlock: e.target.checked })} />
              {rs.duplicateBillBlock ? 'On' : 'Off'}
            </label>
          </Field>
          <Field label="Duplicate rule">{sevSelect(rs.duplicateBillSeverity, (v) => patch({ duplicateBillSeverity: v }))}</Field>
        </div>
      </div>

      {/* Vendor rules */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide inline-flex items-center gap-1.5"><Store size={13} /> Vendor rules</h3>
          <button onClick={addVendor} className="btn-ghost btn-sm inline-flex items-center gap-1"><Plus size={13} /> Add vendor rule</button>
        </div>
        {rs.vendors.length === 0 ? (
          <p className="text-[11px] text-slate-500">No vendor rules. Add one to prohibit a vendor or cap per-bill spend.</p>
        ) : (
          <div className="space-y-2">
            {rs.vendors.map((v, i) => (
              <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 grid grid-cols-12 gap-2 items-end">
                <div className="col-span-3">
                  <label className="block text-[10px] text-slate-500 mb-1">Vendor label</label>
                  <input className={inputCls} value={v.label ?? ''} onChange={(e) => patchVendor(i, { label: e.target.value })} placeholder="Acme Supply" />
                </div>
                <div className="col-span-4">
                  <label className="block text-[10px] text-slate-500 mb-1">Match keywords</label>
                  {keywordsInput(v.matchKeywords, (kw) => patchVendor(i, { matchKeywords: kw }))}
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] text-slate-500 mb-1">Per bill ($)</label>
                  <input className={inputCls} type="number" value={dollars(v.perBillLimitCents)} onChange={(e) => patchVendor(i, { perBillLimitCents: toCents(e.target.value) })} />
                </div>
                <div className="col-span-2 flex items-center gap-2 pb-1">
                  <label className="inline-flex items-center gap-1 text-[10px] text-slate-400" title="Prohibited vendor">
                    <input type="checkbox" checked={v.prohibited} onChange={(e) => patchVendor(i, { prohibited: e.target.checked })} /> <Ban size={11} /> No
                  </label>
                  {sevSelect(v.severity, (s) => patchVendor(i, { severity: s }))}
                </div>
                <div className="col-span-1 flex justify-end">
                  <button onClick={() => removeVendor(i)} className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-slate-800" aria-label="Remove"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Category / GL rules */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Category / GL limits</h3>
          <button onClick={addCat} className="btn-ghost btn-sm inline-flex items-center gap-1"><Plus size={13} /> Add category</button>
        </div>
        {rs.categories.length === 0 ? (
          <p className="text-[11px] text-slate-500">No category rules. Add one, or compile a policy document.</p>
        ) : (
          <div className="space-y-2">
            {rs.categories.map((c, i) => (
              <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 grid grid-cols-12 gap-2 items-end">
                <div className="col-span-3">
                  <label className="block text-[10px] text-slate-500 mb-1">Category</label>
                  <input className={inputCls} value={c.label ?? c.category}
                    onChange={(e) => patchCat(i, { label: e.target.value, category: e.target.value.toUpperCase().replace(/[^A-Z0-9]+/g, '_') })} />
                </div>
                <div className="col-span-3">
                  <label className="block text-[10px] text-slate-500 mb-1">Match keywords</label>
                  {keywordsInput(c.matchKeywords, (kw) => patchCat(i, { matchKeywords: kw }))}
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] text-slate-500 mb-1">Per line ($)</label>
                  <input className={inputCls} type="number" value={dollars(c.perLineLimitCents)} onChange={(e) => patchCat(i, { perLineLimitCents: toCents(e.target.value) })} />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] text-slate-500 mb-1">Per bill ($)</label>
                  <input className={inputCls} type="number" value={dollars(c.perBillLimitCents)} onChange={(e) => patchCat(i, { perBillLimitCents: toCents(e.target.value) })} />
                </div>
                <div className="col-span-1 flex items-center gap-1 pb-1">
                  <label className="inline-flex items-center gap-1 text-[10px] text-slate-400" title="Prohibited">
                    <input type="checkbox" checked={c.prohibited} onChange={(e) => patchCat(i, { prohibited: e.target.checked })} /> <Ban size={11} />
                  </label>
                </div>
                <div className="col-span-1 flex items-center justify-end gap-1">
                  {sevSelect(c.severity, (s) => patchCat(i, { severity: s }))}
                  <button onClick={() => removeCat(i)} className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-slate-800" aria-label="Remove"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Approval tiers */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Approval routing</h3>
          <button onClick={addTier} className="btn-ghost btn-sm inline-flex items-center gap-1"><Plus size={13} /> Add tier</button>
        </div>
        {rs.approvalTiers.length === 0 ? (
          <p className="text-[11px] text-slate-500">No amount-tiered routing. All bills use the default approver.</p>
        ) : (
          <div className="space-y-2">
            {rs.approvalTiers.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[11px] text-slate-500">Up to ($)</span>
                <input className={clsx(inputCls, 'w-32')} type="number" value={dollars(t.uptoCents)}
                  onChange={(e) => patchTier(i, { uptoCents: toCents(e.target.value) })} placeholder="(else)" />
                <ChevronRight size={13} className="text-slate-600" />
                <input className={clsx(inputCls, 'w-40')} value={t.tier} onChange={(e) => patchTier(i, { tier: e.target.value })} placeholder="CONTROLLER" />
                <button onClick={() => removeTier(i)} className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-slate-800" aria-label="Remove"><Trash2 size={13} /></button>
              </div>
            ))}
            <p className="text-[10px] text-slate-600">Leave &ldquo;Up to&rdquo; blank for the catch-all tier (everything above).</p>
          </div>
        )}
      </div>

      {/* Unmapped clauses — human handling */}
      {rs.unmappedClauses.length > 0 && (
        <div className="card p-4 space-y-2 border-amber-500/20">
          <h3 className="text-xs font-semibold text-amber-300 uppercase tracking-wide flex items-center gap-1.5">
            <AlertTriangle size={13} /> Unmapped clauses — need manual handling
          </h3>
          <p className="text-[11px] text-slate-500">
            The compiler could not express these as structured rules, so the engine will NOT enforce them. Handle them in
            your process, or dismiss once addressed.
          </p>
          <div className="space-y-2">
            {rs.unmappedClauses.map((u, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
                <Info size={13} className="mt-0.5 shrink-0 text-amber-400/70" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-slate-300">{u.text}</p>
                  {u.note && <p className="text-[10px] text-slate-500 mt-0.5">{u.note}</p>}
                </div>
                <button onClick={() => removeUnmapped(i)} className="p-1 rounded text-slate-500 hover:text-white hover:bg-slate-800" aria-label="Dismiss"><X size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] text-slate-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
