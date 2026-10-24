import 'server-only';
/** One lead with everything its page shows: timeline, follow-ups, stage history, the person and site. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Access } from '@/lib/access/types';
import { buildLeadViews, loadLeadContext, type LeadContext } from './build';
import { contactsByIds, getLead, listPipelines, memberNames, sitesByIds } from './queries';
import { contactName, siteAddress, type ActivityKind, type Direction, type Pipeline } from './types';
import type { LeadView } from './view';

export interface TimelineItem {
  id: string;
  at: string;
  kind: ActivityKind | 'stage';
  direction: Direction | null;
  subject: string | null;
  body: string | null;
  outcome: string | null;
  who: string | null;
}

export interface FollowupView {
  id: string;
  dueOn: string;
  kind: string;
  assignee: string | null;
  doneAt: string | null;
  cadence: string | null;
}

export interface LeadDetail {
  lead: LeadView;
  pipeline: Pipeline;
  timeline: TimelineItem[];
  followups: FollowupView[];
  contact: { id: string; name: string; email: string | null; phone: string | null; smsConsent: boolean; emailConsent: boolean } | null;
  site: { id: string; address: string; accessNotes: string | null } | null;
}

export async function loadLeadDetail(
  db: SupabaseClient,
  access: Access,
  companies: ReadonlyArray<{ id: string; name: string }>,
  leadId: string,
  opts: { nowMs: number; today: string },
): Promise<LeadDetail | null> {
  const row = await getLead(db, leadId);
  if (!row) return null;
  const pipes = await listPipelines(db, [row.location_id]);
  const pipeline = pipes.find((p) => p.id === row.pipeline_id);
  if (!pipeline) return null;
  const ctx: LeadContext = await loadLeadContext(db, [row.id]);
  const [views, contacts, sites, who] = await Promise.all([
    buildLeadViews(db, [row], pipes, access, companies, { ...opts, ctx }),
    contactsByIds(db, [row.contact_id]),
    sitesByIds(db, [row.site_id]),
    memberNames(db, [...ctx.followups.map((f) => f.assigned_membership_id), ...ctx.events.map((e) => e.actor_id), ...ctx.activities.map((a) => a.created_by)]),
  ]);
  const lead = views[0];
  if (!lead) return null;
  const stageName = (id: string | null) => pipeline.stages.find((s) => s.id === id)?.name ?? 'a removed stage';
  const name = (m: string | null) => (m ? (m === access.membershipId ? 'You' : who.get(m) ?? null) : null);

  const timeline: TimelineItem[] = [
    ...ctx.activities.map((a): TimelineItem => ({
      id: a.id, at: a.occurred_at, kind: a.kind, direction: a.direction, subject: a.subject, body: a.body, outcome: a.outcome, who: name(a.created_by),
    })),
    ...ctx.events.map((e): TimelineItem => ({
      id: e.id, at: e.created_at, kind: 'stage', direction: null,
      subject: e.from_stage_id ? `Moved from ${stageName(e.from_stage_id)} to ${stageName(e.to_stage_id)}` : `Started in ${stageName(e.to_stage_id)}`,
      body: e.reason, outcome: null, who: name(e.actor_id),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const c = row.contact_id ? contacts.get(row.contact_id) : undefined;
  const s = row.site_id ? sites.get(row.site_id) : undefined;
  return {
    lead,
    pipeline,
    timeline,
    followups: ctx.followups.map((f) => ({ id: f.id, dueOn: f.due_on, kind: f.kind, assignee: name(f.assigned_membership_id), doneAt: f.done_at, cadence: f.cadence_key })),
    contact: c ? { id: c.id, name: contactName(c), email: c.email, phone: c.phone, smsConsent: c.sms_consent, emailConsent: c.email_consent } : null,
    site: s ? { id: s.id, address: siteAddress(s) || s.name || 'Site', accessNotes: s.access_notes } : null,
  };
}
