/** Activity rows → one plain sentence each (money through merit-ui, never "N cents"). Pure. */
import { money } from '@meritbooks/merit-ui';
import { CO_STAGE_WORDS } from './stage';
import type { ActivityRow, ChangeOrderStage } from './types';

const TRIGGERS: Record<string, string> = {
  CONTRACT_SET: 'contract set',
  CHANGE_ORDER: 'change order',
  PROGRESS_UPDATE: 'progress update',
  BUDGET_REVISED: 'budget revised',
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function activitySentence(a: Pick<ActivityRow, 'verb' | 'summary' | 'meta'>): string {
  const m = a.meta ?? {};
  const s = a.summary ?? '';
  switch (a.verb) {
    case 'contract.set': {
      const c = num(m.original_cents);
      return c == null ? 'Set the contract' : `Set the contract to ${money(c)}`;
    }
    case 'change_order.approved': {
      const n = /Approved (\S+)/.exec(s)?.[1];
      const c = num(m.amount_cents);
      return `Approved ${n ?? 'a change order'}${c == null ? '' : ` for ${money(c)}`}`;
    }
    case 'progress.snapshot': {
      const v = num(m.snapshot_version);
      const trig = /\(([A-Z_]+)\)/.exec(s)?.[1];
      const why = trig ? ` (${TRIGGERS[trig] ?? trig.toLowerCase().replace(/_/g, ' ')})` : '';
      if (/sent to Books/.test(s)) return `Sent progress v${v ?? ''} to Merit Books${why}`;
      if (/sample/.test(s)) return `Recorded progress v${v ?? ''}${why}; not sent, sample job`;
      if (/standalone/.test(s)) return `Recorded progress v${v ?? ''}${why}; not sent, Merit Books is not on`;
      return s || 'Recorded a progress snapshot';
    }
    case 'pack.applied': {
      const key = str(m.pack_key);
      const ver = str(m.version);
      return key ? `Set up the ${key.replace(/_/g, ' ')} industry pack${ver ? ` ${ver}` : ''}` : 'Applied the industry setup';
    }
    default:
      if (a.verb.startsWith('change_order.')) {
        const mv = /^(\S+) moved (\w+) → (\w+)/.exec(s);
        if (mv) return `Moved ${mv[1]} from ${CO_STAGE_WORDS[mv[2] as ChangeOrderStage] ?? mv[2]} to ${CO_STAGE_WORDS[mv[3] as ChangeOrderStage] ?? mv[3]}`;
      }
      return s || a.verb.replace(/[._]/g, ' ');
  }
}

export function actorWord(a: Pick<ActivityRow, 'actor_type'>): string {
  return a.actor_type === 'AI' ? 'AI' : a.actor_type === 'SYSTEM' ? 'System' : '';
}
