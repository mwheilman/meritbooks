'use client';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { CheckCircle, AlertTriangle, FileWarning, Clock, ShieldAlert, FileText, Paperclip } from 'lucide-react';

type ComplianceStatus = 'valid' | 'expired' | 'pending' | 'missing';

interface ComplianceDoc {
  id: string; docType: string; status: string;
  issuedDate: string | null; expirationDate: string | null;
  coverageAmountCents: number | null; hasFile: boolean;
}

interface VenDetail {
  id: string; name: string; legalName: string; email: string | null; phone: string | null;
  website: string | null; addressLine: string | null; paymentTermsDays: number | null;
  is1099: boolean; autoApprove: boolean; taxId: string | null; isActive: boolean; w9Status: string | null;
  compliance: {
    w9: ComplianceStatus; glCoi: ComplianceStatus; wcCoi: ComplianceStatus;
    hasPaymentHold: boolean;
    hold: { type: string; reason: string; endDate: string | null } | null;
  };
  complianceDocs: ComplianceDoc[];
  ap: { openBalance: number; overdueCount: number; openBillCount: number };
  spend: { ytdCents: number; ttmCents: number; lifetimeBilledCents: number; paidYtdCents: number };
  openBills: Array<{ id: string; billNumber: string | null; billDate: string; dueDate: string | null; totalCents: number; balanceCents: number; status: string; daysOverdue: number }>;
  payments: Array<{ id: string; billId: string; billNumber: string | null; paymentDate: string; amountCents: number; method: string | null }>;
  recentBills: Array<{ id: string; billNumber: string | null; billDate: string; totalCents: number; balanceCents: number; status: string }>;
}

const DOC_LABEL: Record<string, string> = { W9: 'W-9', GL_COI: 'GL COI', WC_COI: 'WC COI', WC_EXEMPTION: 'WC Exempt' };

