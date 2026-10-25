import { Status } from '@meritbooks/merit-ui';
import { date, dateTime, money } from '@/lib/portal/format';
import { t } from '@/lib/portal/i18n';
import type { DrawRow, HouseholdMember, LogEntry, Locale, Milestone, Photo, RequestRow, SharedDoc } from '@/lib/portal/types';

const fileHref = (orgId: string, kind: 'document' | 'photo', id: string) => `/api/portal/files?orgId=${orgId}&kind=${kind}&id=${id}`;

export function MilestoneList({ items, locale }: { items: readonly Milestone[]; locale: Locale }) {
  if (items.length === 0) return <p className="pt-empty">{t(locale, 'job.no_schedule')}</p>;
  return (
    <ul className="pt-list">
      {items.map((m) => {
        const done = m.status === 'DONE';
        const going = m.status === 'IN_PROGRESS';
        return (
          <li key={m.id} className="pt-ms">
            <Status kind={done ? 'ready' : going ? 'track' : 'track'} pip={done ? 'closed' : going ? 'open' : 'soft'}>
              {t(locale, done ? 'job.done' : going ? 'job.in_progress' : 'job.upcoming')}
            </Status>
            <span>{m.title}</span>
            <span className="pt-cap">{date(m.start, locale)}{m.finish && m.finish !== m.start ? ` – ${date(m.finish, locale)}` : ''}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function PhotoGrid({ orgId, photos, locale }: { orgId: string; photos: readonly Photo[]; locale: Locale }) {
  if (photos.length === 0) return <p className="pt-empty">{t(locale, 'job.no_photos')}</p>;
  return (
    <div className="pt-photos">
      {photos.map((p) => (
        <a key={p.id} href={fileHref(orgId, 'photo', p.id)} target="_blank" rel="noopener noreferrer" title={[p.area, dateTime(p.taken_at, locale)].filter(Boolean).join(' · ')}>
          <img src={fileHref(orgId, 'photo', p.id)} alt={p.area ?? t(locale, 'job.photos')} loading="lazy" />
        </a>
      ))}
    </div>
  );
}

export function LogList({ logs, locale }: { logs: readonly LogEntry[]; locale: Locale }) {
  if (logs.length === 0) return <p className="pt-empty">{t(locale, 'job.no_updates')}</p>;
  return (
    <ul className="pt-list">
      {logs.map((l) => (
        <li key={l.id}>
          <p className="pt-cap">{date(l.date, locale)}{l.weather ? ` · ${l.weather}` : ''}</p>
          <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{l.body}</p>
        </li>
      ))}
    </ul>
  );
}

export function DocList({ orgId, docs, locale }: { orgId: string; docs: readonly SharedDoc[]; locale: Locale }) {
  if (docs.length === 0) return <p className="pt-empty">{t(locale, 'job.no_documents')}</p>;
  return (
    <ul className="pt-list">
      {docs.map((d) => (
        <li key={d.id} className="pt-row">
          <a href={fileHref(orgId, 'document', d.id)} target="_blank" rel="noopener noreferrer">{d.title}</a>
          <span className="pt-cap">{date(d.updated_at, locale)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Household({ people, locale }: { people: readonly HouseholdMember[]; locale: Locale }) {
  return (
    <ul className="pt-list">
      {people.map((p, i) => (
        <li key={i} className="pt-row">
          <span>{p.name}{p.you ? ` (${t(locale, 'job.you')})` : ''}</span>
          <span className="pt-cap">
            {[p.can_sign ? t(locale, 'job.can_sign') : null, p.can_pay ? t(locale, 'job.can_pay') : null].filter(Boolean).join(' · ') || t(locale, 'job.viewer')}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RequestList({ rows, locale }: { rows: readonly RequestRow[]; locale: Locale }) {
  if (rows.length === 0) return null;
  return (
    <ul className="pt-list">
      {rows.map((r) => (
        <li key={r.id} className="pt-row">
          <span>{r.title}</span>
          <span className="pt-cap">{t(locale, r.kind === 'warranty' ? 'req.kind_warranty' : 'req.kind_service')} · {date(r.created_at, locale)} · {r.status}</span>
        </li>
      ))}
    </ul>
  );
}

export function DrawList({ orgId, draws, locale }: { orgId: string; draws: readonly DrawRow[]; locale: Locale }) {
  return (
    <ul className="pt-list">
      {draws.map((d) => (
        <li key={d.id} className="pt-row">
          <a href={`/portal/o/${orgId}/draws/${d.id}`}>{t(locale, 'draw.title', { n: d.number })}</a>
          <span className="pt-cap">{date(d.period_end, locale)} · {d.status}</span>
          <span className="n">{money(d.funded_cents ?? d.approved_cents ?? d.requested_cents, locale)}</span>
        </li>
      ))}
    </ul>
  );
}
