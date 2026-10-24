'use client';

import { Pip, type PipKind } from '@meritbooks/merit-ui';
import { ago, dayName, monthName, type CalendarResponse, type DeadlineTile, type FreshnessCard } from './types';
import s from './reporting-calendar.module.css';

const STATUS: Record<FreshnessCard['status'], { word: string; pip: PipKind }> = {
  current: { word: 'Current', pip: 'ready' },
  behind: { word: 'Behind', pip: 'risk' },
  attention: { word: 'Needs attention', pip: 'overdue' },
  nothing: { word: 'Nothing on file', pip: 'closed' },
};

const DEADLINE: Record<DeadlineTile['state'], { word: string; pip: PipKind }> = {
  met: { word: 'Met', pip: 'ready' },
  met_late: { word: 'Met late', pip: 'risk' },
  due: { word: 'Due', pip: 'track' },
  due_soon: { word: 'Due soon', pip: 'risk' },
  overdue: { word: 'Overdue', pip: 'overdue' },
};

function Tiles({ tiles, title }: { tiles: DeadlineTile[]; title: string }) {
  if (tiles.length === 0) return null;
  return (
    <section aria-label={title}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>{title}</div>
      <div className={s.tiles}>
        {tiles.map((t) => (
          <div key={t.key} className={s.tile}>
            <span className={s.cellL}>{t.label}{t.recipient ? ` · ${t.recipient}` : ''}</span>
            <span className={s.tileDue}>{dayName(t.dueDate)}</span>
            <span className={s.cellS}>
              <Pip kind={DEADLINE[t.state].pip} /> {DEADLINE[t.state].word} — {t.text}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Card({ c, today }: { c: FreshnessCard; today: string }) {
  const st = STATUS[c.status];
  const items: Array<[string, string]> = [
    ['Bank feed', c.hasBankFeed ? `${ago(c.lastBankSyncAt, today)}${c.bankHealth && c.bankHealth !== 'active' ? ' (reconnect)' : ''}` : 'Not connected'],
    ['Last posted entry', ago(c.lastPostedAt, today)],
    ['Books closed through', monthName(c.closedThrough)],
    ['Partners see through', monthName(c.releasedThrough)],
    [
      'Open items',
      c.nextCloseKey
        ? c.openItems
          ? `${c.openItems.total} for ${monthName(c.nextCloseKey)}`
          : `— for ${monthName(c.nextCloseKey)}`
        : 'None — every ended month is closed',
    ],
    ['In group from', c.inGroupFrom ? dayName(c.inGroupFrom) : 'Not set'],
  ];
  return (
    <article className={s.card} aria-label={`${c.name}: ${st.word}`}>
      <div className={s.cardHead}>
        <h3>{c.name}</h3>
        <span className="t-cap"><Pip kind={st.pip} /> {st.word}</span>
      </div>
      <dl className={s.kv}>
        {items.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {c.status !== 'current' && c.reasons.length > 0 && (
        <ul className={s.reasons}>
          {c.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      {c.note && <p className={s.muted} style={{ margin: '8px 0 0' }}>{c.note}</p>}
    </article>
  );
}

export function FreshnessTab({ data }: { data: CalendarResponse }) {
  const perCompany = data.calendar.rows.filter((r) => r.deadlines.length > 0);
  return (
    <div>
      {data.calendar.tenantDeadlines.length === 0 && perCompany.length === 0 ? (
        <p className={s.sentence}>No reporting deadlines set. Add them under Release rule (for example a monthly package within 45 days).</p>
      ) : (
        <>
          <Tiles tiles={data.calendar.tenantDeadlines} title="Reporting deadlines — every company" />
          {perCompany.map((r) => <Tiles key={r.locationId} tiles={r.deadlines} title={`Reporting deadlines — ${r.name}`} />)}
        </>
      )}
      {data.freshness.length === 0 ? (
        <div className={`${s.surface} ${s.state}`}>
          <h2 className="t-section">No companies yet</h2>
        </div>
      ) : (
        <div className={s.cards}>
          {data.freshness.map((c) => <Card key={c.locationId} c={c} today={data.today} />)}
        </div>
      )}
    </div>
  );
}
