'use client';
import { useState, type ReactNode } from 'react';
import { Button, Icon, InlineNotice, Status, Tag, type StatusKind, type PipKind } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField, DetailTable } from '@/components/detail-drawer';
import { VendorDocIntake } from './vendor-doc-intake';
import { VendorPortalAccess } from '@/components/vendor-portal-access';
import { MaskedField, type MaskLevel } from '@/components/masked-field';
import s from './vendors.module.css';

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
  taxIdRevealed?: boolean;
  fieldMasks?: { masked: string[]; levels: { tin: MaskLevel; bank: MaskLevel; comp: MaskLevel; personal: MaskLevel }; revealed: string[] };
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

const CHIP_LOOK: Record<ComplianceStatus, { kind: StatusKind; pip?: PipKind; word: string; attn: boolean }> = {
  valid: { kind: 'ready', word: 'Valid', attn: false },
  expired: { kind: 'overdue', word: 'Expired', attn: true },
  pending: { kind: 'track', pip: 'open', word: 'Pending', attn: false },
  missing: { kind: 'blocked', word: 'Missing', attn: true },
};

function ComplianceChip({ label, status }: { label: string; status: ComplianceStatus }) {
  const look = CHIP_LOOK[status];
  return (
    <div className={`${s.chip} ${look.attn ? s.chipAttn : ''}`}>
      <span className="eyebrow">{label}</span>
      <Status kind={look.kind} pip={look.pip}>{look.word}</Status>
    </div>
  );
}

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Bucket marks: the swatch + label + amount carry the meaning; tone deepens with age.
const AGING_BUCKETS = [
  { key: 'currentCents', label: 'Current', tone: 'var(--pos)' },
  { key: 'd1_30Cents', label: '1–30', tone: 'var(--steel)' },
  { key: 'd31_60Cents', label: '31–60', tone: 'var(--warn)' },
  { key: 'd61_90Cents', label: '61–90', tone: 'var(--neg)' },
  { key: 'd90PlusCents', label: '90+', tone: 'var(--midnight)' },
] as const;

