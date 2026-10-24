'use client';

import { useState } from 'react';
import { api, Button, ConfirmDialog, money, toast } from '@meritbooks/merit-ui';
import { dayName, monthName, type CalendarResponse, type RestatementLogEntry } from './types';
import s from './reporting-calendar.module.css';

const DETECTION: Record<string, string> = {
  ON_READ: 'Found on review',
  ON_RELEASE: 'Found on re-release',
  SCHEDULED: 'Nightly check',
  MANUAL: 'Manual check',
};

/** The restatement log: released months whose numbers changed, with the cause. */
export function RestatementsTab({ data, onChanged }: { data: CalendarResponse; onChanged: () => void }) {
  const [ack, setAck] = useState<RestatementLogEntry | null>(null);
  const [checking, setChecking] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    const res = await api.post<{ checked: number; restated: number }>('/api/report-governance/restatements/check', {});
    setChecking(false);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    toast(`${res.data?.checked ?? 0} released month(s) checked; ${res.data?.restated ?? 0} changed.`);
    onChanged();
  };

  const acknowledge = async (note?: string) => {
    if (!ack) return;
    const res = await api.post('/api/report-governance/restatements/acknowledge', { id: ack.id, note: note ?? '' });
    if (res.error) throw new Error(res.error.error);
    toast('Explanation saved. It shows beside the restated month.');
    onChanged();
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <p className={s.sentence} style={{ margin: 0, flex: 1 }}>
          A released month is checked against what partners were shown. If posted numbers change (a reopened month, a late entry, a void), it is listed here with the difference and the entries that caused it.
        </p>
        {data.canRelease && (
          <Button onClick={() => void checkNow()} disabled={checking} aria-busy={checking || undefined}>Check now</Button>
        )}
      </div>
      {data.restatements.length === 0 ? (
        <div className={`${s.surface} ${s.state}`}>
          <h2 className="t-section">No restatements</h2>
          <p>Every released month still matches what was reported.</p>
        </div>
      ) : (
        <div className={s.gridWrap}>
          <table className={s.log}>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Company</th>
                <th scope="col" className={s.num}>Revenue change</th>
                <th scope="col" className={s.num}>Net income change</th>
                <th scope="col">What changed</th>
                <th scope="col">Found</th>
                <th scope="col">Explanation</th>
              </tr>
            </thead>
            <tbody>
              {data.restatements.map((r) => (
                <tr key={r.id}>
                  <td>{monthName(r.periodKey)}</td>
                  <td>{r.companyName}</td>
                  <td className={s.num}>{money(r.revenueDeltaCents, { sign: 'delta' })}</td>
                  <td className={s.num}>{money(r.netIncomeDeltaCents, { sign: 'delta' })}</td>
                  <td>
                    {r.changedAccounts.slice(0, 3).map((a) => `${a.account_number ?? ''} ${a.name ?? ''} ${money(a.delta_cents, { sign: 'delta' })}`.trim()).join(' · ') || '—'}
                    {r.causeEntries.length > 0 && (
                      <ul className={s.causes}>
                        {r.causeEntries.slice(0, 4).map((e) => (
                          <li key={e.gl_entry_id}>
                            {e.voided_at ? 'Voided' : 'Posted'} {e.entry_number ?? 'entry'} ({dayName(e.entry_date)}){e.memo ? ` — ${e.memo}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.reopenReason && <div className={s.muted}>Reopened: {r.reopenReason}</div>}
                  </td>
                  <td>
                    {dayName(r.detectedAt)}
                    <div className={s.muted}>{DETECTION[r.detection] ?? r.detection}</div>
                  </td>
                  <td>
                    {r.acknowledgement ? (
                      <>
                        {r.acknowledgement}
                        <div className={s.muted}>{dayName(r.acknowledgedAt)}</div>
                      </>
                    ) : data.canRelease ? (
                      <Button onClick={() => setAck(r)}>Explain</Button>
                    ) : (
                      <span className={s.neg}>Not yet explained</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!ack}
        onClose={() => setAck(null)}
        onConfirm={acknowledge}
        title={ack ? `Explain the ${monthName(ack.periodKey)} restatement — ${ack.companyName}` : 'Explain'}
        confirmLabel="Save explanation"
        reason={{ label: 'What changed and why', minLength: 4, placeholder: 'Late utility accrual; partners notified' }}
      >
        {ack ? `Net income moved ${money(ack.netIncomeDeltaCents, { sign: 'delta' })} after it was reported.` : null}
      </ConfirmDialog>
    </div>
  );
}
