'use client';

import { useState } from 'react';
import { api, Button, ConfirmDialog, Drawer, Field, InlineNotice, KV, PanelSection, Textarea, money, toast, useQuery } from '@meritbooks/merit-ui';
import { CELL_WORDS } from './calendar-grid';
import { dayName, monthName, type CalendarCell, type CalendarRow, type PeriodDetail, type RestatementLogEntry } from './types';
import s from './reporting-calendar.module.css';

interface Props {
  open: boolean;
  row: CalendarRow | null;
  cell: CalendarCell | null;
  canRelease: boolean;
  restatements: RestatementLogEntry[];
  onClose: () => void;
  onChanged: () => void;
}

const BLOCK_WORDS = {
  not_ended: "The month hasn't ended yet.",
  no_period: 'There is no fiscal period for this month.',
  open: 'The month is open. Soft-close or close it first.',
  soft_close_below_minimum: 'The auto rule waits for a hard close; you can still release it by hand.',
} as const;

const STATUS_WORDS = { HARD_CLOSE: 'Closed', SOFT_CLOSE: 'Soft close', OPEN: 'Open', NO_PERIOD: 'No period' } as const;

/** One company-month: status, what was reported, release / take back, its restatements. */
export function PeriodPanel({ open, row, cell, canRelease, restatements, onClose, onChanged }: Props) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const year = cell ? Number(cell.key.slice(0, 4)) : 0;
  const month = cell ? Number(cell.key.slice(5, 7)) : 0;
  const detail = useQuery<PeriodDetail>(
    open && row && cell ? '/api/report-governance/period' : null,
    row && cell ? { location_id: row.locationId, year: String(year), month: String(month) } : undefined,
    { scope: false, key: cell ? `${cell.state}-${cell.restatementCount}` : '' },
  );

  if (!row || !cell) return null;
  const w = CELL_WORDS[cell.state];
  const snap = detail.data?.snapshot ?? null;
  const rel = detail.data?.release ?? null;

  const release = async () => {
    setBusy(true);
    setErr(null);
    const res = await api.post<{ alreadyReleased: boolean; restatementId: string | null }>('/api/report-governance/release', {
      location_id: row.locationId,
      year,
      month,
      note: note.trim() || null,
    });
    setBusy(false);
    if (res.error) {
      setErr(res.error.error);
      return;
    }
    setNote('');
    toast(
      res.data?.alreadyReleased
        ? `${monthName(cell.key)} was already released with these numbers.`
        : res.data?.restatementId
          ? `${monthName(cell.key)} released. Its numbers changed since the last release — logged as a restatement.`
          : `${monthName(cell.key)} released. Partners and lenders can see it now.`,
    );
    onChanged();
  };

  const withdraw = async (reason?: string) => {
    const res = await api.post('/api/report-governance/withdraw', { location_id: row.locationId, year, month, reason: reason ?? '' });
    if (res.error) throw new Error(res.error.error);
    toast(`${monthName(cell.key)} taken back. Partners no longer see it.`);
    onChanged();
  };

  const blocked = cell.release.blockedBy;
  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        eyebrow={['Reporting calendar', row.name]}
        title={monthName(cell.key)}
        meta={`${w.long} · ${STATUS_WORDS[cell.closeStatus]}`}
        width={440}
      >
        <PanelSection title="Status">
          <KV
            items={[
              { term: 'Period', value: STATUS_WORDS[cell.closeStatus] },
              {
                term: 'Partners',
                value: cell.release.released
                  ? `See it${cell.release.mode === 'AUTO' ? ' (auto)' : ''} since ${dayName(cell.release.releasedOn)}`
                  : cell.release.withdrawn
                    ? 'Taken back'
                    : 'Do not see it',
              },
              ...(cell.release.autoReleaseOn && !cell.release.released ? [{ term: 'Auto-release', value: dayName(cell.release.autoReleaseOn) }] : []),
              ...(rel?.releasedBy && cell.release.released ? [{ term: 'Released by', value: rel.releasedBy.startsWith('system:') ? 'The auto rule' : rel.releasedBy }] : []),
              ...(rel?.note ? [{ term: 'Note', value: rel.note }] : []),
              ...(rel?.status === 'WITHDRAWN' && rel.withdrawReason ? [{ term: 'Why taken back', value: rel.withdrawReason }] : []),
            ]}
          />
          {blocked && !cell.release.released && <p className={s.muted}>{BLOCK_WORDS[blocked]}</p>}
          {!blocked && !cell.release.released && cell.release.heldBy && (
            <p className={s.muted}>Releases go in order — release {monthName(cell.release.heldBy)} first.</p>
          )}
        </PanelSection>

        <PanelSection title="What partners were shown" meta={snap ? `Captured ${dayName(snap.capturedAt)}` : undefined}>
          {detail.isLoading ? (
            <div className="wg-loading" style={{ height: 96 }} aria-busy="true"><span className="bar-l" style={{ width: '70%' }} /></div>
          ) : detail.error ? (
            <InlineNotice tone="neg" title="Couldn't load the snapshot.">{detail.error}</InlineNotice>
          ) : !snap ? (
            <p className={s.muted}>Nothing captured yet. A snapshot of the key totals is taken when the month is released.</p>
          ) : (
            <div className={s.figs}>
              <div><span>Revenue</span><b>{money(snap.revenueCents)}</b></div>
              <div><span>Net income</span><b>{money(snap.netIncomeCents)}</b></div>
              <div><span>Cost of sales</span><b>{money(snap.cogsCents)}</b></div>
              <div><span>Operating expenses</span><b>{money(snap.opexCents)}</b></div>
              <div><span>Assets at month end</span><b>{snap.assetsCents === null ? '—' : money(snap.assetsCents)}</b></div>
              <div><span>Posted entries</span><b>{snap.postedEntryCount}</b></div>
            </div>
          )}
        </PanelSection>

        {restatements.length > 0 && (
          <PanelSection title="Restated" meta={`${restatements.length} time${restatements.length === 1 ? '' : 's'}`}>
            {restatements.map((r) => (
              <p key={r.id} style={{ margin: '0 0 8px' }}>
                <b>{dayName(r.detectedAt)}</b>: net income {money(r.netIncomeDeltaCents, { sign: 'delta' })}
                {r.reopenReason ? ` — reopened: ${r.reopenReason}` : ''}
                {r.acknowledgement ? <><br /><span className={s.muted}>{r.acknowledgement}</span></> : <><br /><span className={s.neg}>Not yet explained.</span></>}
              </p>
            ))}
          </PanelSection>
        )}

        {canRelease && (
          <PanelSection title="Release">
            {err && <InlineNotice tone="neg" title="Not released.">{err}</InlineNotice>}
            {cell.canRelease && (
              <>
                <Field label="Note for the record (optional)" className={s.field}>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} placeholder="Board pack sent" />
                </Field>
                {cell.closeStatus === 'SOFT_CLOSE' && (
                  <p className={s.muted}>This month is soft-closed. Partners will see it marked preliminary until it is closed.</p>
                )}
              </>
            )}
            <div className={s.actions}>
              {cell.canRelease && (
                <Button variant="primary" onClick={() => void release()} disabled={busy} aria-busy={busy || undefined}>
                  {cell.release.released ? `Re-release ${monthName(cell.key)}` : `Release ${monthName(cell.key)}`}
                </Button>
              )}
              {cell.canWithdraw && (
                <Button variant="danger" onClick={() => setConfirmWithdraw(true)}>
                  Take back {monthName(cell.key)}
                </Button>
              )}
              {!cell.canRelease && !cell.canWithdraw && <span className={s.muted}>Nothing to do for this month yet.</span>}
            </div>
          </PanelSection>
        )}
      </Drawer>

      <ConfirmDialog
        open={confirmWithdraw}
        onClose={() => setConfirmWithdraw(false)}
        onConfirm={withdraw}
        tone="danger"
        title={`Take ${monthName(cell.key)} back from partners?`}
        confirmLabel={`Take back ${monthName(cell.key)}`}
        reason={{ label: 'Why (kept in the audit log)', minLength: 4, placeholder: 'Accrual review pending' }}
      >
        Partners, lenders and department heads stop seeing {row.name}&apos;s {monthName(cell.key)} figures in every report until it is released again.
        The auto rule will not release it again on its own.
      </ConfirmDialog>
    </>
  );
}
