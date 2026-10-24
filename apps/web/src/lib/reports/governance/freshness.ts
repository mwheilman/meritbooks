/**
 * Per-company freshness card (FPB §18.4): last bank sync, last posted entry, open items
 * still blocking the next close, books closed through, last release, in group from.
 *
 *   freshnessStatus(input)   PURE  current | behind | attention | nothing (+ reasons)
 *   loadFreshness(...)       I/O   RLS-scoped reads (bank_accounts → plaid_items, gl_entries,
 *                                  the close open-items scan)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { gatherOpenItemsByLocation, type LocationCloseContext, type OpenItemsCounts } from '@/lib/close/open-items';
import { addMonths, daysBetween, monthLabel, periodKey } from './periods';
import { closedThrough, releasedThrough } from './policy';
import type { CompanyFacts, PeriodKey } from './types';

export type FreshnessStatus = 'current' | 'behind' | 'attention' | 'nothing';

export interface FreshnessInput {
  today: string;
  hasBooks: boolean;
  hasBankFeed: boolean;
  lastBankSyncAt: string | null;
  bankHealth: 'active' | 'login_required' | 'error' | null;
  closedThrough: PeriodKey | null;
  /** Stale-feed threshold in days (default 3). */
  staleBankDays?: number;
}

export function freshnessStatus(i: FreshnessInput): { status: FreshnessStatus; reasons: string[] } {
  if (!i.hasBooks) return { status: 'nothing', reasons: ['No books on file yet.'] };
  const reasons: string[] = [];
  const stale = i.staleBankDays ?? 3;
  let attention = false;
  if (i.bankHealth === 'login_required') {
    attention = true;
    reasons.push('A bank connection needs the owner to sign in again.');
  } else if (i.bankHealth === 'error') {
    attention = true;
    reasons.push('A bank connection is failing.');
  }
  if (i.hasBankFeed) {
    if (!i.lastBankSyncAt) {
      attention = true;
      reasons.push('The bank feed has never synced.');
    } else {
      const age = daysBetween(i.lastBankSyncAt.slice(0, 10), i.today);
      if (age > stale) {
        attention = true;
        reasons.push(`The bank feed last synced ${age} days ago.`);
      }
    }
  }
  if (attention) return { status: 'attention', reasons };
  // Behind: more than one full month not closed (on Oct 24, August must be closed).
  const expected = addMonths(i.today.slice(0, 7), -2);
  if (!i.closedThrough || i.closedThrough < expected) {
    reasons.push(i.closedThrough ? `Books are closed only through ${monthLabel(i.closedThrough)}.` : 'No month is closed yet.');
    return { status: 'behind', reasons };
  }
  return { status: 'current', reasons: [`Closed through ${monthLabel(i.closedThrough)}.`] };
}

export interface FreshnessCard {
  locationId: string;
  name: string;
  status: FreshnessStatus;
  reasons: string[];
  lastBankSyncAt: string | null;
  bankHealth: 'active' | 'login_required' | 'error' | null;
  hasBankFeed: boolean;
  lastPostedAt: string | null;
  /** The month the next close is for (earliest ended month not hard-closed). */
  nextCloseKey: PeriodKey | null;
  openItems: (OpenItemsCounts & { total: number }) | null;
  closedThrough: PeriodKey | null;
  releasedThrough: PeriodKey | null;
  inGroupFrom: string | null;
  inGroupUntil: string | null;
  note: string | null;
}

interface BankAcctRow { location_id: string | null; plaid_item_pk: string | null }
interface ItemRow { id: string; last_synced_at: string | null; status: 'active' | 'login_required' | 'error' }
interface PostedRow { posted_at: string | null }
interface NoteRow { location_id: string; note: string | null }

const HEALTH_RANK = { active: 0, login_required: 1, error: 2 } as const;

/** The earliest ended month that is not HARD_CLOSE — the close the team is working on. */
export function nextCloseKey(company: CompanyFacts, today: string): PeriodKey | null {
  const sorted = [...company.periods].sort((a, b) => a.year - b.year || a.month - b.month);
  for (const p of sorted) if (p.endDate < today && p.status !== 'HARD_CLOSE') return periodKey(p.year, p.month);
  return null;
}