function ComplianceChip({ label, status }: { label: string; status: ComplianceStatus }) {
  const map = {
    valid: { cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', Icon: CheckCircle, text: 'Valid' },
    expired: { cls: 'bg-red-500/10 text-red-400 border-red-500/20', Icon: AlertTriangle, text: 'Expired' },
    pending: { cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20', Icon: Clock, text: 'Pending' },
    missing: { cls: 'bg-slate-700/40 text-slate-400 border-slate-700', Icon: FileWarning, text: 'Missing' },
  }[status];
  const { Icon } = map;
  return (
    <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${map.cls}`}>
      <span className="text-2xs font-semibold uppercase tracking-wider">{label}</span>
      <span className="inline-flex items-center gap-1 text-xs font-medium"><Icon size={13} />{map.text}</span>
    </div>
  );
}

function fmtDate(d: string | null): string {
  if (!d) return '--';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function VendorDrawer({ vendorId, onClose }: { vendorId: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useQuery<VenDetail>(vendorId ? `/api/vendors/${vendorId}` : '', undefined, { enabled: !!vendorId });
  const year = new Date().getFullYear();

  return (
    <DetailDrawer
      open={!!vendorId} onClose={onClose} width="lg"
      title={data?.name ?? 'Vendor'}
      subtitle={data ? [data.is1099 ? '1099 vendor' : null, data.isActive ? 'Active' : 'Inactive'].filter(Boolean).join(' · ') : undefined}
      isLoading={isLoading} error={error}
      headerRight={data?.compliance.hasPaymentHold ? <StatusBadge status="ON_HOLD" /> : undefined}
    >
      {data && (
        <>
          {/* Payment hold banner */}
          {data.compliance.hold && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3">
              <ShieldAlert size={16} className="mt-0.5 shrink-0 text-red-400" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-red-400">
                  Payment hold — {data.compliance.hold.type.replace('_', ' ').toLowerCase()}
                  {data.compliance.hold.endDate ? ` · lifts ${fmtDate(data.compliance.hold.endDate)}` : ' · no end date'}
                </p>
                <p className="text-xs text-red-400/70 mt-0.5">{data.compliance.hold.reason}</p>
              </div>
            </div>
          )}

          {/* Spend metric strip */}
          <div className="mb-6 grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-slate-800/40 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-wider text-slate-500">Open A/P</div>
              <div className="mt-1 text-lg font-mono tabular-nums text-white">{formatMoney(data.ap.openBalance)}</div>
              <div className="text-2xs text-slate-500">
                {data.ap.openBillCount} open{data.ap.overdueCount > 0 && <span className="text-red-400"> · {data.ap.overdueCount} overdue</span>}
              </div>
            </div>
            <div className="rounded-lg bg-slate-800/40 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-wider text-slate-500">{year} Spend</div>
              <div className="mt-1 text-lg font-mono tabular-nums text-white">{formatMoney(data.spend.ytdCents)}</div>
              <div className="text-2xs text-slate-500">{formatMoney(data.spend.paidYtdCents, { compact: true })} paid</div>
            </div>
            <div className="rounded-lg bg-slate-800/40 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-wider text-slate-500">Trailing 12mo</div>
              <div className="mt-1 text-lg font-mono tabular-nums text-white">{formatMoney(data.spend.ttmCents)}</div>
              <div className="text-2xs text-slate-500">billed</div>
            </div>
          </div>

          {/* Compliance chips */}
          <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Compliance</h3>
          <div className="mb-6 grid grid-cols-3 gap-2">
            <ComplianceChip label="W-9" status={data.compliance.w9} />
            <ComplianceChip label="GL COI" status={data.compliance.glCoi} />
            <ComplianceChip label="WC COI" status={data.compliance.wcCoi} />
          </div>

          {/* Compliance documents */}
          {data.complianceDocs.length > 0 && (
            <div className="mb-6">
              <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Documents on file</h3>
              <div className="rounded-lg bg-slate-800/30 divide-y divide-slate-800/50">
                {data.complianceDocs.map((d) => (
                  <div key={d.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                    <span className="inline-flex items-center gap-2 text-sm text-slate-200 min-w-0">
                      <FileText size={14} className="text-slate-500 shrink-0" />
                      <span className="truncate">{DOC_LABEL[d.docType] ?? d.docType}</span>
                      {d.hasFile && <Paperclip size={11} className="text-slate-600 shrink-0" />}
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      {d.coverageAmountCents != null && (
                        <span className="text-xs font-mono tabular-nums text-slate-400">{formatMoney(d.coverageAmountCents, { compact: true })}</span>
                      )}
                      {d.expirationDate && <span className="text-2xs text-slate-500">exp {fmtDate(d.expirationDate)}</span>}
                      <StatusBadge status={d.status} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Open bills */}
          <div className="mb-6">
            <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Open bills</h3>
            {data.openBills.length === 0 ? (
              <div className="rounded-lg bg-slate-800/30 px-4 py-6 text-center text-xs text-slate-500">No open bills — vendor is fully paid.</div>
            ) : (
              <DetailTable columns={[
                { key: 'n', label: 'Bill' }, { key: 'due', label: 'Due' },
                { key: 'b', label: 'Balance', align: 'right' }, { key: 's', label: 'Status', align: 'center' },
              ]}>
                {data.openBills.map((b) => (
                  <tr key={b.id}>
                    <td className="px-3 py-2 text-sm font-mono text-slate-300">{b.billNumber ?? '--'}</td>
                    <td className="px-3 py-2 text-xs font-mono text-slate-400">
                      {fmtDate(b.dueDate)}
                      {b.daysOverdue > 0 && <span className="ml-1.5 text-2xs text-red-400">{b.daysOverdue}d past</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(b.balanceCents)}</td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={b.status} /></td>
                  </tr>
                ))}
              </DetailTable>
            )}
          </div>

          {/* Payment history */}
          <div className="mb-6">
            <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Payment history</h3>
            {data.payments.length === 0 ? (
              <div className="rounded-lg bg-slate-800/30 px-4 py-6 text-center text-xs text-slate-500">No payments recorded for this vendor.</div>
            ) : (
              <DetailTable columns={[
                { key: 'd', label: 'Paid' }, { key: 'n', label: 'Bill' },
                { key: 'm', label: 'Method' }, { key: 'a', label: 'Amount', align: 'right' },
              ]}>
                {data.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2 text-xs font-mono text-slate-400">{fmtDate(p.paymentDate)}</td>
                    <td className="px-3 py-2 text-sm font-mono text-slate-300">{p.billNumber ?? '--'}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{p.method ?? '--'}</td>
                    <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-emerald-400">{formatMoney(p.amountCents)}</td>
                  </tr>
                ))}
              </DetailTable>
            )}
          </div>

          {/* Identity / terms */}
          <DetailSection title="Contact & terms">
            <DetailField label="Legal name" value={data.legalName} />
            <DetailField label="Email" value={data.email ?? '--'} />
            <DetailField label="Phone" value={data.phone ?? '--'} />
            {data.website && <DetailField label="Website" value={data.website} />}
            {data.addressLine && <DetailField label="Address" value={data.addressLine} />}
            <DetailField label="Payment terms" value={data.paymentTermsDays != null ? `Net ${data.paymentTermsDays}` : '--'} />
            <DetailField label="1099 eligible" value={data.is1099 ? 'Yes' : 'No'} />
            <DetailField label="Auto-approve" value={data.autoApprove ? 'Yes' : 'No'} />
            <DetailField label="Lifetime billed" value={formatMoney(data.spend.lifetimeBilledCents)} mono />
          </DetailSection>
        </>
      )}
    </DetailDrawer>
  );
}
