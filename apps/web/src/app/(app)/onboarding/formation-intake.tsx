'use client';

import { useCallback, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { UploadCloud, Loader2, Sparkles, AlertTriangle, ScrollText, Plus, X, Check } from 'lucide-react';
import { addToast } from '@/hooks/use-toast';

/**
 * FORMATION INTAKE — drop the EIN letter / articles of organization / operating
 * agreement; AI proposes the company's legal record; you review and confirm. On
 * confirm it upserts core.company_legal_records for the company. AI only reads the
 * document; the human confirms — nothing is stored until then.
 */

type EntityType = 'LLC' | 'C_CORP' | 'S_CORP' | 'PARTNERSHIP' | 'SOLE_PROP' | 'NONPROFIT' | 'OTHER';
const ENTITY_TYPES: { value: EntityType; label: string }[] = [
  { value: 'LLC', label: 'LLC' },
  { value: 'C_CORP', label: 'C-Corp' },
  { value: 'S_CORP', label: 'S-Corp' },
  { value: 'PARTNERSHIP', label: 'Partnership' },
  { value: 'SOLE_PROP', label: 'Sole proprietor' },
  { value: 'NONPROFIT', label: 'Nonprofit' },
  { value: 'OTHER', label: 'Other' },
];

interface Member { name: string; role: string | null; ownership_pct: number | null }
interface ProposedFormation {
  legal_name: string | null;
  entity_type: EntityType | null;
  ein: string | null;
  formation_state: string | null;
  formation_date: string | null;
  registered_agent: string | null;
  members: Member[];
  lowConfidenceFields?: string[];
}

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function FormationIntake({ companyId }: { companyId: string | null }) {
  const [phase, setPhase] = useState<'upload' | 'parsing' | 'review'>('upload');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Editable review state
  const [legalName, setLegalName] = useState('');
  const [entityType, setEntityType] = useState<EntityType | ''>('');
  const [ein, setEin] = useState('');
  const [formationState, setFormationState] = useState('');
  const [formationDate, setFormationDate] = useState('');
  const [registeredAgent, setRegisteredAgent] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [low, setLow] = useState<string[]>([]);

  const parse = useCallback(async (file: File) => {
    setError(null);
    if (!ALLOWED.includes(file.type)) { setError('Unsupported file — PDF or image only.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('File too large (max 10MB).'); return; }
    setPhase('parsing');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/onboarding/formation/parse', { method: 'POST', body: fd });
      const body = (await res.json()) as { formation?: ProposedFormation; error?: string };
      if (!res.ok || !body.formation) { setError(body.error ?? 'Could not read that document.'); setPhase('upload'); return; }
      const f = body.formation;
      setLegalName(f.legal_name ?? '');
      setEntityType(f.entity_type ?? '');
      setEin(f.ein ?? '');
      setFormationState(f.formation_state ?? '');
      setFormationDate(f.formation_date ?? '');
      setRegisteredAgent(f.registered_agent ?? '');
      setMembers(f.members ?? []);
      setLow(f.lowConfidenceFields ?? []);
      setPhase('review');
    } catch {
      setError('Network error reading the document.');
      setPhase('upload');
    }
  }, []);

  async function save() {
    if (!legalName.trim()) { addToast('error', 'Legal name is required'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/onboarding/formation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          location_id: companyId ?? null,
          legal_name: legalName.trim(),
          entity_type: entityType || null,
          ein: ein.trim() || null,
          formation_state: formationState.trim() || null,
          formation_date: formationDate || null,
          registered_agent: registeredAgent.trim() || null,
          members: members.filter((m) => m.name.trim() !== ''),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) { addToast('error', body.error ?? 'Could not save the legal record'); return; }
      addToast('success', 'Company legal record saved');
      setSavedName(legalName.trim());
      setPhase('upload');
    } finally {
      setSaving(false);
    }
  }

  const lowCls = (f: string) => (low.includes(f) ? 'border-amber-500/60 ring-1 ring-amber-500/30' : '');
  const inputCls = 'w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';
  const label = 'block text-[10px] text-slate-500 mb-1 uppercase tracking-wide';

  return (
    <div className="rounded-xl border border-slate-800 bg-surface-900/60 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ScrollText size={15} className="text-brand-400" />
        <div>
          <p className="text-sm font-medium text-white">Company legal record</p>
          <p className="text-[11px] text-slate-500">
            Drop your EIN letter, articles of organization, or operating agreement — AI reads the legal details; you confirm.
          </p>
        </div>
        {savedName && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <Check size={12} /> {savedName} saved
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {(phase === 'upload' || phase === 'parsing') && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void parse(f); }}
          onClick={() => phase === 'upload' && fileInput.current?.click()}
          className={clsx(
            'flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors',
            phase === 'parsing' ? 'border-brand-500/40 bg-brand-500/5 cursor-default'
              : dragOver ? 'border-brand-500 bg-brand-500/5 cursor-pointer' : 'border-slate-700 hover:border-slate-600 cursor-pointer',
          )}
        >
          <input ref={fileInput} type="file" accept=".pdf,image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void parse(f); e.target.value = ''; }} />
          {phase === 'parsing' ? (
            <><Loader2 className="w-7 h-7 text-brand-400 animate-spin mb-2" /><p className="text-xs text-slate-300">Reading the document…</p></>
          ) : (
            <><UploadCloud className="w-8 h-8 text-slate-500 mb-2" /><p className="text-xs text-slate-200 font-medium">Drop a formation document</p>
              <p className="text-[10px] text-slate-500 mt-1">EIN letter · articles · operating agreement · PDF/image</p></>
          )}
        </div>
      )}

      {phase === 'review' && (
        <div className="space-y-3">
          {low.length > 0 && (
            <p className="text-[11px] text-amber-400/80 flex items-center gap-1"><AlertTriangle size={11} /> Review the highlighted fields.</p>
          )}
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-6"><label className={label}>Legal name</label>
              <input className={clsx(inputCls, lowCls('legal_name'))} value={legalName} onChange={(e) => setLegalName(e.target.value)} /></div>
            <div className="col-span-3"><label className={label}>Entity type</label>
              <select className={inputCls} value={entityType} onChange={(e) => setEntityType(e.target.value as EntityType)}>
                <option value="">—</option>
                {ENTITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select></div>
            <div className="col-span-3"><label className={label}>EIN</label>
              <input className={clsx(inputCls, lowCls('ein'))} value={ein} onChange={(e) => setEin(e.target.value)} placeholder="12-3456789" /></div>
            <div className="col-span-4"><label className={label}>Formation state</label>
              <input className={inputCls} value={formationState} onChange={(e) => setFormationState(e.target.value)} placeholder="IA" /></div>
            <div className="col-span-4"><label className={label}>Formation date</label>
              <input type="date" className={inputCls} value={formationDate} onChange={(e) => setFormationDate(e.target.value)} /></div>
            <div className="col-span-4"><label className={label}>Registered agent</label>
              <input className={inputCls} value={registeredAgent} onChange={(e) => setRegisteredAgent(e.target.value)} /></div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={label}>Members / owners</label>
              <button type="button" onClick={() => setMembers((m) => [...m, { name: '', role: null, ownership_pct: null }])}
                className="text-[11px] text-brand-400 hover:text-brand-300 inline-flex items-center gap-1"><Plus size={11} /> Add</button>
            </div>
            {members.length === 0 ? (
              <p className="text-[11px] text-slate-600">No members detected. Add any owners/officers named in the document.</p>
            ) : (
              <div className="space-y-1.5">
                {members.map((m, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <input className={clsx(inputCls, 'col-span-5')} placeholder="Name" value={m.name}
                      onChange={(e) => setMembers((xs) => xs.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    <input className={clsx(inputCls, 'col-span-4')} placeholder="Role (e.g. Member, President)" value={m.role ?? ''}
                      onChange={(e) => setMembers((xs) => xs.map((x, j) => j === i ? { ...x, role: e.target.value || null } : x))} />
                    <input className={clsx(inputCls, 'col-span-2')} type="number" step="0.01" placeholder="%" value={m.ownership_pct ?? ''}
                      onChange={(e) => setMembers((xs) => xs.map((x, j) => j === i ? { ...x, ownership_pct: e.target.value === '' ? null : Number(e.target.value) } : x))} />
                    <button type="button" onClick={() => setMembers((xs) => xs.filter((_, j) => j !== i))}
                      className="col-span-1 text-slate-600 hover:text-red-400 flex justify-center" aria-label="Remove member"><X size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <button onClick={() => { setPhase('upload'); setError(null); }} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white">Cancel</button>
            <button onClick={() => void save()} disabled={saving}
              className="px-4 py-1.5 text-xs font-medium bg-brand-500 text-slate-900 hover:bg-brand-400 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Save legal record
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