export async function loadFreshness(
  supabase: SupabaseClient,
  orgId: string,
  companies: CompanyFacts[],
  today: string,
): Promise<FreshnessCard[]> {
  if (companies.length === 0) return [];
  const ids = companies.map((c) => c.locationId);

  const { data: accts } = await supabase.from('bank_accounts').select('location_id, plaid_item_pk').eq('org_id', orgId).eq('is_active', true).in('location_id', ids);
  const accounts = (accts ?? []) as BankAcctRow[];
  const itemIds = Array.from(new Set(accounts.map((a) => a.plaid_item_pk).filter((x): x is string => !!x)));
  const items = new Map<string, ItemRow>();
  if (itemIds.length) {
    const { data } = await supabase.from('plaid_items').select('id, last_synced_at, status').eq('org_id', orgId).in('id', itemIds);
    for (const r of (data ?? []) as ItemRow[]) items.set(r.id, r);
  }

  const { data: notesData } = await supabase.from('report_company_coverage').select('location_id, note').eq('org_id', orgId).in('location_id', ids);
  const notes = new Map(((notesData ?? []) as NoteRow[]).map((n) => [n.location_id, n.note]));

  // Open items for each company's next close.
  const contexts: LocationCloseContext[] = [];
  const nextKeys = new Map<string, PeriodKey | null>();
  for (const c of companies) {
    const k = nextCloseKey(c, today);
    nextKeys.set(c.locationId, k);
    if (!k) continue;
    const [y, m] = k.split('-').map(Number);
    const p = c.periods.find((x) => x.year === y && x.month === m);
    contexts.push({ locationId: c.locationId, periodId: p?.id ?? null, periodEndISO: p?.endDate ?? null });
  }
  let open = new Map<string, OpenItemsCounts>();
  try {
    open = await gatherOpenItemsByLocation(supabase, contexts);
  } catch {
    open = new Map();
  }

  const cards: FreshnessCard[] = [];
  for (const c of companies) {
    const mine = accounts.filter((a) => a.location_id === c.locationId);
    let lastSync: string | null = null;
    let health: FreshnessCard['bankHealth'] = null;
    for (const a of mine) {
      const it = a.plaid_item_pk ? items.get(a.plaid_item_pk) : undefined;
      if (!it) continue;
      if (it.last_synced_at && (!lastSync || it.last_synced_at > lastSync)) lastSync = it.last_synced_at;
      if (!health || HEALTH_RANK[it.status] > HEALTH_RANK[health]) health = it.status;
    }
    const hasBankFeed = mine.some((a) => !!a.plaid_item_pk);

    const { data: posted } = await supabase
      .from('gl_entries')
      .select('posted_at')
      .eq('org_id', orgId)
      .eq('location_id', c.locationId)
      .eq('status', 'POSTED')
      .not('posted_at', 'is', null)
      .order('posted_at', { ascending: false })
      .limit(1);
    const lastPostedAt = ((posted ?? []) as PostedRow[])[0]?.posted_at ?? null;

    const ct = closedThrough(c);
    const st = freshnessStatus({
      today,
      hasBooks: c.periods.length > 0 || !!lastPostedAt,
      hasBankFeed,
      lastBankSyncAt: lastSync,
      bankHealth: health,
      closedThrough: ct,
    });
    const oi = open.get(c.locationId);
    cards.push({
      locationId: c.locationId,
      name: c.name,
      status: st.status,
      reasons: st.reasons,
      lastBankSyncAt: lastSync,
      bankHealth: health,
      hasBankFeed,
      lastPostedAt,
      nextCloseKey: nextKeys.get(c.locationId) ?? null,
      openItems: oi && nextKeys.get(c.locationId)
        ? { ...oi, total: oi.unpostedDraftCount + oi.billsOnHoldCount + oi.unappliedPaymentCount + oi.pendingApprovalCount }
        : null,
      closedThrough: ct,
      releasedThrough: releasedThrough(c, today),
      inGroupFrom: c.coverage?.inGroupFrom ?? null,
      inGroupUntil: c.coverage?.inGroupUntil ?? null,
      note: notes.get(c.locationId) ?? null,
    });
  }
  return cards;
}
