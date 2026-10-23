/**
 * Per-link AI-read budget for the PUBLIC vendor upload portal (security review M11).
 *
 * Every certificate a vendor uploads is read by AI in-request. The in-memory rate limiter
 * is per instance, so a hostile link holder could still spend the tenant's AI budget across
 * serverless instances. This caps AI reads per portal link per UTC day in the DB counter
 * from migration 178 (core.outbound_send_counters via core.bump_send_quota, scope
 * 'portal_ai_day' — widened in migration 180 §7b), so it holds everywhere.
 *
 * Over the cap (or counter unreadable — fail closed) the upload is still STORED and queued
 * for a person; only the AI read is skipped.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';

/** AI reads one portal link may trigger per UTC day. */
export const PORTAL_AI_READS_PER_DAY = 3;

export type PortalAiBudget = { ok: true; used: number } | { ok: false; reason: 'over_cap' | 'unavailable'; note: string };

export async function consumePortalAiRead(
  orgId: string,
  tokenId: string,
  opts: { writer?: SupabaseClient | null; now?: Date; limit?: number } = {},
): Promise<PortalAiBudget> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? PORTAL_AI_READS_PER_DAY;
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const { data, error } = await serviceWriter(opts.writer).schema('core').rpc('bump_send_quota', {
    p_org: orgId,
    p_scope: 'portal_ai_day',
    p_key: `token:${tokenId}`.slice(0, 200),
    p_window_start: day.toISOString(),
    p_inc: 1,
  });
  const n = Number(data);
  if (error || !Number.isFinite(n)) {
    return { ok: false, reason: 'unavailable', note: 'Automatic reading is unavailable right now.' };
  }
  if (n > limit) {
    return { ok: false, reason: 'over_cap', note: `This link has used its ${limit} automatic reads for today.` };
  }
  return { ok: true, used: n };
}