/** A compact stacked bar + legend of this vendor's open A/P by days past due. */
function AgingBar({ aging, total }: { aging: VenDetail['ap']['aging']; total: number }) {
  if (total <= 0) return null;
  return (
    <section className={s.sec} aria-label="Open A/P aging">
      <div className={s.secHead}>
        <h3 className="eyebrow">Open A/P aging</h3>
        <span className="tnum ink-2">{formatMoney(total)}</span>
      </div>
      <div className={s.agingBar} role="img" aria-label={AGING_BUCKETS.map((b) => `${b.label}: ${formatMoney(aging[b.key])}`).join(', ')}>
        {AGING_BUCKETS.map((b) => {
          const cents = aging[b.key];
          if (cents <= 0) return null;
          return <span key={b.key} style={{ width: `${(cents / total) * 100}%`, background: b.tone }} title={`${b.label}: ${formatMoney(cents)}`} />;
        })}
      </div>
      <div className={s.agingLegend}>
        {AGING_BUCKETS.map((b) => (
          <div key={b.key} className={s.agingCell}>
            <span className={`${s.agingKey} t-cap`}>
              <i className={s.swatch} style={{ background: b.tone }} aria-hidden="true" />
              {b.label}
            </span>
            <span className={`tnum ${aging[b.key] > 0 ? '' : 'ink-3'}`}>
              {formatMoney(aging[b.key], { compact: true })}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

const READINESS_META: Record<VenDetail['ten99']['readiness'], { text: string; tone: 'pos' | 'neg' | 'default' }> = {
  READY: { text: 'Ready to file', tone: 'pos' },
  MISSING_W9: { text: 'Missing W-9 / TIN', tone: 'neg' },
  NOT_MARKED_1099: { text: 'Not marked 1099', tone: 'default' },
};

function Sec({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.sec}>
      <div className={s.secHead}>
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

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
          {/* Payment hold */}
          {data.compliance.hold && (
            <InlineNotice
              tone="neg"
              title={`Payment hold — ${data.compliance.hold.type.replace('_', ' ').toLowerCase()}${data.compliance.hold.endDate ? ` · lifts ${fmtDate(data.compliance.hold.endDate)}` : ' · no end date'}`}
            >
              {data.compliance.hold.reason}
            </InlineNotice>
          )}

          {/* Spend strip */}
          <div className={s.tiles} style={{ marginTop: data.compliance.hold ? 16 : 4 }}>
            <div className={s.tile}>
              <span className="eyebrow">Open A/P</span>
              <span className={`${s.tileValue} tnum`}>{formatMoney(data.ap.openBalance)}</span>
              <span className="t-cap">
                <span className="tnum">{data.ap.openBillCount}</span> open
                {data.ap.overdueCount > 0 && <> · <b className="ink-2"><span className="tnum">{data.ap.overdueCount}</span> overdue</b></>}
              </span>
            </div>
            <div className={s.tile}>
              <span className="eyebrow">{year} spend</span>
              <span className={`${s.tileValue} tnum`}>{formatMoney(data.spend.ytdCents)}</span>
              <span className="t-cap"><span className="tnum">{formatMoney(data.spend.paidYtdCents, { compact: true })}</span> paid</span>
            </div>
            <div className={s.tile}>
              <span className="eyebrow">Trailing 12 months</span>
              <span className={`${s.tileValue} tnum`}>{formatMoney(data.spend.ttmCents)}</span>
              <span className="t-cap">Billed</span>
            </div>
          </div>

          {/* Open A/P aging (this vendor's slice of the A/P-aging report) */}
          {data.ap.openBalance > 0 && <AgingBar aging={data.ap.aging} total={data.ap.openBalance} />}

          {/* 1099 status + payment method on file — read-only at-a-glance row */}
          <section className={s.sec}>
            <div className={s.pair}>
              {/* 1099 status (read-only; nothing is filed from here) */}
              <div className={s.box}>
                <div className={s.boxHead}>
                  <h3 className="eyebrow">1099 status</h3>
                  <Tag tone={READINESS_META[data.ten99.readiness].tone === 'default' ? undefined : READINESS_META[data.ten99.readiness].tone}>
                    {READINESS_META[data.ten99.readiness].text}
                  </Tag>
                </div>
                <span className="t-head">
                  {data.ten99.reportable ? 'Reportable' : data.ten99.eligible ? 'Not reportable' : 'Not 1099'}
                </span>
                <span className="t-cap">
                  <span className="tnum">{formatMoney(data.ten99.reportableYtdCents, { compact: true })}</span> reportable YTD
                  {' · '}floor <span className="tnum">{formatMoney(data.ten99.thresholdCents, { compact: true })}</span>
                </span>
                {data.ten99.missingTin && <Status kind="overdue">No TIN on file</Status>}
              </div>

              {/* Payment method on file (masked; raw bank numbers are never stored) */}
              <div className={s.box}>
                <div className={s.boxHead}>
                  <h3 className="eyebrow">Payment method</h3>
                  <Icon name={data.paymentProfile?.method === 'CHECK' ? 'file-text' : data.paymentProfile ? 'building' : 'none'} />
                </div>
                {data.paymentProfile ? (
                  <>
                    <span className="t-head">
                      {data.paymentProfile.method === 'CHECK' ? 'Check' : 'ACH'}
                      {data.paymentProfile.accountType && <span className="ink-2" style={{ fontWeight: 400 }}> · {data.paymentProfile.accountType}</span>}
                    </span>
                    <span className="t-cap">
                      {data.paymentProfile.accountMask
                        ? <>Account <span className="tnum ink-2">{data.paymentProfile.accountMask}</span>{data.paymentProfile.bankName ? ` · ${data.paymentProfile.bankName}` : ''}</>
                        : data.paymentProfile.bankName ?? 'Pays to mailing address'}
                    </span>
                    {!data.paymentProfile.hasBankDetails && <Status kind="risk">Incomplete for remittance</Status>}
                  </>
                ) : (
                  <span className="ink-3">No payment details captured.</span>
                )}
              </div>
            </div>
          </section>

          {/* Compliance chips + drop-and-parse intake */}
          <Sec
            title="Compliance"
            aside={
              <span className="btn-row">
                <Button icon="upload" onClick={() => setIntake('W9')}>Upload W-9</Button>
                <Button icon="upload" onClick={() => setIntake('COI')}>Upload COI</Button>
              </span>
            }
          >
            <div className={s.chips}>
              <ComplianceChip label="W-9" status={data.compliance.w9} />
              <ComplianceChip label="GL COI" status={data.compliance.glCoi} />
              <ComplianceChip label="WC COI" status={data.compliance.wcCoi} />
            </div>
          </Sec>

          {/* Compliance documents */}
          {data.complianceDocs.length > 0 && (
            <Sec title="Documents on file">
              <ul className={s.list}>
                {data.complianceDocs.map((d) => (
                  <li key={d.id}>
                    <span className={s.listMain}>
                      <Icon name="file-text" />
                      <span className="mb-trunc">{DOC_LABEL[d.docType] ?? d.docType}</span>
                      {d.hasFile && <span className="t-cap">File attached</span>}
                    </span>
                    <span className={s.listSide}>
                      {d.coverageAmountCents != null && (
                        <span className="tnum ink-2">{formatMoney(d.coverageAmountCents, { compact: true })}</span>
                      )}
                      {d.expirationDate && <span className="t-cap">Expires {fmtDate(d.expirationDate)}</span>}
                      <StatusBadge status={d.status} />
                    </span>
                  </li>
                ))}
              </ul>
            </Sec>
          )}

          {/* Portal access — mint/revoke the vendor's self-service upload link and
              review what they submitted (each PENDING until a human accepts it). */}
          {vendorId && (
            <Sec title="Document request portal">
              <VendorPortalAccess vendorId={vendorId} />
            </Sec>
          )}

          {/* Open bills */}
          <Sec title="Open bills">
            {data.openBills.length === 0 ? (
              <div className={s.quietBox}>No open bills — this vendor is fully paid.</div>
            ) : (
              <DetailTable columns={[
                { key: 'n', label: 'Bill' }, { key: 'due', label: 'Due' },
                { key: 'b', label: 'Balance', align: 'right' }, { key: 's', label: 'Status', align: 'center' },
              ]}>
                {data.openBills.map((b) => (
                  <tr key={b.id} className="q-row">
                    <td className="tnum">{b.billNumber ?? '—'}</td>
                    <td className="tnum ink-2">
                      {fmtDate(b.dueDate)}
                      {b.daysOverdue > 0 && <span className="mb-sev" style={{ marginLeft: 8 }}><Status kind="overdue">{b.daysOverdue}d past due</Status></span>}
                    </td>
                    <td className="n tnum">{formatMoney(b.balanceCents)}</td>
                    <td className="mb-c"><StatusBadge status={b.status} /></td>
                  </tr>
                ))}
              </DetailTable>
            )}
          </Sec>

          {/* Payment history */}
          <Sec title="Payment history">
            {data.payments.length === 0 ? (
              <div className={s.quietBox}>No payments recorded for this vendor.</div>
            ) : (
              <DetailTable columns={[
                { key: 'd', label: 'Paid' }, { key: 'n', label: 'Bill' },
                { key: 'm', label: 'Method' }, { key: 'a', label: 'Amount', align: 'right' },
              ]}>
                {data.payments.map((p) => (
                  <tr key={p.id} className="q-row">
                    <td className="tnum ink-2">{fmtDate(p.paymentDate)}</td>
                    <td className="tnum">{p.billNumber ?? '—'}</td>
                    <td className="ink-2">{p.method ?? '—'}</td>
                    <td className="n tnum">{formatMoney(p.amountCents)}</td>
                  </tr>
                ))}
              </DetailTable>
            )}
          </Sec>

          {/* Recent bills — full history slice with status (paid + open). */}
          {data.recentBills.length > 0 && (
            <Sec title="Recent bills">
              <DetailTable columns={[
                { key: 'n', label: 'Bill' }, { key: 'd', label: 'Date' },
                { key: 't', label: 'Total', align: 'right' }, { key: 'b', label: 'Balance', align: 'right' },
                { key: 's', label: 'Status', align: 'center' },
              ]}>
                {data.recentBills.map((b) => (
                  <tr key={b.id} className="q-row">
                    <td className="tnum">{b.billNumber ?? '—'}</td>
                    <td className="tnum ink-2">{fmtDate(b.billDate)}</td>
                    <td className="n tnum">{formatMoney(b.totalCents)}</td>
                    <td className="n tnum ink-2">{formatMoney(b.balanceCents)}</td>
                    <td className="mb-c"><StatusBadge status={b.status} /></td>
                  </tr>
                ))}
              </DetailTable>
            </Sec>
          )}

          {/* Possible duplicate vendors — read-only detection (no auto-merge). */}
          {data.possibleDuplicates && data.possibleDuplicates.length > 0 && (
            <Sec title={`Possible duplicates (${data.possibleDuplicates.length})`}>
              <p className="t-cap" style={{ marginBottom: 8 }}>
                Vendors that look like the same payee under two records — this splits spend, 1099
                totals and payment holds. Review and consolidate by hand; nothing is merged
                automatically.
              </p>
              {data.possibleDuplicates.map((d) => (
                <div key={d.id} className={s.dup}>
                  <div className="row row--between">
                    <span className="t-head mb-trunc">{d.name}</span>
                    <span className="tnum ink-2" style={{ flex: 'none' }}>{Math.round(d.confidence * 100)}% match</span>
                  </div>
                  <p className={`t-cap ${s.clamp}`} style={{ marginTop: 2 }}>{d.reason}</p>
                  <div className={s.tags}>
                    {d.matchedFields.map((f) => <Tag key={f}>{f.replace('_', ' ')}</Tag>)}
                    {d.amountAtRiskCents > 0 && <Tag><span className="tnum">{formatMoney(d.amountAtRiskCents)}</span> A/P</Tag>}
                  </div>
                </div>
              ))}
            </Sec>
          )}

          {/* Identity / terms */}
          <DetailSection title="Contact & terms">
            <DetailField label="Legal name" value={data.legalName} />
            <DetailField label="Email" value={data.email ?? '—'} />
            <DetailField label="Phone" value={data.phone ?? '—'} />
            {data.website && <DetailField label="Website" value={data.website} />}
            {data.addressLine && <DetailField label="Address" value={data.addressLine} />}
            <DetailField label="Payment terms" value={data.paymentTermsDays != null ? `Net ${data.paymentTermsDays}` : '—'} />
            <DetailField label="1099 eligible" value={data.is1099 ? 'Yes' : 'No'} />
            <MaskedField
              label="Taxpayer ID"
              value={data.taxId}
              level={data.fieldMasks?.levels.tin ?? 'masked'}
              onReveal={vendorId ? async (reason) => {
                const res = await fetch(`/api/vendors/${vendorId}`, {
                  method: 'POST',
                  cache: 'no-store',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ reveal: ['tin'], reason }),
                });
                if (!res.ok) return null;
                const body = (await res.json()) as Pick<VenDetail, 'taxId' | 'taxIdRevealed'>;
                return body.taxIdRevealed ? body.taxId : null;
              } : undefined}
            />
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
