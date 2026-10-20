'use client';

/**
 * Warranty claim drawer (`?claim=<id>`): the open amount as the hero, the claim's
 * components (labor hours × rate, parts cost × (1 + markup), sublet, freight,
 * other), settled / written off / charged back, DL-5 flags, the money-event
 * timeline with JE links, and the actions this status allows.
 */

import { useState } from 'react';
import Link from 'next/link';
import { FileText, Pencil } from 'lucide-react';
import { DetailDrawer } from '@/components/detail-drawer';
import { WARRANTY_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { bpsToPct, dateLabel, hours, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { explainDealerError } from '@/lib/dealer/ui/errors';
import {
  WARRANTY_APPROVER_ACTIONS,
  warrantyActions,
  warrantyAging,
  warrantyOpenCents,
  type WarrantyAction,
  type WarrantyClaimRow,
} from '@/lib/dealer/ui/claims';
import { nameOf, useDealerQuery, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DefList, Money, Mono, Notice, Pill } from '../../_components/ui';
import { ClaimTimeline } from '../../_components/claims/claim-timeline';
import { WARRANTY_ACTION_LABEL, WarrantyActionDialogs } from './warranty-actions';
import { WarrantyForm } from './warranty-form';

export function claimLabelOf(c: Pick<WarrantyClaimRow, 'oem_claim_number' | 'dealer_claim_ref' | 'repair_order_ref' | 'id'>): string {
  if (c.oem_claim_number) return `Claim ${c.oem_claim_number}`;
  if (c.dealer_claim_ref) return `Claim ${c.dealer_claim_ref}`;
  if (c.repair_order_ref) return `RO ${c.repair_order_ref}`;
  return 'Draft claim';
}

export function WarrantyDrawer({ claimId, onClose, onChanged }: { claimId: string | null; onClose: () => void; onChanged: () => void }) {
  const { settings, locationId } = useDealerPack();
  const q = useDealerQuery<WarrantyClaimRow>(claimId ? '/api/dealer/record' : null, { kind: 'warranty', id: claimId });
  const [action, setAction] = useState<WarrantyAction | null>(null);
  const [editing, setEditing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const c = q.data;
  const vendors = useNames('vendors', [c?.oem_vendor_id]);
  const customers = useNames('customers', [c?.customer_id]);
  const manufacturer = c ? vendors.get(c.oem_vendor_id)?.label ?? null : null;

  function changed() {
    void q.refetch();
    setRefreshKey((k) => k + 1);
    onChanged();
  }

  const open = c ? warrantyOpenCents(c) : 0;
  const actions = c ? warrantyActions(c) : [];
  const aging = c && settings ? warrantyAging(c, settings, todayLocal()) : null;

  return (
    <DetailDrawer
      open={!!claimId}
      onClose={() => {
        if (action || editing) return; // dialogs own Escape while open
        onClose();
      }}
      width="lg"
      title={c ? claimLabelOf(c) : 'Warranty claim'}
      subtitle={c ? [manufacturer, c.repair_order_ref ? `RO ${c.repair_order_ref}` : null].filter(Boolean).join(' · ') : null}
      isLoading={q.isLoading && !c}
      error={q.error ? `${explainDealerError(q.error).title}. ${explainDealerError(q.error).message}` : null}
      headerRight={c ? <Pill label={labelOf(WARRANTY_STATUS, c.status)} tone={toneOf(WARRANTY_STATUS, c.status)} /> : null}
    >
      {c && locationId && (
        <div className="space-y-6">
          <div>
            <p className="text-caption uppercase tracking-caps text-slate-500">{c.status === 'DRAFT' ? 'Will claim' : 'Still owed by the manufacturer'}</p>
            <p className="mt-1 font-mono text-display tabular-nums text-white">{money(c.status === 'DRAFT' ? c.claimed_cents : open)}</p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
              <span>
                Claimed <Mono className="text-slate-200">{money(c.claimed_cents)}</Mono>
              </span>
              <span>
                Paid <Mono className="text-slate-200">{money(c.settled_cents)}</Mono>
              </span>
              {c.written_off_cents > 0 && (
                <span>
                  Written off <Mono className="text-amber-300">{money(c.written_off_cents)}</Mono>
                </span>
              )}
              {c.debited_cents > 0 && (
                <span>
                  Charged back <Mono className="text-red-300">{money(c.debited_cents)}</Mono>
                </span>
              )}
            </div>
          </div>

          {aging?.flag && <Notice tone={aging.flag.tone === 'danger' ? 'danger' : 'warning'}>{aging.flag.label}.</Notice>}
          {c.status === 'PARTIAL' && c.settled_cents > 0 && open > 0 && (
            <Notice tone="warning">
              The manufacturer paid {money(c.settled_cents)} — {money(open)} less than claimed. The claim stays partly paid until a parts & service manager accepts the short-pay or you resubmit it.
            </Notice>
          )}
          {c.status === 'REJECTED' && c.rejection_reason && (
            <Notice tone="danger">
              <span className="font-medium">Rejected:</span> {c.rejection_reason}
            </Notice>
          )}

          {actions.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Claim actions">
              {actions.map((a, i) => {
                const primary = i === 0 && a !== 'EDIT';
                const danger = a === 'WRITE_OFF' || a === 'DEBIT';
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => (a === 'EDIT' ? setEditing(true) : setAction(a))}
                    className={`btn-sm ${primary ? 'btn-primary' : danger ? 'btn-danger' : 'btn-secondary'}`}
                    title={WARRANTY_APPROVER_ACTIONS.includes(a) ? 'Needs a parts & service manager' : undefined}
                  >
                    {a === 'EDIT' && <Pencil size={12} />}
                    {WARRANTY_ACTION_LABEL[a]}
                  </button>
                );
              })}
            </div>
          )}
          {c.status === 'DRAFT' && !c.ro_closed_date && settings?.warranty_recognition === 'ON_RO_CLOSE' && (
            <p className="-mt-3 text-xs text-slate-500">This client books warranty when the repair order closes — close it to book the receivable.</p>
          )}

          <section aria-label="Claim components">
            <h3 className="mb-2 text-caption uppercase tracking-caps text-slate-500">Components</h3>
            <table className="w-full text-body-sm">
              <tbody className="divide-y divide-slate-800/50">
                <CompRow label="Labor" detail={`${hours(c.labor_hours)} h × ${money(c.labor_rate_cents)}`} cents={c.labor_cents} />
                <CompRow label="Parts" detail={`${money(c.parts_cost_cents)} cost × (1 + ${bpsToPct(c.parts_markup_bps)})`} cents={c.parts_cents} />
                <CompRow label="Sublet" cents={c.sublet_cents} />
                <CompRow label="Freight" cents={c.freight_cents} />
                <CompRow label="Other" cents={c.other_cents} />
                <tr>
                  <th scope="row" className="py-2 text-left font-medium text-slate-200">Claimed</th>
                  <td />
                  <td className="py-2 text-right">
                    <Money cents={c.claimed_cents} className="font-semibold" />
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <DefList
            items={[
              { label: 'Manufacturer claim #', value: c.oem_claim_number ?? '—', mono: true },
              { label: 'Your reference', value: c.dealer_claim_ref ?? '—', mono: true },
              { label: 'Repair order', value: c.repair_order_ref ?? '—', mono: true },
              {
                label: 'Unit',
                value: c.unit_id ? (
                  <Link href={dealerLinks.unit(c.unit_id)} className="font-mono text-emerald-400 hover:text-emerald-300">
                    {c.serial_number ?? 'Open unit'}
                  </Link>
                ) : (
                  c.serial_number ?? '—'
                ),
                mono: true,
              },
              { label: 'Customer', value: c.customer_id ? nameOf(customers, c.customer_id) : '—' },
              { label: 'Failure date', value: dateLabel(c.failure_date), mono: true },
              { label: 'Repair date', value: dateLabel(c.repair_date), mono: true },
              { label: 'Repair order closed', value: dateLabel(c.ro_closed_date), mono: true },
              { label: 'Submitted', value: c.submitted_date ? `${dateLabel(c.submitted_date)}${aging?.daysOutstanding != null ? ` · ${aging.daysOutstanding}d` : ''}` : '—', mono: true },
              { label: 'Filing deadline', value: dateLabel(c.filing_deadline), mono: true },
            ]}
          />

          {c.recognized_gl_entry_id && (
            <Link href={dealerLinks.journalEntry(c.recognized_gl_entry_id)} className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300">
              <FileText size={12} /> Receivable journal entry
            </Link>
          )}

          <ClaimTimeline kind="WARRANTY" claimId={c.id} refreshKey={refreshKey} />

          <WarrantyActionDialogs
            action={action}
            onClose={() => setAction(null)}
            claim={c}
            claimLabel={claimLabelOf(c)}
            manufacturer={manufacturer}
            settings={settings}
            locationId={locationId}
            onDone={changed}
          />
          <WarrantyForm open={editing} onClose={() => setEditing(false)} initial={c} locationId={locationId} onSaved={changed} />
        </div>
      )}
    </DetailDrawer>
  );
}

function CompRow({ label, detail, cents }: { label: string; detail?: string; cents: number }) {
  return (
    <tr>
      <th scope="row" className="py-2 text-left font-normal text-slate-400">{label}</th>
      <td className="py-2 text-right font-mono text-2xs tabular-nums text-slate-500">{detail ?? ''}</td>
      <td className="py-2 text-right">
        <Money cents={cents} muted={cents === 0} />
      </td>
    </tr>
  );
}
