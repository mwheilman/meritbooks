import 'server-only';
/**
 * The new-lead door (panel 06 BP-44, SHARED-RECORDS §3): the person on the lead is matched
 * against the shared master before anything is written, so a known customer links instead of
 * being created twice. Then the contact, the site and the lead, and any intake notes as the
 * lead's first activity.
 */
import type { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError } from '@/lib/api-errors';
import { requireCan } from '@/lib/access/guard';
import type { Access } from '@/lib/access/types';
import { insertCustomer } from '@/lib/pm/parties/create';
import { addressLine, createContact, createSite } from '@/lib/parties/create';
import { matchConflict, noteOverride, resolveAtDoor } from '@/lib/parties/server';
import { createLeadArgs, logActivityArgs } from './contract';
import { defaultPipeline, listPipelines } from './queries';
import { leadCustomerName, leadHasPerson, type NewLead } from './schemas';

export interface CreatedLead {
  lead: { id: string };
  customer: { id: string; existing: boolean } | null;
  contactId: string | null;
  siteId: string | null;
}

export async function createLead(db: SupabaseClient, access: Access, body: NewLead, companyName: string | null): Promise<CreatedLead | NextResponse> {
  const pipes = await listPipelines(db, [body.companyId]);
  const pipe = body.pipelineId ? pipes.find((p) => p.id === body.pipelineId) ?? null : defaultPipeline(pipes, body.companyId);
  if (!pipe) throw new HttpError(422, 'This company has no lead pipeline yet. Set one up in Settings.', 'NO_PIPELINE');
  const stage = body.stageId ? pipe.stages.find((s) => s.id === body.stageId) : [...pipe.stages].filter((s) => s.kind === 'open').sort((a, b) => a.sort - b.sort)[0];
  if (!stage) throw new HttpError(422, 'Pick a stage in this pipeline.', 'VALIDATION');

  // ---- the person: matched at the door
  let customer: CreatedLead['customer'] = null;
  const c = body.customer;
  if (c && leadHasPerson(c)) {
    const name = leadCustomerName(c);
    const door = await resolveAtDoor(db, 'customer', { name, email: c.email, phone: c.phone, address: body.site ? addressLine(body.site) : null }, c.match);
    if (door.kind === 'conflict') return matchConflict('customer', door.candidates, 'customer');
    if (door.kind === 'use') customer = { id: door.id, existing: true };
    else {
      requireCan(access, 'projects.customers', 'create', body.companyId, companyName);
      if (!name) throw new HttpError(422, 'Give the customer a name.', 'VALIDATION');
      const id = await insertCustomer(db, { name, email: c.email, phone: c.phone, companyId: body.companyId, contactFirst: c.firstName, contactLast: c.lastName });
      if (door.overrideOf && door.reason && id !== door.overrideOf.id) await noteOverride(db, 'customer', id, door.overrideOf, door.reason);
      customer = { id, existing: id === door.overrideOf?.id };
    }
  }

  // ---- the contact person (households: the customer is named for them)
  let contactId: string | null = null;
  if (customer && c && (c.firstName || c.lastName || c.email || c.phone)) {
    contactId = await createContact(db, {
      customerId: customer.id, vendorId: null, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone,
      title: null, roles: [], isPrimary: !customer.existing, canSign: !customer.existing, canPay: !customer.existing, smsConsent: false, emailConsent: false,
    });
  }

  // ---- the site
  let siteId: string | null = null;
  if (customer && body.site?.line1) {
    siteId = await createSite(db, {
      customerId: customer.id, companyId: body.companyId, name: null, line1: body.site.line1, line2: body.site.line2,
      city: body.site.city, state: body.site.state, zip: body.site.zip, accessNotes: body.site.accessNotes, taxJurisdiction: null,
    });
  }

  const res = await db.schema('crm').rpc('create_lead', createLeadArgs({
    companyId: body.companyId, title: body.title, pipelineId: pipe.id, stageId: stage.id, customerId: customer?.id ?? null, contactId, siteId,
    source: body.source, sourceDetail: body.sourceDetail, campaign: body.campaign, ownerMembershipId: body.ownerMembershipId ?? access.membershipId,
    valueCents: body.valueCents, expectedCloseOn: body.expectedCloseOn, nextStep: body.nextStep, nextStepOn: body.nextStepOn,
  }));
  if (res.error) throw new PmQueryError('add lead', res.error);
  const id = typeof res.data === 'string' ? res.data : null;
  if (!id) throw new HttpError(500, 'The lead was not added. Try again.', 'CREATE_FAILED');

  if (body.notes) {
    const n = await db.schema('crm').rpc('log_activity', logActivityArgs({
      kind: 'note', leadId: id, customerId: customer?.id ?? null, contactId, jobId: null, direction: null,
      subject: 'Intake notes', body: body.notes, outcome: null, occurredAt: null,
    }));
    if (n.error) throw new PmQueryError('lead notes', n.error);
  }
  return { lead: { id }, customer, contactId, siteId };
}
