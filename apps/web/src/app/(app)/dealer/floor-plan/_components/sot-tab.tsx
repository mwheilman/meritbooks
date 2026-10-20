'use client';

/**
 * Sold out of trust (DL-1): every unit the dealer has sold — by Books, the dealer
 * system, a manufacturer warranty registration or the lender's own floor check —
 * whose floor-plan note isn't paid off. Critical first. Two ways out: record the
 * missing sale (unit page) or propose the payoff (a different person releases it).
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import type { SotFinding } from '@/lib/dealer/engine/sot';
import { SOLD_DETECTED_BY } from '@/lib/dealer/ui/labels';
import { daysLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { nameOf, useDealerQuery, useNames, type ListPage } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, type DealerColumn } from '../../_components/dealer-table';
import { Money, Notice, Pill, Section } from '../../_components/ui';
import { describeEvidence, sortSotFindings } from '../_lib/queues';
import type { FpTxn } from '../_lib/types';
import { DueDate, UnitLink } from './bits';
import { ProposePayoffDialog, type NoteLabel } from './money-dialogs';
import type { GoTab } from './workspace';

type Row = SotFinding & { id: string };

export function SotTab({ onChanged, go }: { onChanged: () => void; go: GoTab }) {
  const { settings, locationId } = useDealerPack();
  const sot = useDealerQuery<SotFinding[]>('/api/dealer/sot');
  const proposed = useDealerQuery<ListPage<FpTxn>>('/api/dealer/transactions', { txn_type: 'PAYOFF', status: 'PROPOSED', per_page: 100 });
  const [propose, setPropose] = useState<NoteLabel | null>(null);
  const today = todayLocal();
  const router = useRouter();

  const rows: Row[] = useMemo(() => sortSotFindings(sot.data ?? []).map((f) => ({ ...f, id: f.noteId })), [sot.data]);
  const lines = useNames('lines', rows.map((r) => r.lineId));
  const proposedNotes = useMemo(() => new Set((proposed.data?.rows ?? []).map((t) => t.note_id).filter(Boolean)), [proposed.data]);
  const critical = rows.filter((r) => r.severity === 'CRITICAL');
  const missingSale = rows.filter((r) => r.saleMissingInBooks);
  const exposure = rows.reduce((s, r) => s + r.principalCents, 0);

  const columns: DealerColumn<Row>[] = [
    {
      key: 'sev',
      header: 'Severity',
      render: (r) => (
        <Pill
          label={r.severity === 'CRITICAL' ? 'Critical' : 'High'}
          tone={r.severity === 'CRITICAL' ? 'danger' : 'warning'}
          title={r.severity === 'CRITICAL' ? 'Past the payoff date plus grace, or sold outside Books' : 'Sold in Books; payoff not yet past due plus grace'}
        />
      ),
    },
    { key: 'serial', header: 'Unit', render: (r) => <UnitLink unitId={r.unitId} serial={r.serialNumber} /> },
    { key: 'line', header: 'Line', render: (r) => <span className="text-slate-300">{nameOf(lines, r.lineId)}</span> },
    { key: 'principal', header: 'Owed to lender', align: 'right', render: (r) => <Money cents={r.principalCents} className={r.severity === 'CRITICAL' ? 'text-red-300' : undefined} /> },
    {
      key: 'evidence',
      header: 'How we know it sold',
      render: (r) => (
        <ul className="space-y-0.5 text-xs text-slate-300">
          {r.evidence.map((e) => (
            <li key={`${e.source}-${e.date}-${e.ref ?? ''}`}>{describeEvidence(e)}</li>
          ))}
        </ul>
      ),
    },
    {
      key: 'sold',
      header: 'Sold',
      render: (r) => (
        <span className="whitespace-nowrap">
          <DueDate date={r.earliestSaleDate} today={today} pastIsBad={false} muted />
          <span className="block text-2xs text-slate-500">{daysLabel(r.daysSinceSale)} ago</span>
        </span>
      ),
    },
    {
      key: 'due',
      header: 'Payoff due',
      render: (r) => (
        <span className="whitespace-nowrap">
          <DueDate date={r.payoffDueDate} today={today} />
          {r.daysPastDue > 0 && <span className="block text-2xs text-red-400">{daysLabel(r.daysPastDue)} past due</span>}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Next step',
      render: (r) =>
        r.saleMissingInBooks ? (
          <Link
            href={dealerLinks.unit(r.unitId)}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20"
            title={`Detected by: ${SOLD_DETECTED_BY[r.detectedBy]}`}
          >
            Sale missing in Books — record the sale <ArrowRight size={12} />
          </Link>
        ) : proposedNotes.has(r.noteId) ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); go('payoffs'); }} className="whitespace-nowrap text-xs text-blue-300 hover:text-blue-200">
            Payoff proposed — awaiting release →
          </button>
        ) : (
          <button
            type="button"
            className="btn-secondary btn-sm whitespace-nowrap"
            disabled={!settings?.enabled}
            title={settings?.enabled ? undefined : 'Switch the dealer pack on to record payoffs'}
            onClick={(e) => {
              e.stopPropagation();
              setPropose({ noteId: r.noteId, invoice: null, serial: r.serialNumber, balanceCents: r.principalCents });
            }}
          >
            Propose payoff
          </button>
        ),
    },
  ];

  return (
    <div>
      {critical.length > 0 && (
        <Notice tone="danger">
          <span className="font-medium">
            {critical.length} unit{critical.length === 1 ? ' is' : 's are'} sold out of trust
          </span>{' '}
          — <span className="font-mono tabular-nums">{money(critical.reduce((s, r) => s + r.principalCents, 0))}</span> the lender is owed now.
          {missingSale.length > 0 && ` ${missingSale.length} of them ${missingSale.length === 1 ? 'has' : 'have'} no sale in Books yet.`}
        </Notice>
      )}
      <Section
        title="Sold out of trust"
        description={
          <>
            A unit is out of trust once it’s sold and the lender hasn’t been paid by the payoff date plus {settings?.sot_grace_days ?? 2} grace day
            {(settings?.sot_grace_days ?? 2) === 1 ? '' : 's'}. A sale seen only outside Books (dealer system, warranty registration, lender floor check) is always critical.
            {rows.length > 0 && (
              <>
                {' '}Total exposure <span className="font-mono tabular-nums text-slate-300">{money(exposure)}</span>.
              </>
            )}
          </>
        }
        actions={
          <button type="button" className="btn-ghost btn-sm" onClick={() => { void sot.refetch(); void proposed.refetch(); }}>
            Refresh
          </button>
        }
      >
        <DealerTable<Row>
          caption="Sold-out-of-trust units"
          columns={columns}
          rows={rows}
          isLoading={sot.isLoading}
          error={sot.error}
          onRetry={sot.refetch}
          onRowClick={(r) => router.push(dealerLinks.note(r.noteId))}
          rowClassName={(r) => (r.severity === 'CRITICAL' ? 'bg-red-500/[0.04]' : undefined)}
          empty={{
            icon: ShieldCheck,
            title: 'Nothing is sold out of trust',
            description: 'Every sold unit has been paid off or is still inside its payoff window. Lender floor checks and warranty registrations are checked too.',
          }}
        />
      </Section>
      {locationId && (
        <ProposePayoffDialog
          open={!!propose}
          onClose={() => setPropose(null)}
          locationId={locationId}
          note={propose}
          onDone={() => {
            void proposed.refetch();
            void sot.refetch();
            onChanged();
          }}
        />
      )}
    </div>
  );
}
