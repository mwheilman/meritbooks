import { Status } from '@meritbooks/merit-ui';
import { date, deadlineText, impactText } from '@/lib/portal/format';
import { kindLabel, t, type PortalKey } from '@/lib/portal/i18n';
import { isExternal, itemHref, sortQueue, urgency } from '@/lib/portal/queue';
import type { Locale, QueueItem } from '@/lib/portal/types';

const URGENCY_WORD: Readonly<Record<ReturnType<typeof urgency>, PortalKey>> = {
  overdue: 'due.late', risk: 'due.today', track: 'job.upcoming', ready: 'item.sent',
};

/** Everything waiting on the person: kind, title, job, deadline and $ impact, one action each. */
export function QueueList({ orgId, items, locale, now = new Date() }: { orgId: string; items: readonly QueueItem[]; locale: Locale; now?: Date }) {
  if (items.length === 0) return <p className="pt-empty">{t(locale, 'home.empty')}</p>;
  return (
    <div role="list" aria-label={t(locale, 'home.title')}>
      {sortQueue(items, now).map((i) => {
        const href = itemHref(orgId, i);
        const u = urgency(i, now);
        const due = deadlineText(i.deadline ?? null, locale, now);
        const impact = impactText(i, locale);
        const company = i.job?.company ?? '';
        return (
          <a key={`${i.kind}:${i.id}`} role="listitem" className="pt-card" href={href}
             {...(isExternal(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
            <div className="top">
              <span className="pt-cap">{kindLabel(locale, i.kind)}{i.number ? ` · ${i.number}` : ''}</span>
              <Status kind={u === 'ready' ? 'ready' : u} pip={u === 'ready' ? 'closed' : 'open'}>
                {u === 'ready' ? t(locale, 'home.sent', { company }) : due || t(locale, URGENCY_WORD[u])}
              </Status>
            </div>
            <div className="ttl">{i.title}</div>
            <div className="meta">
              {i.job && <span>{i.job.name}</span>}
              {impact && <span className="impact">{impact}</span>}
              {i.kind === 'assignment' && i.deadline && <span>{date(i.deadline, locale)}{i.finish ? ` – ${date(i.finish, locale)}` : ''}</span>}
            </div>
            {u !== 'ready' && <span className="go">{t(locale, `action.${i.action}` as PortalKey)} →</span>}
          </a>
        );
      })}
    </div>
  );
}
