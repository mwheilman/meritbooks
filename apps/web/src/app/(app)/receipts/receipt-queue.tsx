'use client';

import { useState } from 'react';
import { Check, Flag, Pencil, Camera, Mail, Upload, Bell, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, ConfidenceBar } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

interface ReceiptItem {
  id: string;
  vendorName: string;
  amountCents: number;
  date: string;
  source: 'MOBILE_CAPTURE' | 'EMAIL' | 'MANUAL_UPLOAD';
  status: string;
  aiAccount: string;
  aiConfidence: number;
  locationName: string;
  locationCode: string;
  submittedBy: string;
  chaseCount: number;
  imageUrl: string; // placeholder
  extractedData: {
    vendor: string;
    total: string;
    date: string;
    items: string[];
    tax: string;
    paymentMethod: string;
  };
}

const SOURCE_ICONS = {
  MOBILE_CAPTURE: { icon: Camera, label: 'Mobile' },
  EMAIL: { icon: Mail, label: 'Email' },
  MANUAL_UPLOAD: { icon: Upload, label: 'Upload' },
};

const DEMO_RECEIPTS: ReceiptItem[] = [
  {
    id: '1', vendorName: 'Menards', amountCents: 34218, date: '2026-04-03', source: 'MOBILE_CAPTURE',
    status: 'CATEGORIZED', aiAccount: '5100 · Materials', aiConfidence: 0.94,
    locationName: 'Swan Creek Construction', locationCode: 'SCC', submittedBy: 'Jake T.', chaseCount: 0,
    imageUrl: '', extractedData: { vendor: 'Menards #3344', total: '$342.18', date: '04/03/2026', items: ['2x4 Lumber x24', 'Drywall Screws 5lb', 'Joint Compound'], tax: '$21.42', paymentMethod: 'Visa ·4418' },
  },
  {
    id: '2', vendorName: 'Shell', amountCents: 6842, date: '2026-04-02', source: 'MOBILE_CAPTURE',
    status: 'CATEGORIZED', aiAccount: '6200 · Fuel', aiConfidence: 0.97,
    locationName: 'Merit Management', locationCode: 'MMG', submittedBy: 'Carlos R.', chaseCount: 0,
    imageUrl: '', extractedData: { vendor: 'Shell Oil 0087234', total: '$68.42', date: '04/02/2026', items: ['Regular Unleaded 18.2gal'], tax: '$0.00', paymentMethod: 'Visa ·8820' },
  },
  {
    id: '3', vendorName: 'Home Depot', amountCents: 24599, date: '2026-04-01', source: 'EMAIL',
    status: 'PENDING', aiAccount: '5120 · Supplies', aiConfidence: 0.82,
    locationName: 'Heartland HVAC', locationCode: 'HH', submittedBy: 'Email Parser', chaseCount: 0,
    imageUrl: '', extractedData: { vendor: 'The Home Depot #2891', total: '$245.99', date: '04/01/2026', items: ['Copper Fittings Assorted', 'PVC Pipe 3" x10', 'Teflon Tape 12pk'], tax: '$15.38', paymentMethod: 'Amex ·1002' },
  },
  {
    id: '4', vendorName: 'Unknown', amountCents: 18944, date: '2026-03-31', source: 'MOBILE_CAPTURE',
    status: 'FLAGGED', aiAccount: '', aiConfidence: 0.31,
    locationName: 'Dorrian Mechanical', locationCode: 'DM', submittedBy: 'Tyler B.', chaseCount: 0,
    imageUrl: '', extractedData: { vendor: 'ILLEGIBLE', total: '$189.44', date: '03/31/2026', items: ['Cannot parse line items'], tax: '?', paymentMethod: 'Unknown' },
  },
];

// Chase queue — missing receipts
const CHASE_ITEMS = [
  { cardHolder: 'Jake T.', vendor: 'Casey\'s General', amount: 4218, card: '·4418', date: '04/02', chaseCount: 2, nextChase: '15min' },
  { cardHolder: 'Marcus W.', vendor: 'Grainger', amount: 34200, card: '·7712', date: '04/01', chaseCount: 5, nextChase: 'Escalated' },
  { cardHolder: 'Tyler B.', vendor: 'Fastenal', amount: 8940, card: '·3301', date: '03/30', chaseCount: 8, nextChase: 'Supervisor notified' },
];

