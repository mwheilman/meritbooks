'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2, Users, BookOpen, ChevronRight, ChevronLeft,
  Loader2, Check, AlertCircle, Plus, Trash2, Sparkles
} from 'lucide-react';
import { clsx } from 'clsx';

interface CompanyEntry { key: string; name: string; shortCode: string; industry: string; fiscalYearStartMonth: number }
interface TeamMember { key: string; firstName: string; lastName: string; email: string; role: string; assignedCompanyKeys: string[] }

type Step = 'organization' | 'companies' | 'team' | 'accounts' | 'review';

const STEPS: { key: Step; label: string; icon: typeof Building2 }[] = [
  { key: 'organization', label: 'Organization', icon: Building2 },
  { key: 'companies', label: 'Companies', icon: Building2 },
  { key: 'team', label: 'Team & Roles', icon: Users },
  { key: 'accounts', label: 'Chart of Accounts', icon: BookOpen },
  { key: 'review', label: 'Review & Launch', icon: Check },
];

const ROLES = [
  { value: 'org_admin', label: 'Admin', desc: 'Full access to everything' },
  { value: 'cfo', label: 'CFO', desc: 'Financial oversight, approve COA changes' },
  { value: 'accounting_manager', label: 'Accounting Manager', desc: 'Day-to-day accounting, review transactions' },
  { value: 'senior_accountant', label: 'Senior Accountant', desc: 'Post JEs, manage close, run reports' },
  { value: 'accountant', label: 'Accountant', desc: 'Data entry, categorize, submit receipts' },
  { value: 'check_processor', label: 'Check Processor', desc: 'Print and manage checks only' },
  { value: 'viewer', label: 'Viewer', desc: 'Read-only reports and dashboards' },
];

const INDUSTRIES = ['HVAC', 'Construction', 'Cabinetry', 'Plumbing', 'Electrical', 'Marketing', 'IT Services', 'HR Services', 'Bookkeeping', 'Property Management', 'Manufacturing', 'Retail', 'Professional Services', 'Other'];

