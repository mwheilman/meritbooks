'use client';
import { useState } from 'react';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { CheckCircle, AlertTriangle, FileWarning, Clock, ShieldAlert, FileText, Paperclip, UploadCloud, ShieldCheck, Copy, Landmark, CreditCard, BadgeCheck, BadgeAlert } from 'lucide-react';
import { VendorDocIntake } from './vendor-doc-intake';

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
  ap: {
    openBalance: number; overdueCount: number; openBillCount: number;
    aging: { currentCents: number; d1_30Cents: number; d31_60Cents: number; d61_90Cents: number; d90PlusCents: number };
  };
  spend: { ytdCents: number; ttmCents: number; lifetimeBilledCents: number; paidYtdCents: number };
  ten99: {
    eligible: boolean; reportable: boolean; crossedThreshold: boolean;
    reportableYtdCents: number; thresholdCents: number;
    tinPresent: boolean; missingTin: boolean;
    w9State: 'on_file' | 'missing' | 'expired';
    readiness: 'READY' | 'MISSING_W9' | 'NOT_MARKED_1099';
  };
  paymentProfile: {
    method: string; accountType: string | null; accountMask: string | null;
    routingMask: string | null; bankName: string | null; hasBankDetails: boolean;
  } | null;
  openBills: Array<{ id: string; billNumber: string | null; billDate: string; dueDate: string | null; totalCents: number; balanceCents: number; status: string; daysOverdue: number }>;
  payments: Array<{ id: string; billId: string; billNumber: string | null; paymentDate: string; amountCents: number; method: string | null }>;
  recentBills: Array<{ id: string; billNumber: string | null; billDate: string; totalCents: number; balanceCents: number; status: string }>;
  possibleDuplicates: Array<{ id: string; name: string; confidence: number; matchedFields: string[]; reason: string; amountAtRiskCents: number }>;
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

const AGING_BUCKETS = [
  { key: 'currentCents', label: 'Current', cls: 'bg-emerald-500', text: 'text-emerald-400' },
  { key: 'd1_30Cents', label: '1–30', cls: 'bg-amber-400', text: 'text-amber-300' },
  { key: 'd31_60Cents', label: '31–60', cls: 'bg-amber-500', text: 'text-amber-400' },
  { key: 'd61_90Cents', label: '61–90', cls: 'bg-orange-500', text: 'text-orange-400' },
  { key: 'd90PlusCents', label: '90+', cls: 'bg-red-500', text: 'text-red-400' },
] as const;

