/** Presentation helpers shared by the Flux review screen and its panel (client-safe). */

import type { PipKind } from '@meritbooks/merit-ui';
import type { DriverTag, FluxLineStatus } from '@/lib/close/flux/types';

export function pctText(bps: number | null): string {
  if (bps === null) return 'new';
  return `${bps > 0 ? '+' : ''}${(bps / 100).toFixed(1)}%`;
}

export const STATUS: Record<FluxLineStatus, { pip: PipKind; word: string }> = {
  UNEXPLAINED: { pip: 'blocked', word: 'Unexplained' },
  DRAFT: { pip: 'open', word: 'Draft' },
  EXPLAINED: { pip: 'track', word: 'Awaiting review' },
  REVIEWED: { pip: 'ready', word: 'Reviewed' },
  STALE: { pip: 'overdue', word: 'Numbers moved' },
};

export const TAG_LABEL: Record<DriverTag, string> = {
  LARGEST: 'Largest',
  NEW_COUNTERPARTY: 'New counterparty',
  ONE_OFF: 'One-off',
  RECLASS: 'Reclass',
};

export function who(names: Record<string, string>, id: string | null | undefined, me: string | null | undefined): string {
  if (!id) return '—';
  if (me && id === me) return 'You';
  return names[id] ?? 'A teammate';
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
