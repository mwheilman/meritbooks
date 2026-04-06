'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Settings, Building2, Bell, Brain, Globe, Save, Loader2, AlertCircle, Check
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { PageHeader } from '@/components/ui';

interface OrgSettings {
  id: string;
  name: string;
  slug: string;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  timezone: string;
  fiscalYearStartMonth: number;
  setupComplete: boolean;
  chase: {
    firstReminderMinutes: number;
    followupMinutes: number;
    escalationThreshold: number;
    quietStart: string;
    quietEnd: string;
    channel: string;
    autoApproveCents: number;
  };
  ai: {
    autoApproveThreshold: number;
    autoApproveMaxCents: number;
  };
}

interface LocationRow {
  id: string;
  name: string;
  short_code: string;
  industry: string | null;
  is_active: boolean;
}

interface SettingsResponse {
  org: OrgSettings;
  locations: LocationRow[];
}

type TabKey = 'organization' | 'chase' | 'ai' | 'companies';

const TABS: { key: TabKey; label: string; icon: typeof Settings }[] = [
  { key: 'organization', label: 'Organization', icon: Globe },
  { key: 'chase', label: 'Receipt Chase', icon: Bell },
  { key: 'ai', label: 'AI Thresholds', icon: Brain },
  { key: 'companies', label: 'Portfolio Companies', icon: Building2 },
];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('organization');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  const { data, isLoading, error, refetch } = useQuery<SettingsResponse>('/api/settings');
  const org = data?.org;
  const locations = data?.locations ?? [];

  // Form state
  const [orgName, setOrgName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [timezone, setTimezone] = useState('America/Chicago');
  const [fiscalMonth, setFiscalMonth] = useState(1);
  const [chaseFirst, setChaseFirst] = useState(30);
  const [chaseFollowup, setChaseFollowup] = useState(120);
  const [chaseEscalation, setChaseEscalation] = useState(3);
  const [chaseQuietStart, setChaseQuietStart] = useState('21:00');
  const [chaseQuietEnd, setChaseQuietEnd] = useState('06:00');
  const [chaseChannel, setChaseChannel] = useState('PUSH_SMS');
  const [chaseAutoApprove, setChaseAutoApprove] = useState(2500);
  const [aiThreshold, setAiThreshold] = useState(0.85);
  const [aiMaxCents, setAiMaxCents] = useState(1000000);

  useEffect(() => {
    if (org) {
      setOrgName(org.name);
      setContactName(org.primaryContactName ?? '');
      setContactEmail(org.primaryContactEmail ?? '');
      setTimezone(org.timezone);
      setFiscalMonth(org.fiscalYearStartMonth);
      setChaseFirst(org.chase.firstReminderMinutes);
      setChaseFollowup(org.chase.followupMinutes);
      setChaseEscalation(org.chase.escalationThreshold);
      setChaseQuietStart(org.chase.quietStart);
      setChaseQuietEnd(org.chase.quietEnd);
      setChaseChannel(org.chase.channel);
      setChaseAutoApprove(org.chase.autoApproveCents);
      setAiThreshold(org.ai.autoApproveThreshold);
      setAiMaxCents(org.ai.autoApproveMaxCents);
    }
  }, [org]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError('');
    setSaved(false);

    const payload: Record<string, unknown> = {
      name: orgName,
      primary_contact_name: contactName || undefined,
      primary_contact_email: contactEmail || undefined,
      timezone,
      fiscal_year_start_month: fiscalMonth,
      chase_first_reminder_minutes: chaseFirst,
      chase_followup_minutes: chaseFollowup,
      chase_escalation_threshold: chaseEscalation,
      chase_quiet_start: chaseQuietStart,
      chase_quiet_end: chaseQuietEnd,
      chase_channel: chaseChannel,
      chase_auto_approve_cents: chaseAutoApprove,
      ai_auto_approve_threshold: aiThreshold,
      ai_auto_approve_max_cents: aiMaxCents,
    };

    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      refetch();
    } else {
      const err = await res.json();
      setSaveError(err.error ?? 'Failed to save');
    }
    setSaving(false);
  }, [orgName, contactName, contactEmail, timezone, fiscalMonth, chaseFirst, chaseFollowup, chaseEscalation, chaseQuietStart, chaseQuietEnd, chaseChannel, chaseAutoApprove, aiThreshold, aiMaxCents, refetch]);

  if (isLoading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>;
  if (error) return <div className="p-8 text-center"><AlertCircle className="w-8 h-8 mx-auto text-red-400 mb-2" /><p className="text-red-400 text-sm">{error}</p></div>;

  const inputCls = "w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50";
  const labelCls = "block text-xs text-slate-500 mb-1.5 font-medium";

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description={`${org?.name ?? 'Organization'} configuration`} />

      <div className="flex gap-6">
        {/* Tabs */}
        <nav className="w-48 shrink-0 space-y-0.5">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={clsx('w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left',
                  activeTab === tab.key ? 'bg-emerald-500/10 text-emerald-400 font-medium' : 'text-slate-400 hover:text-white hover:bg-slate-800/50')}>
                <Icon size={15} />{tab.label}
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <div className="flex-1 max-w-2xl">
          {activeTab === 'organization' && (
            <div className="card p-6 space-y-5">
              <h2 className="text-lg font-semibold text-white">Organization</h2>
              <div className="grid grid-cols-2 gap-4">
                <div><label className={labelCls}>Organization Name</label><input value={orgName} onChange={(e) => setOrgName(e.target.value)} className={inputCls} /></div>
                <div><label className={labelCls}>Slug</label><input value={org?.slug ?? ''} disabled className={clsx(inputCls, 'opacity-50 cursor-not-allowed')} /></div>
                <div><label className={labelCls}>Primary Contact</label><input value={contactName} onChange={(e) => setContactName(e.target.value)} className={inputCls} placeholder="Name" /></div>
                <div><label className={labelCls}>Contact Email</label><input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={inputCls} type="email" /></div>
                <div><label className={labelCls}>Timezone</label>
                  <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputCls}>
                    <option value="America/Chicago">Central (Chicago)</option>
                    <option value="America/New_York">Eastern (New York)</option>
                    <option value="America/Denver">Mountain (Denver)</option>
                    <option value="America/Los_Angeles">Pacific (LA)</option>
                  </select>
                </div>
                <div><label className={labelCls}>Fiscal Year Start</label>
                  <select value={fiscalMonth} onChange={(e) => setFiscalMonth(Number(e.target.value))} className={inputCls}>
                    {Array.from({length:12},(_,i)=>i+1).map((m) => <option key={m} value={m}>{new Date(2000,m-1).toLocaleString('en',{month:'long'})}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'chase' && (
            <div className="card p-6 space-y-5">
              <h2 className="text-lg font-semibold text-white">Receipt Chase Configuration</h2>
              <p className="text-xs text-slate-500">Controls how aggressively MeritBooks chases missing receipts from cardholders.</p>
              <div className="grid grid-cols-2 gap-4">
                <div><label className={labelCls}>First Reminder (minutes after charge)</label><input type="number" value={chaseFirst} onChange={(e) => setChaseFirst(Number(e.target.value))} className={inputCls} min={5} max={1440} /></div>
                <div><label className={labelCls}>Follow-up Interval (minutes)</label><input type="number" value={chaseFollowup} onChange={(e) => setChaseFollowup(Number(e.target.value))} className={inputCls} min={15} max={1440} /></div>
                <div><label className={labelCls}>Escalate to Supervisor After</label><input type="number" value={chaseEscalation} onChange={(e) => setChaseEscalation(Number(e.target.value))} className={inputCls} min={1} max={20} /><span className="text-[10px] text-slate-600">reminders</span></div>
                <div><label className={labelCls}>Channel</label>
                  <select value={chaseChannel} onChange={(e) => setChaseChannel(e.target.value)} className={inputCls}>
                    <option value="PUSH_SMS">Push + SMS</option>
                    <option value="PUSH_ONLY">Push Only</option>
                    <option value="SMS_ONLY">SMS Only</option>
                    <option value="PUSH_SMS_EMAIL">Push + SMS + Email</option>
                  </select>
                </div>
                <div><label className={labelCls}>Quiet Hours Start</label><input type="time" value={chaseQuietStart} onChange={(e) => setChaseQuietStart(e.target.value)} className={inputCls} /></div>
                <div><label className={labelCls}>Quiet Hours End</label><input type="time" value={chaseQuietEnd} onChange={(e) => setChaseQuietEnd(e.target.value)} className={inputCls} /></div>
                <div><label className={labelCls}>Auto-Approve Threshold</label><input type="number" value={chaseAutoApprove / 100} onChange={(e) => setChaseAutoApprove(Math.round(Number(e.target.value) * 100))} className={inputCls} step={5} min={0} /><span className="text-[10px] text-slate-600">receipts under this amount auto-approve</span></div>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="card p-6 space-y-5">
              <h2 className="text-lg font-semibold text-white">AI Categorization Thresholds</h2>
              <p className="text-xs text-slate-500">Controls when AI auto-approves bank feed transactions vs sending them for human review.</p>
              <div className="grid grid-cols-2 gap-4">
                <div><label className={labelCls}>Auto-Approve Confidence (%)</label><input type="number" value={Math.round(aiThreshold * 100)} onChange={(e) => setAiThreshold(Number(e.target.value) / 100)} className={inputCls} min={50} max={100} step={1} /><span className="text-[10px] text-slate-600">≥ this confidence = auto-approve</span></div>
                <div><label className={labelCls}>Max Auto-Approve Amount</label><input type="number" value={aiMaxCents / 100} onChange={(e) => setAiMaxCents(Math.round(Number(e.target.value) * 100))} className={inputCls} min={0} step={100} /><span className="text-[10px] text-slate-600">transactions above this always need review</span></div>
              </div>
              <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 text-xs text-slate-400 space-y-1">
                <p>Current routing: ≥{Math.round(aiThreshold * 100)}% → auto-approve (up to {formatMoney(aiMaxCents)})</p>
                <p>50-{Math.round(aiThreshold * 100)}% → human review queue</p>
                <p>&lt;50% → flagged for investigation</p>
              </div>
            </div>
          )}

          {activeTab === 'companies' && (
            <div className="card p-6 space-y-5">
              <h2 className="text-lg font-semibold text-white">Portfolio Companies</h2>
              <p className="text-xs text-slate-500">{locations.length} entities across {new Set(locations.map((l) => l.industry).filter(Boolean)).size} industries</p>
              <div className="space-y-2">
                {locations.map((loc) => (
                  <div key={loc.id} className="flex items-center gap-3 px-4 py-3 rounded-lg bg-slate-800/30 border border-slate-800">
                    <span className="w-10 h-10 rounded-lg bg-slate-700 text-[10px] font-mono text-slate-300 flex items-center justify-center shrink-0">{loc.short_code}</span>
                    <div className="flex-1">
                      <p className="text-sm text-white font-medium">{loc.name}</p>
                      <p className="text-xs text-slate-500">{loc.industry ?? 'Uncategorized'}</p>
                    </div>
                    <span className={clsx('px-2 py-0.5 rounded text-[10px] font-medium', loc.is_active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-500/10 text-slate-500')}>
                      {loc.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Save bar */}
          <div className="flex items-center justify-between mt-6">
            {saveError && <p className="text-xs text-red-400">{saveError}</p>}
            {saved && <p className="flex items-center gap-1 text-xs text-emerald-400"><Check size={12} /> Settings saved</p>}
            {!saveError && !saved && <div />}
            <button onClick={handleSave} disabled={saving}
              className={clsx('flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
                saving ? 'bg-slate-700 text-slate-500' : 'bg-emerald-600 text-white hover:bg-emerald-500')}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