/** A compact stacked bar + legend of this vendor's open A/P by days past due. */
function AgingBar({ aging, total }: { aging: VenDetail['ap']['aging']; total: number }) {
  if (total <= 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Open A/P aging</h3>
        <span className="text-2xs font-mono tabular-nums text-slate-400">{formatMoney(total)}</span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-800">
        {AGING_BUCKETS.map((b) => {
          const cents = aging[b.key];
          if (cents <= 0) return null;
          return <div key={b.key} className={b.cls} style={{ width: `${(cents / total) * 100}%` }} title={`${b.label}: ${formatMoney(cents)}`} />;
        })}
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1">
        {AGING_BUCKETS.map((b) => (
          <div key={b.key} className="text-center">
            <div className="text-[10px] uppercase tracking-wide text-slate-600">{b.label}</div>
            <div className={`text-xs font-mono tabular-nums ${aging[b.key] > 0 ? b.text : 'text-slate-600'}`}>
              {formatMoney(aging[b.key], { compact: true })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const READINESS_META: Record<VenDetail['ten99']['readiness'], { text: string; cls: string }> = {
  READY: { text: 'Ready to file', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  MISSING_W9: { text: 'Missing W-9 / TIN', cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
  NOT_MARKED_1099: { text: 'Not marked 1099', cls: 'bg-slate-700/40 text-slate-400 border-slate-700' },
};

export function VendorDrawer({ vendorId, onClose }: { vendorId: string | null; onClose: () => void }) {
  const { data, isLoading, error, refetch } = useQuery<VenDetail>(vendorId ? `/api/vendors/${vendorId}` : '', undefined, { enabled: !!vendorId });
  const [intake, setIntake] = useState<'W9' | 'COI' | null>(null);
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

          {/* Open A/P aging (this vendor's slice of the A/P-aging report) */}
          {data.ap.openBalance > 0 && (
            <div className="mb-6">
              <AgingBar aging={data.ap.aging} total={data.ap.openBalance} />
            </div>
          )}

          {/* 1099 status + payment method on file — read-only at-a-glance row */}
          <div className="mb-6 grid grid-cols-2 gap-3">
            {/* 1099 status (read-only; nothing is filed from here) */}
            <div className="rounded-lg border border-slate-800 bg-slate-800/30 px-3 py-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">1099 status</span>
                {data.ten99.eligible
                  ? <BadgeCheck size={13} className="text-indigo-400" />
                  : <BadgeAlert size={13} className="text-slate-600" />}
              </div>
              <div className="flex items-center gap-1.5 mb-1">
                <span className={`text-sm font-medium ${data.ten99.reportable ? 'text-white' : 'text-slate-300'}`}>
                  {data.ten99.reportable ? 'Reportable' : data.ten99.eligible ? 'Not reportable' : 'Not 1099'}
                </span>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-2xs font-medium ${READINESS_META[data.ten99.readiness].cls}`}>
                  {READINESS_META[data.ten99.readiness].text}
                </span>
              </div>
              <div className="text-2xs text-slate-500">
                {formatMoney(data.ten99.reportableYtdCents, { compact: true })} reportable YTD
                {' · '}floor {formatMoney(data.ten99.thresholdCents, { compact: true })}
              </div>
              {data.ten99.missingTin && (
                <div className="mt-1 inline-flex items-center gap-1 text-2xs text-red-400">
                  <AlertTriangle size={10} /> No TIN on file
                </div>
              )}
            </div>

            {/* Payment method on file (masked; raw bank numbers are never stored) */}
            <div className="rounded-lg border border-slate-800 bg-slate-800/30 px-3 py-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-2xs uppercase tracking-wider text-slate-500 font-semibold">Payment method</span>
                {data.paymentProfile?.method === 'CHECK'
                  ? <FileText size={13} className="text-slate-500" />
                  : data.paymentProfile
                    ? <Landmark size={13} className="text-emerald-400" />
                    : <CreditCard size={13} className="text-slate-600" />}
              </div>
              {data.paymentProfile ? (
                <>
                  <div className="text-sm font-medium text-white">
                    {data.paymentProfile.method === 'CHECK' ? 'Check' : 'ACH'}
                    {data.paymentProfile.accountType && <span className="text-slate-400 font-normal"> · {data.paymentProfile.accountType}</span>}
                  </div>
                  <div className="text-2xs text-slate-500">
                    {data.paymentProfile.accountMask
                      ? <>acct <span className="font-mono text-slate-400">{data.paymentProfile.accountMask}</span>{data.paymentProfile.bankName ? ` · ${data.paymentProfile.bankName}` : ''}</>
                      : data.paymentProfile.bankName ?? 'Pays to mailing address'}
                  </div>
                  {!data.paymentProfile.hasBankDetails && (
                    <div className="mt-1 inline-flex items-center gap-1 text-2xs text-amber-400">
                      <AlertTriangle size={10} /> Incomplete for remittance
                    </div>
                  )}
                </>
              ) : (
                <div className="text-xs text-slate-500">No payment details captured.</div>
              )}
            </div>
          </div>

          {/* Compliance chips + drop-and-parse intake */}
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">Compliance</h3>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setIntake('W9')}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800/40 px-2 py-1 text-2xs font-medium text-slate-300 hover:text-white hover:border-slate-600"
              >
                <UploadCloud size={12} /> Upload W-9
              </button>
              <button
                onClick={() => setIntake('COI')}
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800/40 px-2 py-1 text-2xs font-medium text-slate-300 hover:text-white hover:border-slate-600"
              >
                <ShieldCheck size={12} /> Upload COI
              </button>
            </div>
          </div>
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

          {/* Recent bills — full history slice with status (paid + open). */}
          {data.recentBills.length > 0 && (
            <div className="mb-6">
              <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold mb-2">Recent bills</h3>
              <DetailTable columns={[
                { key: 'n', label: 'Bill' }, { key: 'd', label: 'Date' },
                { key: 't', label: 'Total', align: 'right' }, { key: 'b', label: 'Balance', align: 'right' },
                { key: 's', label: 'Status', align: 'center' },
              ]}>
                {data.recentBills.map((b) => (
                  <tr key={b.id}>
                    <td className="px-3 py-2 text-sm font-mono text-slate-300">{b.billNumber ?? '--'}</td>
                    <td className="px-3 py-2 text-xs font-mono text-slate-400">{fmtDate(b.billDate)}</td>
                    <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-200">{formatMoney(b.totalCents)}</td>
                    <td className="px-3 py-2 text-right text-sm font-mono tabular-nums text-slate-400">{formatMoney(b.balanceCents)}</td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={b.status} /></td>
                  </tr>
                ))}
              </DetailTable>
            </div>
          )}

          {/* Possible duplicate vendors — read-only detection (no auto-merge). */}
          {data.possibleDuplicates && data.possibleDuplicates.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-2">
                <Copy size={13} className="text-amber-400" />
                <h3 className="text-2xs text-slate-500 uppercase tracking-wider font-semibold">
                  Possible duplicates ({data.possibleDuplicates.length})
                </h3>
              </div>
              <p className="mb-2 text-2xs text-slate-500">
                Vendors that look like the same payee under two masters — this fragments spend, 1099
                totals, and payment holds. Review and consolidate manually; nothing is merged
                automatically.
              </p>
              <div className="space-y-2">
                {data.possibleDuplicates.map((d) => (
                  <div key={d.id} className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-200 truncate">{d.name}</span>
                      <span className="shrink-0 text-2xs font-mono text-amber-300">{Math.round(d.confidence * 100)}% match</span>
                    </div>
                    <p className="mt-0.5 text-2xs text-slate-500 line-clamp-2">{d.reason}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {d.matchedFields.map((f) => (
                        <span key={f} className="px-1.5 py-0.5 rounded bg-slate-800 text-2xs text-slate-400">{f.replace('_', ' ')}</span>
                      ))}
                      {d.amountAtRiskCents > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-800 text-2xs font-mono text-slate-400">{formatMoney(d.amountAtRiskCents)} A/P</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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

      {intake && data && vendorId && (
        <VendorDocIntake
          vendorId={vendorId}
          vendorName={data.name}
          mode={intake}
          onClose={() => setIntake(null)}
          onConfirmed={() => { setIntake(null); refetch(); }}
        />
      )}
    </DetailDrawer>
  );
}
