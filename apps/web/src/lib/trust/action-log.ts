import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveActor } from '@/lib/trust/actor';

export type ActorType = 'HUMAN' | 'AI' | 'SYSTEM';
export type Tier = 'auto' | 'review' | 'escalate';

export interface ActionLogEntry {
  orgId: string;
  actorType: ActorType;
  actorUserId?: string | null; // core.users uuid; null for AI/SYSTEM
  action: string; // e.g. 'team.member.add', 'bankfeed.approve'
  subjectTable?: string | null;
  subjectId?: string | null;
  summary?: string | null;
  locationId?: string | null;
  confidence?: number | null; // AI only (0..1)
  tier?: Tier | null;
  correlationId?: string | null; // link to ai_decisions / ai_usage
  metadata?: Record<string, unknown>;
}

/**
 * Append one row to core.action_log. NEVER throws — trust logging must not break
 * the underlying action. Uses the request-scoped (RLS) client; the org_insert
 * policy enforces org scoping.
 */
export async function logAction(supabase: SupabaseClient, e: ActionLogEntry): Promise<void> {
  try {
    const { error } = await supabase.schema('core').from('action_log').insert({
      org_id: e.orgId,
      location_id: e.locationId ?? null,
      actor_type: e.actorType,
      actor_user_id: e.actorUserId ?? null,
      action: e.action,
      subject_table: e.subjectTable ?? null,
      subject_id: e.subjectId ?? null,
      summary: e.summary ?? null,
      confidence: e.confidence ?? null,
      tier: e.tier ?? null,
      correlation_id: e.correlationId ?? null,
      metadata: e.metadata ?? {},
    });
    if (error) console.error('[action_log] insert failed:', error.message);
  } catch (err) {
    console.error('[action_log] insert threw:', err instanceof Error ? err.message : err);
  }
}

/**
 * Convenience for a HUMAN action from an authenticated route: resolves the actor
 * uuid from the Clerk id (auto-provisioning core.users) and logs in one call.
 */
export async function logHumanAction(
  supabase: SupabaseClient,
  clerkUserId: string,
  orgId: string,
  e: Omit<ActionLogEntry, 'orgId' | 'actorType' | 'actorUserId'>,
): Promise<void> {
  const { coreUserId } = await resolveActor(supabase, clerkUserId);
  await logAction(supabase, { ...e, orgId, actorType: 'HUMAN', actorUserId: coreUserId });
}
