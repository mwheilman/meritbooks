import type { Crumb } from '@meritbooks/merit-ui';
import { AREAS } from '@/lib/areas';
import type { Vocabulary } from '@/lib/pm/vocab';

/** Default breadcrumbs from the path (pages with objects set their own). */
export function crumbsFor(pathname: string, vocab: Vocabulary): Crumb[] {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return [{ label: 'Home' }];
  const first = parts[0] ?? '';
  const named: Record<string, string> = {
    jobs: vocab.jobs,
    review: 'To review',
    'change-orders': vocab.change_orders,
    schedule: 'Schedule',
    activity: 'Activity',
    settings: 'Settings',
    insights: 'Insights',
  };
  const area = AREAS.find((x) => x.slug === first);
  const label = named[first] ?? (area ? (area.vocab ? vocab[area.vocab] : area.title) : first);
  if (parts.length === 1) return [{ label }];
  if (first === 'insights') return [{ label: 'Insights' }, { label: parts[1] === 'backlog' ? 'Backlog' : 'Margin by job' }];
  return [{ label, href: `/${first}` }, { label: '…' }];
}
