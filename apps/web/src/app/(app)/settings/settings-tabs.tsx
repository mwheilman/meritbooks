'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { Building2, Link2, Bell, Shield, Sparkles } from 'lucide-react';

const TABS = [
  { key: 'org', label: 'Organization', icon: Building2 },
  { key: 'integrations', label: 'Integrations', icon: Link2 },
  { key: 'chase', label: 'Receipt Chase', icon: Bell },
  { key: 'security', label: 'Security', icon: Shield },
  { key: 'ai', label: 'AI Usage', icon: Sparkles },
] as const;

type TabKey = typeof TABS[number]['key'];

export function SettingsTabs() {
  const [activeTab, setActiveTab] = useState<TabKey>('org');

  return (
    <div className="flex gap-6">
      {/* Sidebar nav */}
      <nav className="w-48 shrink-0">
        <ul className="space-y-0.5">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <li key={tab.key}>
                <button
                  onClick={() => setActiveTab(tab.key)}
                  className={clsx(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
                    activeTab === tab.key
                      ? 'bg-brand-500/10 text-brand-400 font-medium'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
                  )}
                >
                  <Icon size={16} />
                  {tab.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Content */}
      <div className="flex-1">
        {activeTab === 'org' && <OrgSettings />}
        {activeTab === 'integrations' && <IntegrationSettings />}
        {activeTab === 'chase' && <ChaseSettings />}
        {activeTab === 'security' && <SecuritySettings />}
        {activeTab === 'ai' && <AIUsageSettings />}
      </div>
    </div>
  );
}

