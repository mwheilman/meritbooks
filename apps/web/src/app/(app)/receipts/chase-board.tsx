'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Bands,
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  InlineNotice,
  KV,
  Panel,
  PanelSection,
  Pip,
  QueueTable,
  Search,
  Select,
  api,
  money,
  toast,
  useDebounce,
  useQuery,
  type QueueAction,
  type QueueColumn,
  type QueueGroup,
} from '@meritbooks/merit-ui';
import { STATE_LOOK, relative, type ActionResult, type CardholderRow, type ChaseResponse, type OutstandingCharge } from './receipts-types';
import s from './receipts.module.css';

type Band = 'all' | 'over30' | 'escalated' | 'none';

function AskTrack({ c }: { c: OutstandingCharge }) {
  const n = Math.min(c.asks, 10);
  return (
    <span className={s.track} aria-hidden="true">
      {Array.from({ length: Math.max(n, 1) }, (_, i) => (
        <i key={i} className={n === 0 ? undefined : c.escalated && i === n - 1 ? s.esc : s.done} />
      ))}
    </span>
  );
}

export interface ChaseBoardProps {
  locationId: string | null;
  refreshKey: number;
  onChanged: () => void;
  onAssignCardholder: () => void;
}

export function ChaseBoard({ locationId, refreshKey, onChanged, onAssignCardholder }: ChaseBoardProps) {
  const [band, setBand] = useState<Band>('all');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 250);
  const [cursor, setCursor] = useState<string | null>(null);
  const [waive, setWaive] = useState<OutstandingCharge | null>(null);
  const [reassign, setReassign] = useState<OutstandingCharge | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, error, isLoading, refetch } = useQuery<ChaseResponse>(
    '/api/receipts/chase',
    { location_id: locationId ?? undefined, q: q || undefined },
    { key: String(refreshKey), scope: false },
  );

  const groups = useMemo<QueueGroup<OutstandingCharge>[]>(() => {
    const pick = (c: OutstandingCharge) =>
      band === 'all' ? true : band === 'over30' ? c.ageDays > 30 : band === 'escalated' ? c.escalated : c.status === 'no_cardholder';
    return (data?.groups ?? [])
      .map((g) => {
        const rows = g.charges.filter(pick);
        return {
          id: g.assignmentId ?? 'none',
          title: g.holderName,
          count: rows.length,
          caption: [g.cardLabel, `${money(rows.reduce((n, c) => n + c.amountCents, 0))} owed`, rows.length ? `oldest ${Math.max(...rows.map((c) => c.ageDays))} d` : null, g.holderEmail]
            .filter(Boolean)
            .join(' · '),
          rows,
        };
      })
      .filter((g) => g.rows.length > 0);
  }, [data, band]);

  const all = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const selected = all.find((c) => c.transactionId === cursor) ?? null;

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      const res = await api.post<ActionResult>('/api/receipts/chase/actions', body);
      setBusy(false);
      if (res.error) {
        toast.error(res.error.error);
        return false;
      }
      toast(res.data?.message ?? 'Done.');
      onChanged();
      void refetch();
      return true;
    },
    [onChanged, refetch],
  );

  const columns = useMemo<QueueColumn<OutstandingCharge>[]>(
    () => [
      {
        id: 'status',
        header: 'Status',
        width: 150,
        cell: (c) => (
          <span className="mb-sev">
            <Pip kind={c.escalated ? 'overdue' : STATE_LOOK[c.status].pip} />
            {c.escalated ? 'Escalated' : STATE_LOOK[c.status].word}
          </span>
        ),
      },
      {
        id: 'charge',
        header: 'Charge',
        cell: (c) => (
          <>
            <span className="l1">{c.merchant}</span>
            <span className="l2">{[c.chargeDate, c.reason].filter(Boolean).join(' · ')}</span>
          </>
        ),
      },
      { id: 'amount', header: 'Amount', width: 112, numeric: true, cell: (c) => <span className="tnum">{money(c.amountCents)}</span> },
      { id: 'age', header: 'Age', width: 64, numeric: true, cell: (c) => <span className="tnum">{c.ageDays}d</span> },
      {
        id: 'asks',
        header: 'Asked',
        width: 104,
        cell: (c) => (
          <span>
            <AskTrack c={c} />
            <span className="tnum">{c.asks}</span>
          </span>
        ),
      },
      {
        id: 'seen',
        header: 'Last asked · opened',
        width: 170,
        cell: (c) => (
          <span className="ink-2">
            {c.lastAskedAt ? relative(c.lastAskedAt) : 'Not yet'}
            {c.lastOpenedAt ? ` · opened ${relative(c.lastOpenedAt)}` : ''}
          </span>
        ),
      },
    ],
    [],
  );

  const actions = useMemo<QueueAction<OutstandingCharge>[]>(
    () => [
      { key: 'r', label: 'Remind now', run: (rs) => rs[0] && void act({ action: 'remind', transaction_id: rs[0].transactionId }) },
      { key: 'n', label: 'Not required', run: (rs) => rs[0] && setWaive(rs[0]) },
      { key: 'g', label: 'Reassign', run: (rs) => rs[0] && setReassign(rs[0]) },
    ],
    [act],
  );

  const strip = data?.strip;

  return (
    <div>
      {data && !data.chase.tenantEnabled && (
        <InlineNotice tone="warn" title="Receipt chase is off for the whole organization.">
          Nobody is being reminded. Charges still collect here and receipts still match. Turn it on under Policy.
        </InlineNotice>
      )}
      {data && data.chase.tenantEnabled && data.chase.clientEnabled === false && (
        <InlineNotice tone="warn" title="Receipt chase is off for this company.">
          Charges still collect here and uploaded receipts still match, but no reminders go out.
        </InlineNotice>
      )}

      <Bands<Band>
        aria-label="Outstanding receipts"
        value={band}
        onChange={setBand}
        items={[
          { value: 'all', label: 'Outstanding', count: strip ? strip.outstanding.toLocaleString() : '—', caption: strip ? `${money(strip.totalCents)} without a receipt` : 'Loading' },
          { value: 'over30', label: 'Over 30 days', count: strip ? strip.over30.toLocaleString() : '—', caption: 'The close will ask about these' },
          { value: 'escalated', label: 'Escalated', count: strip ? strip.escalated.toLocaleString() : '—', caption: 'A manager has been told' },
          { value: 'none', label: 'No cardholder', count: strip ? strip.noCardholder.toLocaleString() : '—', caption: 'Assign the card to chase it' },
        ]}
      />

      <div className={s.toolbar}>
        <span className="t-cap">{strip ? `${strip.matchedThisWeek} receipt${strip.matchedThisWeek === 1 ? '' : 's'} came in this week` : ''}</span>
        <div className={s.grow} />
        <Search aria-label="Search charges" placeholder="Search merchant" value={search} onChange={(e) => setSearch(e.target.value)} slashToFocus />
      </div>

      <div className={s.split}>
        <div>
          {error ? (
            <div className={s.state} role="alert">
              <p className="t-head">Couldn’t load the receipt chase.</p>
              <p className="ink-2">{error}</p>
              <Button onClick={() => void refetch()}>Try again</Button>
            </div>
          ) : isLoading && !data ? (
            <div className={s.state} role="status">
              <p className="t-cap">Loading outstanding receipts…</p>
            </div>
          ) : groups.length === 0 ? (
            <div className={s.state}>
              {band === 'all' && !q ? (
                <>
                  <p className="t-head">Every card charge has its receipt.</p>
                  <p className="ink-2">New charges over the receipt limit appear here within 15 minutes, with who was asked and when.</p>
                </>
              ) : (
                <>
                  <p className="t-head">Nothing in this band.</p>
                  <p className="ink-2">Try another band or clear the search.</p>
                </>
              )}
            </div>
          ) : (
            <QueueTable<OutstandingCharge>
              aria-label="Card charges waiting on a receipt, by cardholder"
              columns={columns}
              groups={groups}
              getRowId={(c) => c.transactionId}
              rowState={(c) => ({ attn: c.escalated || c.status === 'no_cardholder' })}
              cursorId={cursor}
              onCursorChange={(id) => setCursor(id)}
              onOpen={(c) => setCursor(c.transactionId)}
              openOnClick
              actions={actions}
            />
          )}
        </div>
        <div>
          {selected ? (
            <Panel
              aria-label="Charge"
              eyebrow={['Receipt chase', STATE_LOOK[selected.status].word]}
              title={selected.merchant}
              meta={selected.chargeDate}
              figure={money(selected.amountCents)}
              onClose={() => setCursor(null)}
              foot={
                <div className={s.actions}>
                  {selected.status === 'no_cardholder' ? (
                    <>
                      <Button variant="primary" onClick={() => setReassign(selected)}>
                        Assign a cardholder
                      </Button>
                      <Button onClick={onAssignCardholder}>Add a cardholder</Button>
                    </>
                  ) : (
                    <Button variant="primary" chord="r" disabled={busy || selected.status !== 'requested'} onClick={() => void act({ action: 'remind', transaction_id: selected.transactionId })}>
                      Remind now
                    </Button>
                  )}
                  {selected.status !== 'no_cardholder' && <Button onClick={() => setReassign(selected)}>Reassign</Button>}
                  <Button variant="quiet" onClick={() => setWaive(selected)}>
                    Not required
                  </Button>
                </div>
              }
            >
              <PanelSection title="Chase">
                <KV
                  items={[
                    { term: 'Asked', value: `${selected.asks} time${selected.asks === 1 ? '' : 's'}` },
                    { term: 'Last asked', value: selected.lastAskedAt ? relative(selected.lastAskedAt) : 'Not yet' },
                    { term: 'Next ask', value: selected.nextAskAt ? relative(selected.nextAskAt) : selected.status === 'requested' ? 'Schedule finished' : '—' },
                    { term: 'Opened the link', value: selected.lastOpenedAt ? relative(selected.lastOpenedAt) : 'Not yet' },
                    { term: 'Escalated', value: selected.escalated ? 'Yes — the manager was told' : 'No' },
                  ]}
                />
              </PanelSection>
              {selected.status === 'chase_off' && (
                <InlineNotice title="Chase is off here.">No reminders go out; a receipt that arrives still matches.</InlineNotice>
              )}
              {selected.status === 'opted_out' && <InlineNotice title="This cardholder is opted out.">Receipts are not chased for their card.</InlineNotice>}
              {selected.requestId && (
                <p className="t-cap">
                  <a className="link" href={`/requests?id=${selected.requestId}`}>
                    Full reminder timeline
                  </a>
                </p>
              )}
            </Panel>
          ) : (
            <div className={s.state}>
              <p className="t-head">Pick a charge</p>
              <p className="ink-2">J / K to move · R remind now · N not required · G reassign.</p>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!waive}
        onClose={() => setWaive(null)}
        title={waive ? `No receipt needed for ${waive.merchant}?` : ''}
        confirmLabel="Mark not required"
        reason={{ label: 'Why not?', help: 'Kept with the charge for the auditor.', minLength: 3, placeholder: 'Covered by the fuel card statement' }}
        onConfirm={async (reason) => {
          if (!waive) return;
          const ok = await act({ action: 'not_required', transaction_id: waive.transactionId, reason: reason ?? '' });
          if (ok) setWaive(null);
        }}
      >
        <p className="ink-2">Reminders stop for this charge. You can reopen it later.</p>
      </ConfirmDialog>

      {reassign && (
        <ReassignDialog
          charge={reassign}
          onClose={() => setReassign(null)}
          onDone={async (assignmentId) => {
            const ok = await act({ action: 'reassign', transaction_id: reassign.transactionId, assignment_id: assignmentId });
            if (ok) setReassign(null);
          }}
        />
      )}
    </div>
  );
}

function ReassignDialog({ charge, onClose, onDone }: { charge: OutstandingCharge; onClose: () => void; onDone: (assignmentId: string) => Promise<void> }) {
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery<{ rows: CardholderRow[] }>('/api/receipts/cardholders', { location_id: charge.locationId }, { scope: false });
  const rows = data?.rows ?? [];
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Who has the receipt for ${charge.merchant}?`}
      footNote={`${money(charge.amountCents)} on ${charge.chargeDate}`}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!pick || busy}
            onClick={async () => {
              setBusy(true);
              await onDone(pick);
              setBusy(false);
            }}
          >
            {busy ? 'Saving…' : 'Ask them'}
          </Button>
        </>
      }
    >
      <Field label="Cardholder" help="They are asked right away; the old ask stops.">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} disabled={isLoading}>
          <option value="">{isLoading ? 'Loading…' : rows.length ? 'Choose a cardholder' : 'No cardholders for this company yet'}</option>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.holder_name}
              {r.card_last4 ? ` · ••${r.card_last4}` : ''}
            </option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}
