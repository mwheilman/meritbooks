'use client';

/**
 * Unit detail — GET /api/dealer/units/detail → { unit, costs[], notes[], sale }.
 * Header with the unit's cost as the hero figure, flags, cost build-up, floor-plan
 * note history, sale, documents, and every unit action.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Boxes, Pencil, Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { AttachmentsPanel } from '@/components/documents/attachments-panel';
import { DEPT_ROLE, UNIT_CONDITION, UNIT_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { INVENTORY_ROLE, UNIT_SOURCE } from '@/lib/dealer/ui/unit-deal-labels';
import { dateLabel, daysLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { availableActions, daysInStock, LIVE_NOTE, unitFlags } from '@/lib/dealer/ui/unit-flags';
import type { UnitDetailView } from '@/lib/dealer/ui/unit-deal-types';
import { useDealerPack } from '../../_components/dealer-shell';
import { DefList, Empty, ErrorPanel, Mono, Pill } from '../../_components/ui';
import { nameOf, useDealerQuery, useNames } from '../../_lib/use-dealer';
import { AddCostModal } from './add-cost-modal';
import { CostTable } from './cost-table';
import { EditUnitModal } from './edit-unit-modal';
import { RecordSaleModal } from './record-sale-modal';
import { UnitActions } from './unit-actions';
import { NotesHistory, SaleSection } from './unit-sections';

function Skeleton() {
  return (
    <div aria-hidden>
      <div className="mb-6 h-8 w-64 animate-pulse rounded bg-slate-800" />
      <div className="card mb-6 grid gap-6 p-6 md:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-20 animate-pulse rounded bg-slate-800" />
            <div className="h-5 w-32 animate-pulse rounded bg-slate-800" />
          </div>
        ))}
      </div>
      <div className="card mb-6 h-48 animate-pulse" />
    </div>
  );
}

export function UnitDetail({ id }: { id: string }) {
  const router = useRouter();
  const pack = useDealerPack();
  const q = useDealerQuery<UnitDetailView>('/api/dealer/units/detail', { id });
  const [dialog, setDialog] = useState<null | 'edit' | 'cost' | 'sale'>(null);
  const today = todayLocal();
  const unit = q.data?.unit ?? null;
  const makes = useNames('vendors', [unit?.make_vendor_id, unit?.consignor_vendor_id]);

  if (q.isLoading && !q.data) return <Skeleton />;
  if (q.error) {
    if (q.error.code === 'NOT_FOUND') {
      return (
        <div className="card">
          <Empty
            icon={Boxes}
            title="Unit not found"
            description="This unit doesn’t exist for the selected client — it may belong to another client, or have been removed."
            action={
              <Link href={dealerLinks.units()} className="btn-secondary btn-sm">
                Back to units
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="card">
        <ErrorPanel error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  if (!q.data || !unit || !pack.locationId) return <Skeleton />;

  const { costs, notes, sale } = q.data;
  const liveNote = notes.find((n) => LIVE_NOTE.includes(n.status)) ?? null;
  const avail = availableActions(unit, { hasLiveNote: !!liveNote, hasSale: !!sale });
  const flags = unitFlags(unit, liveNote, pack.settings ? { aging_buckets: pack.settings.aging_buckets, term_warning_days: pack.settings.term_warning_days } : null, today);
  const sold = unit.status === 'SOLD' || unit.status === 'DELIVERED';
  const days = daysInStock(unit.received_date, sold ? unit.sold_date ?? today : today);
  const proposedCount = costs.filter((c) => c.status === 'PROPOSED').length;
  const refresh = () => void q.refetch();

  return (
    <div>
      <PageHeader
        title={`Unit ${unit.serial_number}`}
        breadcrumbs={[{ label: 'Units', href: dealerLinks.units() }, { label: unit.serial_number }]}
        actions={
          <>
            <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => setDialog('edit')} disabled={unit.status === 'VOID'}>
              <Pencil size={13} /> Edit
            </button>
            {avail.ADD_COST && (
              <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => setDialog('cost')}>
                <Plus size={13} /> Add cost
              </button>
            )}
            <UnitActions unit={unit} liveNote={liveNote} available={avail} enabled={pack.enabled} locationId={pack.locationId} onDone={refresh} />
            {avail.RECORD_SALE && (
              <button type="button" className="btn-primary btn-sm" onClick={() => setDialog('sale')}>
                Record sale
              </button>
            )}
          </>
        }
      />

      <section aria-label="Unit summary" className="card mb-6 overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-6 border-b border-slate-800 p-6">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Pill label={labelOf(UNIT_STATUS, unit.status)} tone={toneOf(UNIT_STATUS, unit.status)} />
              <Pill label={labelOf(UNIT_CONDITION, unit.condition)} tone={toneOf(UNIT_CONDITION, unit.condition)} dot={false} />
              {flags.map((f) => (
                <Pill key={f.key} label={f.label} tone={f.tone} title={f.hint} dot={false} />
              ))}
            </div>
            <h2 className="text-heading text-white">
              {[nameOf(makes, unit.make_vendor_id, ''), unit.model, unit.model_year].filter(Boolean).join(' ') || 'Unit details'}
            </h2>
            <p className="mt-1 text-body-sm text-slate-400">
              S/N <Mono className="text-slate-200">{unit.serial_number}</Mono>
              {unit.stock_number && (
                <>
                  {' '}
                  · Stock <Mono className="text-slate-200">{unit.stock_number}</Mono>
                </>
              )}
              {unit.vin_hin && (
                <>
                  {' '}
                  · VIN/HIN <Mono className="text-slate-200">{unit.vin_hin}</Mono>
                </>
              )}
            </p>
          </div>
          <div className="text-right">
            <div className="text-caption uppercase tracking-caps text-slate-500">{unit.is_consignment ? 'Consignment — not owned' : 'Unit cost'}</div>
            <div className="text-display font-mono tabular-nums text-white">{money(unit.cost_cents)}</div>
            {liveNote && (
              <Link href={dealerLinks.note(liveNote.id)} className="mt-1 block text-xs text-slate-400 hover:text-slate-200">
                Lender owed <span className="font-mono tabular-nums text-slate-200">{money(liveNote.principal_balance_cents)}</span> →
              </Link>
            )}
          </div>
        </div>
        <div className="p-6">
          <DefList
            items={[
              { label: sold ? 'Days in stock (until sold)' : 'Days in stock', value: daysLabel(days), mono: true },
              { label: 'Received', value: dateLabel(unit.received_date), mono: true },
              { label: 'Sold', value: dateLabel(unit.sold_date), mono: true },
              { label: 'Warranty registration', value: dateLabel(unit.warranty_registered_date), mono: true },
              { label: 'List price', value: unit.list_price_cents === null ? '—' : money(unit.list_price_cents), mono: true },
              { label: 'Inventory', value: INVENTORY_ROLE[unit.inventory_role] },
              { label: 'Department', value: DEPT_ROLE[unit.department_role]?.label ?? '—' },
              { label: 'Came from', value: labelOf(UNIT_SOURCE, unit.source) },
              ...(unit.is_consignment ? [{ label: 'Consignor', value: nameOf(makes, unit.consignor_vendor_id) }] : []),
            ]}
          />
          {(unit.description || unit.notes) && (
            <div className="mt-4 space-y-1 border-t border-slate-800 pt-4 text-body-sm">
              {unit.description && <p className="text-slate-300">{unit.description}</p>}
              {unit.notes && <p className="text-slate-500">{unit.notes}</p>}
            </div>
          )}
        </div>
      </section>

      <CostTable
        costs={costs}
        notes={notes}
        unitCostCents={unit.cost_cents}
        serial={unit.serial_number}
        locationId={pack.locationId}
        enabled={pack.enabled}
        canAdd={avail.ADD_COST}
        onAdd={() => setDialog('cost')}
        onChanged={refresh}
      />
      <NotesHistory notes={notes} isConsignment={unit.is_consignment} />
      <SaleSection sale={sale} canRecord={avail.RECORD_SALE} onRecord={() => setDialog('sale')} />

      <section aria-label="Documents" className="mb-6">
        <AttachmentsPanel entityType="dealer_unit" entityId={unit.id} title="Documents (invoice, MSO / title, PDI checklist)" />
      </section>

      <p className="mb-6">
        <Link href={dealerLinks.units()} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
          <ArrowLeft size={12} /> Back to units
        </Link>
      </p>

      <EditUnitModal open={dialog === 'edit'} onClose={() => setDialog(null)} locationId={pack.locationId} unit={unit} onSaved={() => { setDialog(null); refresh(); }} />
      <AddCostModal
        open={dialog === 'cost'}
        onClose={() => setDialog(null)}
        locationId={pack.locationId}
        unit={unit}
        settings={pack.settings}
        enabled={pack.enabled}
        onAdded={() => {
          setDialog(null);
          refresh();
        }}
      />
      <RecordSaleModal
        open={dialog === 'sale'}
        onClose={() => setDialog(null)}
        locationId={pack.locationId}
        unit={unit}
        settings={pack.settings}
        proposedCostCount={proposedCount}
        onCreated={(s) => {
          setDialog(null);
          router.push(dealerLinks.deal(s.id));
        }}
      />
    </div>
  );
}