function OrgSettings() {
  return (
    <div className="card p-6 space-y-6">
      <h3 className="text-sm font-semibold text-white">Organization</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Name</label>
          <input className="input" defaultValue="Merit Management Group" />
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Primary Contact</label>
          <input className="input" defaultValue="Mike Wheilman" />
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Email</label>
          <input className="input" defaultValue="mike@meritmanagement.com" />
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Timezone</label>
          <select className="input" defaultValue="America/Chicago">
            <option>America/Chicago</option>
            <option>America/New_York</option>
            <option>America/Denver</option>
            <option>America/Los_Angeles</option>
          </select>
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Fiscal Year Start</label>
          <select className="input" defaultValue="1">
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {new Date(2026, i).toLocaleDateString('en-US', { month: 'long' })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary btn-sm">Save Changes</button>
      </div>
    </div>
  );
}

function IntegrationSettings() {
  const integrations = [
    { name: 'Plaid', description: 'Bank account connections for all entities', status: 'Connected', count: '14 accounts across 8 entities' },
    { name: 'Microsoft 365', description: 'Email sync for receipt and bill ingestion', status: 'Connected', count: '2 inboxes monitored' },
    { name: 'ADP', description: 'Payroll data import', status: 'Connected', count: 'Bi-weekly sync' },
    { name: 'Clerk', description: 'Authentication and user management', status: 'Active', count: '8 users' },
    { name: 'ClickUp', description: 'PM tool sync for time tracking', status: 'Not Connected', count: null },
  ];

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800">
        <h3 className="text-sm font-semibold text-white">Integrations</h3>
      </div>
      <div className="divide-y divide-slate-800/30">
        {integrations.map((int) => (
          <div key={int.name} className="px-6 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-200">{int.name}</p>
              <p className="text-2xs text-slate-500 mt-0.5">{int.description}</p>
              {int.count && <p className="text-2xs text-slate-400 mt-0.5">{int.count}</p>}
            </div>
            <button className={clsx(
              'btn-sm',
              int.status === 'Not Connected' ? 'btn-primary' : 'btn-secondary',
            )}>
              {int.status === 'Not Connected' ? 'Connect' : 'Configure'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChaseSettings() {
  return (
    <div className="card p-6 space-y-6">
      <h3 className="text-sm font-semibold text-white">Receipt Chase Configuration</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">First Reminder</label>
          <select className="input" defaultValue="30">
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
            <option value="240">4 hours</option>
          </select>
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Follow-up Interval</label>
          <select className="input" defaultValue="120">
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
            <option value="240">4 hours</option>
          </select>
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Escalation After</label>
          <select className="input" defaultValue="3">
            <option value="3">3 reminders</option>
            <option value="5">5 reminders</option>
            <option value="10">10 reminders</option>
          </select>
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Channel</label>
          <select className="input" defaultValue="PUSH_SMS">
            <option value="PUSH_SMS">Push + SMS</option>
            <option value="PUSH_ONLY">Push only</option>
            <option value="SMS_ONLY">SMS only</option>
            <option value="PUSH_SMS_EMAIL">Push + SMS + Email</option>
          </select>
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Auto-Approve Under</label>
          <select className="input" defaultValue="2500">
            <option value="1000">$10.00</option>
            <option value="2500">$25.00</option>
            <option value="5000">$50.00</option>
            <option value="10000">$100.00</option>
          </select>
        </div>
        <div>
          <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Quiet Hours</label>
          <div className="flex items-center gap-2">
            <input type="time" className="input flex-1" defaultValue="21:00" />
            <span className="text-slate-500">to</span>
            <input type="time" className="input flex-1" defaultValue="06:00" />
          </div>
        </div>
      </div>
      <p className="text-2xs text-slate-500">
        Chase never stops until receipt is submitted. Escalation notifies supervisor after threshold.
      </p>
      <div className="flex justify-end">
        <button className="btn-primary btn-sm">Save Chase Settings</button>
      </div>
    </div>
  );
}

function SecuritySettings() {
  return (
    <div className="card p-6 space-y-4">
      <h3 className="text-sm font-semibold text-white">Security</h3>
      <div className="space-y-3">
        <SettingRow label="AI Auto-Approve Threshold" value="85%" description="Transactions above this confidence with trusted vendors auto-approve" />
        <SettingRow label="AI Auto-Approve Max Amount" value="$10,000" description="Maximum transaction amount eligible for auto-approval" />
        <SettingRow label="Session Timeout" value="30 minutes" description="Inactive sessions are automatically ended" />
        <SettingRow label="Two-Factor Authentication" value="Enforced via Clerk" description="All users must have 2FA enabled" />
      </div>
    </div>
  );
}

function AIUsageSettings() {
  const features = [
    { name: 'Transaction Categorization', calls: 1248, cost: 4280 },
    { name: 'OCR / Document Extraction', calls: 342, cost: 2840 },
    { name: 'Cash Forecasting', calls: 62, cost: 1200 },
    { name: 'CPA Desk', calls: 28, cost: 980 },
    { name: 'Compliance Monitoring', calls: 17, cost: 340 },
    { name: 'System Console', calls: 8, cost: 120 },
  ];

  const totalCost = features.reduce((s, f) => s + f.cost, 0);

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">AI Usage — March 2026</h3>
        <span className="text-sm font-mono text-brand-400">${(totalCost / 100).toFixed(2)}/mo</span>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-800">
            <th className="px-6 py-2.5 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Feature</th>
            <th className="px-4 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">API Calls</th>
            <th className="px-6 py-2.5 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">Est. Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/30">
          {features.map((f) => (
            <tr key={f.name} className="table-row-hover">
              <td className="px-6 py-2.5 text-sm text-slate-300">{f.name}</td>
              <td className="px-4 py-2.5 text-right text-sm font-mono tabular-nums text-slate-400">{f.calls.toLocaleString()}</td>
              <td className="px-6 py-2.5 text-right text-sm font-mono tabular-nums text-slate-300">${(f.cost / 100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-700">
            <td className="px-6 py-2.5 text-sm font-medium text-white">Total</td>
            <td className="px-4 py-2.5 text-right text-sm font-mono tabular-nums text-white">{features.reduce((s, f) => s + f.calls, 0).toLocaleString()}</td>
            <td className="px-6 py-2.5 text-right text-sm font-mono tabular-nums text-brand-400 font-medium">${(totalCost / 100).toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
      <div className="px-6 py-3 border-t border-slate-800 text-2xs text-slate-500">
        Cache hit rate: 82% · Target: 80%+ · Model: Claude Opus 4.6
      </div>
    </div>
  );
}

function SettingRow({ label, value, description }: { label: string; value: string; description: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-800/30 last:border-0">
      <div>
        <p className="text-sm text-slate-200">{label}</p>
        <p className="text-2xs text-slate-500">{description}</p>
      </div>
      <span className="text-sm font-mono text-slate-300">{value}</span>
    </div>
  );
}