function genKey() { return Math.random().toString(36).slice(2, 8); }

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('organization');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [timezone, setTimezone] = useState('America/Chicago');

  const [companies, setCompanies] = useState<CompanyEntry[]>([{ key: genKey(), name: '', shortCode: '', industry: '', fiscalYearStartMonth: 1 }]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [coaSeeded, setCoaSeeded] = useState(false);
  const [coaCount, setCoaCount] = useState(0);
  const [coaSeeding, setCoaSeeding] = useState(false);
  const [companiesCreated, setCompaniesCreated] = useState<string[]>([]);

  const stepIdx = STEPS.findIndex((s) => s.key === step);
  const inputCls = "w-full px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20";
  const labelCls = "block text-xs text-slate-400 mb-1.5 font-medium";

  useEffect(() => {
    fetch('/api/setup').then((r) => r.json()).then((d) => {
      if (d.setupComplete) router.push('/dashboard');
      else {
        if (d.orgId) { setOrgName(d.orgName ?? ''); if (d.accountCount > 0) { setCoaSeeded(true); setCoaCount(d.accountCount); } if (d.locationCount > 0) setStep('team'); }
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [router]);

  useEffect(() => { if (orgName && !orgSlug) setOrgSlug(orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)); }, [orgName, orgSlug]);

  const handleNext = useCallback(async () => {
    setError('');
    setSubmitting(true);
    try {
      if (step === 'organization') {
        if (!orgName.trim()) { setError('Organization name is required'); setSubmitting(false); return; }
        const res = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'organization', name: orgName.trim(), slug: orgSlug.trim() || orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50), contact_name: contactName.trim() || undefined, contact_email: contactEmail.trim() || undefined, timezone }) });
        const d = await res.json();
        if (!res.ok) { setError(d.error ?? 'Failed'); setSubmitting(false); return; }
        setStep('companies');
      } else if (step === 'companies') {
        const valid = companies.filter((c) => c.name.trim() && c.shortCode.trim());
        if (valid.length === 0) { setError('Add at least one company'); setSubmitting(false); return; }
        const codes = valid.map((c) => c.shortCode.toUpperCase());
        if (new Set(codes).size !== codes.length) { setError('Each company needs a unique short code'); setSubmitting(false); return; }
        const created: string[] = [];
        for (const co of valid) {
          const res = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'company', name: co.name.trim(), short_code: co.shortCode.toUpperCase().trim(), industry: co.industry || undefined, fiscal_year_start_month: co.fiscalYearStartMonth }) });
          const d = await res.json();
          if (!res.ok) { setError(`"${co.name}": ${d.error}`); setSubmitting(false); return; }
          created.push(co.name);
        }
        setCompaniesCreated(created);
        setStep('team');
      } else if (step === 'team') {
        setStep('accounts');
      } else if (step === 'accounts') {
        if (!coaSeeded) {
          setCoaSeeding(true);
          const res = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'chart_of_accounts' }) });
          const d = await res.json();
          setCoaSeeding(false);
          if (!res.ok) { setError(d.error ?? 'Failed'); setSubmitting(false); return; }
          setCoaSeeded(true);
          setCoaCount(d.accountCount ?? 251);
        }
        setStep('review');
      } else if (step === 'review') {
        const res = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'finalize' }) });
        if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Failed'); setSubmitting(false); return; }
        router.push('/dashboard');
      }
    } catch { setError('Network error'); }
    setSubmitting(false);
  }, [step, orgName, orgSlug, contactName, contactEmail, timezone, companies, coaSeeded, router]);

  if (loading) return <div className="flex items-center justify-center py-24"><Loader2 className="w-8 h-8 text-emerald-400 animate-spin" /></div>;

  return (
    <div>
      {/* Progress */}
      <div className="flex items-center gap-2 mb-10">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const cur = s.key === step;
          const done = i < stepIdx;
          return (
            <div key={s.key} className="flex items-center gap-2 flex-1">
              <div className={clsx('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', done ? 'bg-emerald-600 text-white' : cur ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-600')}>
                {done ? <Check size={16} /> : <Icon size={16} />}
              </div>
              <span className={clsx('text-xs font-medium hidden sm:block', cur ? 'text-white' : done ? 'text-emerald-400' : 'text-slate-600')}>{s.label}</span>
              {i < STEPS.length - 1 && <div className={clsx('h-px flex-1', done ? 'bg-emerald-600' : 'bg-slate-800')} />}
            </div>
          );
        })}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        {/* Step 1: Organization */}
        {step === 'organization' && (
          <div className="p-8">
            <h2 className="text-2xl font-semibold text-white mb-1">Set up your organization</h2>
            <p className="text-sm text-slate-400 mb-8">The parent entity that owns all companies and data.</p>
            <div className="space-y-5 max-w-lg">
              <div><label className={labelCls}>Organization Name *</label><input value={orgName} onChange={(e) => { setOrgName(e.target.value); setOrgSlug(''); }} placeholder="e.g. Merit Management Group" className={inputCls} /></div>
              <div><label className={labelCls}>URL Slug</label><div className="flex items-center gap-2"><span className="text-xs text-slate-600 shrink-0">meritbooks.app/</span><input value={orgSlug} onChange={(e) => setOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="merit-mgmt" className={clsx(inputCls, 'flex-1')} /></div></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className={labelCls}>Your Name</label><input value={contactName} onChange={(e) => setContactName(e.target.value)} className={inputCls} /></div>
                <div><label className={labelCls}>Email</label><input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={inputCls} /></div>
              </div>
              <div><label className={labelCls}>Timezone</label><select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputCls}><option value="America/Chicago">Central</option><option value="America/New_York">Eastern</option><option value="America/Denver">Mountain</option><option value="America/Los_Angeles">Pacific</option></select></div>
            </div>
          </div>
        )}

        {/* Step 2: Companies */}
        {step === 'companies' && (
          <div className="p-8">
            <h2 className="text-2xl font-semibold text-white mb-1">Add your companies</h2>
            <p className="text-sm text-slate-400 mb-8">Each company has its own GL, bank accounts, and statements. Add more later in Settings.</p>
            <div className="space-y-4">
              {companies.map((co, idx) => (
                <div key={co.key} className="bg-slate-800/30 border border-slate-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-medium text-white">Company {idx + 1}</span>
                    {companies.length > 1 && <button onClick={() => setCompanies((p) => p.filter((c) => c.key !== co.key))} className="text-slate-500 hover:text-red-400 p-1"><Trash2 size={14} /></button>}
                  </div>
                  <div className="grid grid-cols-4 gap-4">
                    <div className="col-span-2"><label className={labelCls}>Company Name *</label><input value={co.name} onChange={(e) => setCompanies((p) => p.map((c) => c.key === co.key ? { ...c, name: e.target.value } : c))} placeholder="Swan Creek Construction" className={inputCls} /></div>
                    <div><label className={labelCls}>Short Code *</label><input value={co.shortCode} onChange={(e) => setCompanies((p) => p.map((c) => c.key === co.key ? { ...c, shortCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) } : c))} placeholder="SCC" className={clsx(inputCls, 'font-mono')} /></div>
                    <div><label className={labelCls}>Industry</label><select value={co.industry} onChange={(e) => setCompanies((p) => p.map((c) => c.key === co.key ? { ...c, industry: e.target.value } : c))} className={inputCls}><option value="">Select...</option>{INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}</select></div>
                  </div>
                  <div className="mt-3"><label className={labelCls}>Fiscal Year Starts</label><select value={co.fiscalYearStartMonth} onChange={(e) => setCompanies((p) => p.map((c) => c.key === co.key ? { ...c, fiscalYearStartMonth: Number(e.target.value) } : c))} className={clsx(inputCls, 'w-48')}>{Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{new Date(2000, m - 1).toLocaleString('en', { month: 'long' })}</option>)}</select></div>
                </div>
              ))}
            </div>
            <button onClick={() => setCompanies((p) => [...p, { key: genKey(), name: '', shortCode: '', industry: '', fiscalYearStartMonth: 1 }])} className="mt-4 flex items-center gap-2 px-4 py-2 rounded-xl border border-dashed border-slate-700 text-sm text-slate-400 hover:text-emerald-400 hover:border-emerald-500/30 w-full justify-center"><Plus size={16} /> Add another company</button>
          </div>
        )}

        {/* Step 3: Team */}
        {step === 'team' && (
          <div className="p-8">
            <h2 className="text-2xl font-semibold text-white mb-1">Invite your team</h2>
            <p className="text-sm text-slate-400 mb-8">Assign roles and company access. Skip this and add people later if you prefer.</p>
            {teamMembers.length === 0 ? (
              <div className="bg-slate-800/20 border border-slate-800 rounded-xl p-8 text-center">
                <Users className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                <p className="text-sm text-slate-500 mb-4">No team members added yet.</p>
                <button onClick={() => setTeamMembers([{ key: genKey(), firstName: '', lastName: '', email: '', role: 'accountant', assignedCompanyKeys: [] }])} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 mx-auto"><Plus size={16} /> Add Team Member</button>
              </div>
            ) : (
              <div className="space-y-3">
                {teamMembers.map((m) => (
                  <div key={m.key} className="bg-slate-800/30 border border-slate-800 rounded-xl p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 grid grid-cols-4 gap-3">
                        <div><label className={labelCls}>First Name</label><input value={m.firstName} onChange={(e) => setTeamMembers((p) => p.map((t) => t.key === m.key ? { ...t, firstName: e.target.value } : t))} className={inputCls} /></div>
                        <div><label className={labelCls}>Last Name</label><input value={m.lastName} onChange={(e) => setTeamMembers((p) => p.map((t) => t.key === m.key ? { ...t, lastName: e.target.value } : t))} className={inputCls} /></div>
                        <div><label className={labelCls}>Email</label><input type="email" value={m.email} onChange={(e) => setTeamMembers((p) => p.map((t) => t.key === m.key ? { ...t, email: e.target.value } : t))} className={inputCls} /></div>
                        <div><label className={labelCls}>Role</label><select value={m.role} onChange={(e) => setTeamMembers((p) => p.map((t) => t.key === m.key ? { ...t, role: e.target.value } : t))} className={inputCls}>{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select><p className="text-[10px] text-slate-600 mt-0.5">{ROLES.find((r) => r.value === m.role)?.desc}</p></div>
                      </div>
                      <button onClick={() => setTeamMembers((p) => p.filter((t) => t.key !== m.key))} className="mt-6 text-slate-500 hover:text-red-400 p-1 shrink-0"><Trash2 size={14} /></button>
                    </div>
                    {companies.length > 1 && m.role !== 'org_admin' && (
                      <div className="mt-3 pt-3 border-t border-slate-800/50">
                        <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Company Access</label>
                        <div className="flex flex-wrap gap-2">{companies.filter((c) => c.name).map((co) => { const on = m.assignedCompanyKeys.includes(co.key); return <button key={co.key} onClick={() => setTeamMembers((p) => p.map((t) => t.key === m.key ? { ...t, assignedCompanyKeys: on ? t.assignedCompanyKeys.filter((k) => k !== co.key) : [...t.assignedCompanyKeys, co.key] } : t))} className={clsx('px-2.5 py-1 rounded-lg text-xs border', on ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-500')}>{co.shortCode || co.name}</button>; })}</div>
                      </div>
                    )}
                  </div>
                ))}
                <button onClick={() => setTeamMembers((p) => [...p, { key: genKey(), firstName: '', lastName: '', email: '', role: 'accountant', assignedCompanyKeys: [] }])} className="flex items-center gap-2 px-4 py-2 rounded-xl border border-dashed border-slate-700 text-sm text-slate-400 hover:text-emerald-400 w-full justify-center"><Plus size={16} /> Add another</button>
              </div>
            )}
          </div>
        )}

        {/* Step 4: COA */}
        {step === 'accounts' && (
          <div className="p-8">
            <h2 className="text-2xl font-semibold text-white mb-1">Chart of Accounts</h2>
            <p className="text-sm text-slate-400 mb-8">Standardized COA: 7 types, 11 sub-types, 71 groups, 251 accounts — optimized for multi-entity management.</p>
            {coaSeeded ? (
              <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-6 text-center"><Check className="w-10 h-10 mx-auto text-emerald-400 mb-3" /><p className="text-lg font-semibold text-white">{coaCount} accounts loaded</p><p className="text-sm text-slate-400 mt-1">Request additional accounts after setup.</p></div>
            ) : coaSeeding ? (
              <div className="bg-slate-800/30 border border-slate-800 rounded-xl p-8 text-center"><Loader2 className="w-8 h-8 mx-auto text-emerald-400 animate-spin mb-3" /><p className="text-sm text-slate-300">Loading chart of accounts...</p></div>
            ) : (
              <div className="bg-slate-800/30 border border-slate-800 rounded-xl p-6">
                <div className="grid grid-cols-4 gap-4 mb-6">{[['7', 'Account Types'], ['11', 'Sub-Types'], ['71', 'Groups'], ['251', 'Accounts']].map(([n, l]) => <div key={l} className="text-center"><p className="text-2xl font-mono font-semibold text-white">{n}</p><p className="text-xs text-slate-500">{l}</p></div>)}</div>
                <p className="text-xs text-slate-500 text-center">Click Next to load. Takes about 10 seconds.</p>
              </div>
            )}
          </div>
        )}

        {/* Step 5: Review */}
        {step === 'review' && (
          <div className="p-8">
            <h2 className="text-2xl font-semibold text-white mb-1">Review & Launch</h2>
            <p className="text-sm text-slate-400 mb-8">Everything is ready.</p>
            <div className="space-y-3">
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-800/30 border border-slate-800"><Check className="w-5 h-5 text-emerald-400 shrink-0" /><div><p className="text-sm text-white font-medium">{orgName}</p><p className="text-xs text-slate-500">Organization</p></div></div>
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-800/30 border border-slate-800"><Check className="w-5 h-5 text-emerald-400 shrink-0" /><div><p className="text-sm text-white font-medium">{companiesCreated.length} {companiesCreated.length === 1 ? 'company' : 'companies'}</p><p className="text-xs text-slate-500">{companiesCreated.join(', ')}</p></div></div>
              {teamMembers.length > 0 && <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-800/30 border border-slate-800"><Check className="w-5 h-5 text-emerald-400 shrink-0" /><div><p className="text-sm text-white font-medium">{teamMembers.length} team members</p><p className="text-xs text-slate-500">Invitations sent after launch</p></div></div>}
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-slate-800/30 border border-slate-800"><Check className="w-5 h-5 text-emerald-400 shrink-0" /><div><p className="text-sm text-white font-medium">{coaCount} accounts</p><p className="text-xs text-slate-500">Chart of accounts</p></div></div>
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/5 border border-amber-500/20"><Sparkles className="w-5 h-5 text-amber-400 shrink-0" /><div><p className="text-sm text-white font-medium">Connect banking after launch</p><p className="text-xs text-slate-500">Settings → Companies → Connect via Plaid</p></div></div>
            </div>
          </div>
        )}

        {error && <div className="mx-8 mb-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20"><AlertCircle size={14} className="text-red-400 shrink-0" /><p className="text-sm text-red-400">{error}</p></div>}

        <div className="flex items-center justify-between px-8 py-5 border-t border-slate-800 bg-slate-800/10">
          <button onClick={() => { setError(''); if (stepIdx > 0) setStep(STEPS[stepIdx - 1].key); }} disabled={stepIdx === 0} className={clsx('flex items-center gap-2 px-4 py-2 rounded-xl text-sm', stepIdx === 0 ? 'text-slate-700' : 'text-slate-400 hover:text-white hover:bg-slate-800')}><ChevronLeft size={16} /> Back</button>
          {step === 'team' && <button onClick={() => setStep('accounts')} className="text-xs text-slate-500 hover:text-slate-400">Skip for now →</button>}
          <button onClick={handleNext} disabled={submitting} className={clsx('flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium', submitting ? 'bg-slate-700 text-slate-500' : step === 'review' ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-white text-slate-900 hover:bg-slate-100')}>
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {step === 'review' ? <>Launch MeritBooks <Sparkles size={14} /></> : step === 'accounts' && !coaSeeded ? 'Load Chart of Accounts' : <>Next <ChevronRight size={16} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