export function ReceiptQueue() {
  const [selectedId, setSelectedId] = useState<string>(DEMO_RECEIPTS[0].id);
  const selected = DEMO_RECEIPTS.find((r) => r.id === selectedId) ?? DEMO_RECEIPTS[0];

  return (
    <div className="space-y-6">
      {/* Chase alerts */}
      <div className="card">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell size={14} className="text-amber-400" />
            <h3 className="text-sm font-semibold text-white">Missing Receipt Chase</h3>
          </div>
          <span className="text-2xs text-amber-400">{CHASE_ITEMS.length} outstanding</span>
        </div>
        <div className="divide-y divide-slate-800/30">
          {CHASE_ITEMS.map((item, i) => (
            <div key={i} className="px-5 py-2.5 flex items-center gap-4 table-row-hover">
              <span className="text-sm text-slate-300 w-24">{item.cardHolder}</span>
              <span className="text-sm text-slate-400 flex-1">{item.vendor}</span>
              <span className="text-sm font-mono tabular-nums text-slate-300">{formatMoney(item.amount)}</span>
              <span className="text-2xs text-slate-500">{item.card} · {item.date}</span>
              <span className={clsx(
                'text-2xs font-medium',
                item.chaseCount >= 5 ? 'text-red-400' : 'text-amber-400',
              )}>
                {item.chaseCount} reminders · {item.nextChase}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Split view: list + detail */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Receipt list */}
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-white">Queue ({DEMO_RECEIPTS.length})</h3>
          </div>
          <div className="divide-y divide-slate-800/30">
            {DEMO_RECEIPTS.map((r) => {
              const SourceIcon = SOURCE_ICONS[r.source].icon;
              return (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={clsx(
                    'w-full px-5 py-3 flex items-center gap-3 text-left transition-colors',
                    selectedId === r.id ? 'bg-brand-500/[0.06] border-l-2 border-brand-500' : 'hover:bg-white/[0.02] border-l-2 border-transparent',
                  )}
                >
                  <SourceIcon size={14} className="text-slate-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-200 truncate">{r.vendorName}</span>
                      <span className="text-sm font-mono tabular-nums text-slate-300 ml-2">{formatMoney(r.amountCents)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-2xs text-slate-500">{r.locationCode} · {r.date}</span>
                      <StatusBadge status={r.status} />
                    </div>
                  </div>
                  <ChevronRight size={14} className="text-slate-600 shrink-0" />
                </button>
              );
            })}
          </div>
        </div>

        {/* Receipt detail */}
        <div className="lg:col-span-3 card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Receipt Detail</h3>
            <div className="flex items-center gap-2">
              <button className="btn-ghost btn-sm"><Pencil size={12} /> Edit</button>
              <button className="btn-ghost btn-sm text-amber-400"><Flag size={12} /> Flag</button>
              <button className="btn-primary btn-sm"><Check size={12} /> Approve</button>
            </div>
          </div>

          <div className="grid grid-cols-2 divide-x divide-slate-800">
            {/* Image preview (placeholder) */}
            <div className="p-6 flex items-center justify-center bg-slate-900/50 min-h-[400px]">
              <div className="text-center">
                <Camera size={48} className="text-slate-700 mx-auto mb-3" />
                <p className="text-sm text-slate-500">Receipt image preview</p>
                <p className="text-2xs text-slate-600 mt-1">
                  {SOURCE_ICONS[selected.source].label} · {selected.submittedBy}
                </p>
              </div>
            </div>

            {/* Extracted data */}
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">AI Confidence</span>
                <ConfidenceBar value={selected.aiConfidence} size="md" className="w-32" />
              </div>

              <div className="space-y-3">
                <Field label="Vendor" value={selected.extractedData.vendor} />
                <Field label="Total" value={selected.extractedData.total} />
                <Field label="Date" value={selected.extractedData.date} />
                <Field label="Payment" value={selected.extractedData.paymentMethod} />
                <Field label="Tax" value={selected.extractedData.tax} />
                <div>
                  <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Line Items</label>
                  <ul className="space-y-1">
                    {selected.extractedData.items.map((item, i) => (
                      <li key={i} className="text-sm text-slate-300 pl-3 border-l-2 border-slate-800">{item}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="border-t border-slate-800 pt-4 space-y-3">
                <div>
                  <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">GL Account</label>
                  <select className="input" defaultValue={selected.aiAccount || ''}>
                    <option value="">Select account...</option>
                    <option value="5100">5100 · Materials</option>
                    <option value="5120">5120 · Supplies</option>
                    <option value="6200">6200 · Fuel</option>
                    <option value="6600">6600 · Office Supplies</option>
                  </select>
                </div>
                <div>
                  <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-1">Company</label>
                  <input className="input" value={selected.locationName} readOnly />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="text-2xs text-slate-500 uppercase tracking-wider font-semibold block mb-0.5">{label}</label>
      <p className="text-sm text-slate-200">{value}</p>
    </div>
  );
}
