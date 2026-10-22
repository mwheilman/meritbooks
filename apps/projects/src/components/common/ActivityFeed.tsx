import Link from 'next/link';
import { Tag } from '@meritbooks/merit-ui';
import { stamp } from '@/lib/time';
import { activitySentence } from '@/lib/pm/activity-copy';
import type { ActivityRow } from '@/lib/pm/types';

export interface ActivityFeedProps {
  rows: ReadonlyArray<ActivityRow>;
  /** job_id → "J-1042 Ankeny clinic" for cross-job feeds. */
  jobLabels?: Readonly<Record<string, string>>;
  /** location_id → company name (workspace feeds). */
  companyNames?: Readonly<Record<string, string>>;
  flush?: boolean;
  /** Contract-side amounts in the sentences ("Set the contract to 48,000.00"). Off unless the caller holds contract_value. */
  showMoney?: boolean;
}

/** Drop every *_cents key so the sentence reads without the amount. */
function withoutMoney(a: ActivityRow): ActivityRow {
  if (!a.meta) return a;
  return { ...a, meta: Object.fromEntries(Object.entries(a.meta).filter(([k]) => !k.endsWith('_cents'))) };
}

/** The pm.activity feed: one sentence per row, the job and company when it spans many. */
export function ActivityFeed({ rows, jobLabels, companyNames, flush, showMoney = false }: ActivityFeedProps) {
  return (
    <ul className={flush ? 'feed feed--flush' : 'feed'}>
      {rows.map((a) => {
        const where = [a.job_id && jobLabels?.[a.job_id], a.location_id && companyNames?.[a.location_id]].filter(Boolean).join(' · ');
        return (
          <li key={a.id}>
            <span style={{ minWidth: 0 }}>
              <span className="l1" style={{ fontWeight: 400 }}>
                {activitySentence(showMoney ? a : withoutMoney(a))} {a.actor_type !== 'HUMAN' ? <Tag tone={a.actor_type === 'AI' ? 'ai' : 'default'}>{a.actor_type === 'AI' ? 'AI' : 'System'}</Tag> : null}
              </span>
              {where ? (
                a.job_id ? (
                  <Link className="l2 nlink" href={`/jobs/${a.job_id}`}>{where}</Link>
                ) : (
                  <span className="l2">{where}</span>
                )
              ) : null}
            </span>
            <span className="t">{stamp(a.created_at)}</span>
          </li>
        );
      })}
    </ul>
  );
}
