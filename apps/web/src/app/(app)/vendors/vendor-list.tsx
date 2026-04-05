'use client';

import { useState } from 'react';
import { Search, Shield, AlertTriangle, CheckCircle, FileWarning } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge, ConfidenceBar } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';

interface VendorRow {
  id: string;
  name: string;
  defaultAccount: string;
  aiConfidence: number;
  autoApprove: boolean;
  txnCount: number;
  ytdSpendCents: number;
  is1099: boolean;
  w9Status: string;
  glCoiStatus: string;
  wcCoiStatus: string;
  companiesUsing: number;
  hasPaymentHold: boolean;
}

const DEMO_VENDORS: VendorRow[] = [
  { id: '1', name: 'Menards', defaultAccount: '5100 · Materials', aiConfidence: 0.96, autoApprove: true, txnCount: 234, ytdSpendCents: 14200000, is1099: false, w9Status: 'VERIFIED', glCoiStatus: 'VALID', wcCoiStatus: 'VALID', companiesUsing: 8, hasPaymentHold: false },
  { id: '2', name: 'Carrier HVAC', defaultAccount: '5110 · Equipment', aiConfidence: 0.98, autoApprove: true, txnCount: 42, ytdSpendCents: 82400000, is1099: false, w9Status: 'VERIFIED', glCoiStatus: 'VALID', wcCoiStatus: 'VALID', companiesUsing: 3, hasPaymentHold: false },
  { id: '3', name: "Lowe's", defaultAccount: '5120 · Supplies', aiConfidence: 0.89, autoApprove: false, txnCount: 186, ytdSpendCents: 8400000, is1099: false, w9Status: 'VERIFIED', glCoiStatus: 'VALID', wcCoiStatus: 'N/A', companiesUsing: 12, hasPaymentHold: false },
  { id: '4', name: 'ABC Electric', defaultAccount: '5010 · Subcontractor', aiConfidence: 0.92, autoApprove: false, txnCount: 28, ytdSpendCents: 4800000, is1099: true, w9Status: 'VERIFIED', glCoiStatus: 'EXPIRED', wcCoiStatus: 'VALID', companiesUsing: 4, hasPaymentHold: true },
  { id: '5', name: 'ADP', defaultAccount: '6000 · Salaries', aiConfidence: 0.99, autoApprove: true, txnCount: 24, ytdSpendCents: 148700000, is1099: false, w9Status: 'VERIFIED', glCoiStatus: 'N/A', wcCoiStatus: 'N/A', companiesUsing: 17, hasPaymentHold: false },
  { id: '6', name: 'Microsoft', defaultAccount: '6300 · Software', aiConfidence: 0.99, autoApprove: true, txnCount: 12, ytdSpendCents: 2880000, is1099: false, w9Status: 'VERIFIED', glCoiStatus: 'N/A', wcCoiStatus: 'N/A', companiesUsing: 17, hasPaymentHold: false },
  { id: '7', name: 'Smith Plumbing Co', defaultAccount: '5010 · Subcontractor', aiConfidence: 0.78, autoApprove: false, txnCount: 6, ytdSpendCents: 1240000, is1099: true, w9Status: 'MISSING', glCoiStatus: 'MISSING', wcCoiStatus: 'MISSING', companiesUsing: 2, hasPaymentHold: true },
  { id: '8', name: 'Shell', defaultAccount: '6200 · Fuel', aiConfidence: 0.94, autoApprove: true, txnCount: 340, ytdSpendCents: 4200000, is1099: false, w9Status: 'N/A', glCoiStatus: 'N/A', wcCoiStatus: 'N/A', companiesUsing: 15, hasPaymentHold: false },
];

function ComplianceIcon({ status }: { status: string }) {
  if (status === 'VALID' || status === 'VERIFIED') return <CheckCircle size={14} className="text-emerald-400" />;
  if (status === 'EXPIRED') return <AlertTriangle size={14} className="text-amber-400" />;
  if (status === 'MISSING') return <FileWarning size={14} className="text-red-400" />;
  return <span className="text-2xs text-slate-600">—</span>;
}

export function VendorList() {
  const [search, setSearch] = useState('');

  const filtered = DEMO_VENDORS.filter((v) =>
    v.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search vendors..."
            className="input pl-9"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>{filtered.length} vendors</span>
          <span className="text-slate-700">·</span>
          <span className="text-red-400">{filtered.filter((v) => v.hasPaymentHold).length} on hold</span>
          <span className="text-slate-700">·</span>
          <span className="text-amber-400">{filtered.filter((v) => v.is1099).length} 1099-eligible</span>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Vendor</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500">Default GL</th>
              <th className="px-4 py-3 text-left text-2xs font-semibold uppercase tracking-wider text-slate-500 w-28">AI Confidence</th>
              <th className="px-4 py-3 text-right text-2xs font-semibold uppercase tracking-wider text-slate-500">YTD Spend</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Txns</th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500" title="W-9 / GL COI / WC COI">
                <Shield size={12} className="inline" /> Compliance
              </th>
              <th className="px-4 py-3 text-center text-2xs font-semibold uppercase tracking-wider text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {filtered.map((v) => (
              <tr key={v.id} className="table-row-hover cursor-pointer">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-slate-200">{v.name}</p>
                    {v.is1099 && (
                      <span className="text-2xs text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full">1099</span>
                    )}
                  </div>
                  <p className="text-2xs text-slate-500 mt-0.5">{v.companiesUsing} companies</p>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs font-mono text-slate-400">{v.defaultAccount}</span>
                </td>
                <td className="px-4 py-3">
                  <ConfidenceBar value={v.aiConfidence} />
                  {v.autoApprove && (
                    <span className="text-2xs text-emerald-500 mt-0.5 block">Auto-approve</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-sm font-mono tabular-nums text-slate-200">
                    {formatMoney(v.ytdSpendCents, { compact: true })}
                  </span>
                </td>
                <td className="px-4 py-3 text-center text-sm text-slate-400">{v.txnCount}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-center gap-1.5">
                    <ComplianceIcon status={v.w9Status} />
                    <ComplianceIcon status={v.glCoiStatus} />
                    <ComplianceIcon status={v.wcCoiStatus} />
                  </div>
                </td>
                <td className="px-4 py-3 text-center">
                  {v.hasPaymentHold ? (
                    <StatusBadge status="ON_HOLD" />
                  ) : (
                    <StatusBadge status="ACTIVE" variant="success" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
