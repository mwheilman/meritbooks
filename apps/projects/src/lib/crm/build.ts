import 'server-only';
/**
 * Lead rows → LeadView (the shape the board, list and lead page draw). Money is masked HERE,
 * per lead company, before anything crosses to the browser.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { can } from '@/lib/access/can';
import type { Access } from '@/lib/access/types';
import { contactName, siteAddress, sourceLabel, type ActivityRow, type FollowupRow, type LeadRow, type Pipeline, type StageEventRow } from './types';
import { daysSince, dueFollowups, enteredStageAt, firstTouchAt, needsNextStep, speedToLead, stageById, stageProbability } from './stages';
import { contactsByIds, customerNames, listActivities, listFollowups, listStageEvents, memberNames, sitesByIds } from './queries';
import type { LeadView } from './view';

export interface LeadContext {
  activities: ActivityRow[];
  followups: FollowupRow[];
  events: StageEventRow[];
}

export async function loadLeadContext(db: SupabaseClient, leadIds: ReadonlyArray<string>): Promise<LeadContext> {
  const [activities, followups, events] = await Promise.all([
    listActivities(db, { leadIds }),
    listFollowups(db, leadIds),
    listStageEvents(db, leadIds),
  ]);
  return { activities, followups, events };
}

export async function buildLeadViews(
  db: SupabaseClient,
  leads: ReadonlyArray<LeadRow>,
  pipelines: ReadonlyArray<Pipeline>,
  access: Access,
  companies: ReadonlyArray<{ id: string; name: string }>,
  opts: { nowMs: number; today: string; ctx?: LeadContext },
): Promise<LeadView[]> {
  const ids = leads.map((l) => l.id);
  const [ctx, customers, contacts, sites, owners] = await Promise.all([
    opts.ctx ? Promise.resolve(opts.ctx) : loadLeadContext(db, ids),
    customerNames(db, leads.map((l) => l.customer_id)),
    contactsByIds(db, leads.map((l) => l.contact_id)),
    sitesByIds(db, leads.map((l) => l.site_id)),
    memberNames(db, leads.map((l) => l.owner_membership_id)),
  ]);
  const byPipe = new Map(pipelines.map((p) => [p.id, p]));
  const multi = new Set(leads.map((l) => l.location_id)).size > 1;
  const coName = new Map(companies.map((c) => [c.id, c.name]));
  const group = <R extends { lead_id: string | null }>(rs: ReadonlyArray<R>) => {
    const m = new Map<string, R[]>();
    for (const r of rs) if (r.lead_id) (m.get(r.lead_id) ?? m.set(r.lead_id, []).get(r.lead_id)!).push(r);
    return m;
  };
  const acts = group(ctx.activities);
  const fus = group(ctx.followups);
  const evs = group(ctx.events);

  return leads.flatMap((l): LeadView[] => {
    const stage = stageById(byPipe.get(l.pipeline_id) ?? null, l.stage_id);
    if (!stage) return [];
    const open = stage.kind === 'open';
    const la = acts.get(l.id) ?? [];
    const lf = fus.get(l.id) ?? [];
    const lastAct = la.map((a) => a.occurred_at).sort().pop() ?? null;
    const due = dueFollowups(lf, opts.today);
    const contact = l.contact_id ? contacts.get(l.contact_id) : undefined;
    const site = l.site_id ? sites.get(l.site_id) : undefined;
    return [{
      id: l.id,
      title: l.title,
      companyId: l.location_id,
      company: multi ? coName.get(l.location_id) ?? null : null,
      pipelineId: l.pipeline_id,
      stageId: l.stage_id,
      stageName: stage.name,
      stageKind: stage.kind,
      probability: stageProbability(stage),
      customerId: l.customer_id,
      customerName: l.customer_id ? customers.get(l.customer_id)?.name ?? null : null,
      contactName: contact ? contactName(contact) : null,
      site: site ? siteAddress(site) || site.name : null,
      source: l.source,
      sourceLabel: sourceLabel(l.source),
      campaign: l.campaign,
      ownerId: l.owner_membership_id,
      ownerName: l.owner_membership_id ? (l.owner_membership_id === access.membershipId ? 'Me' : owners.get(l.owner_membership_id) ?? 'Assigned') : null,
      amountCents: can(access, 'projects.contract_value', 'view', l.location_id) ? l.estimated_value_cents : null,
      nextStep: l.next_step,
      nextStepOn: l.next_step_on,
      expectedCloseOn: l.expected_close_on,
      daysInStage: daysSince(enteredStageAt(l, evs.get(l.id) ?? []), opts.nowMs),
      speed: speedToLead(l.created_at, firstTouchAt(la), open, opts.nowMs),
      followupsDue: due.length,
      followupsOverdue: due.filter((f) => f.due_on < opts.today).length,
      needsNextStep: needsNextStep(l, open, lastAct, opts.today),
      lostReason: l.lost_reason,
      convertedJobId: l.converted_job_id,
      convertedEstimateId: l.converted_estimate_id,
      createdAt: l.created_at,
      updatedAt: l.updated_at,
      closedAt: l.won_at ?? l.lost_at,
    }];
  });
}
