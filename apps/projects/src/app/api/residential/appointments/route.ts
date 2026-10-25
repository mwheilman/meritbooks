export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { linkBase } from '@/lib/documents/http';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { tradeToken } from '@/lib/residential/sign';
import { Cents, Day, Text, Uuid } from '@/lib/residential/schemas';

export interface AppointmentRow {
  id: string;
  kind: 'SALES' | 'MEASURE' | 'DISCOVERY' | 'DESIGN';
  status: string;
  lead_id: string | null;
  job_id: string | null;
  rep_id: string | null;
  requester_name: string | null;
  requester_phone: string | null;
  starts_at: string;
  ends_at: string | null;
  minutes: number;
  address: string | null;
  notes: string | null;
  self_booked: boolean;
  measure_fee_cents: number | null;
}
export interface RepRow { id: string; display_name: string; kinds: string[]; skills: string[]; zip_prefixes: string[]; home_lat: number | null; home_lng: number | null; is_active: boolean; membership_id: string }
export interface Slot { rep_id: string; rep: string; starts_at: string; ends_at: string; drive_in_minutes: number; drive_out_minutes: number; skill_match: boolean; in_territory: boolean }

const Q = z.object({
  company: Uuid,
  from: Day.optional(),
  days: z.coerce.number().int().min(1).max(31).default(7),
  slotsFor: Day.optional(),
  kind: z.enum(['SALES', 'MEASURE', 'DISCOVERY', 'DESIGN']).default('SALES'),
  skill: z.string().max(40).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  zip: z.string().max(12).optional(),
  minutes: z.coerce.number().int().min(15).max(600).default(90),
});

/**
 * The appointment calendar (RES-10 / FLR-07 / ID-03): the company's reps, the visits in the window
 * (self-booked requests first), and — with slotsFor — the open drive-time-aware slots for a site.
 */
export interface BookingLinkRow { id: string; kind: string; label: string; is_active: boolean; expires_at: string | null; revoked_at: string | null; created_at: string }

export const GET = route({ access: { cap: 'projects.leads', action: 'view' }, mask: ['estimate'], query: Q }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const from = query.from ?? new Date().toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + query.days * 86400_000).toISOString().slice(0, 10);
  const reps = resWrote<RepRow[]>(await pm(db).from('wc_reps').select('id, display_name, kinds, skills, zip_prefixes, home_lat, home_lng, is_active, membership_id')
    .eq('location_id', query.company).order('display_name'));
  const appts = resWrote<AppointmentRow[]>(await pm(db).from('wc_appointments')
    .select('id, kind, status, lead_id, job_id, rep_id, requester_name, requester_phone, starts_at, ends_at, minutes, address, notes, self_booked, measure_fee_cents')
    .eq('location_id', query.company).gte('starts_at', `${from}T00:00:00Z`).lt('starts_at', `${to}T23:59:59Z`).order('starts_at').limit(500));
  let slots: Slot[] = [];
  if (query.slotsFor) {
    const r = await resRpc<{ slots: Slot[] }>(db, 'wc_appointment_slots', { p_location: query.company, p_day: query.slotsFor, p_kind: query.kind, p_skill: query.skill ?? null,
      p_lat: query.lat ?? null, p_lng: query.lng ?? null, p_zip: query.zip ?? null, p_minutes: query.minutes, p_limit: 24 });
    slots = r.slots;
  }
  // booking links (RLS: people with projects.settings:view at the company); token hashes never leave the database
  const links = resWrote<BookingLinkRow[]>(await pm(db).from('wc_booking_links').select('id, kind, label, is_active, expires_at, revoked_at, created_at')
    .eq('location_id', query.company).order('created_at', { ascending: false }).limit(50));
  return { reps, appointments: appts, requests: appts.filter((a) => a.status === 'REQUESTED'), slots, links };
});

const Book = z.object({
  op: z.literal('book'), companyId: Uuid, repId: Uuid, startsAt: z.string().datetime({ offset: true }), minutes: z.number().int().min(15).max(600).default(90),
  kind: z.enum(['SALES', 'MEASURE', 'DISCOVERY', 'DESIGN']).default('SALES'), leadId: Uuid.nullish(), jobId: Uuid.nullish(), contactId: Uuid.nullish(), appointmentId: Uuid.nullish(),
  address: Text(500).nullish(), zip: Text(12).nullish(), lat: z.number().min(-90).max(90).nullish(), lng: z.number().min(-180).max(180).nullish(),
  skill: Text(40).nullish(), notes: Text(4000).nullish(), measureFeeCents: Cents.nullish(),
});
const Body = z.discriminatedUnion('op', [
  Book,
  z.object({ op: z.literal('status'), appointmentId: Uuid, status: z.enum(['CONFIRMED', 'ON_MY_WAY', 'ARRIVED', 'DONE', 'NO_SHOW', 'CANCELLED']), note: Text(2000).nullish() }),
  z.object({ op: z.literal('reminders'), companyId: Uuid }),
  z.object({ op: z.literal('booking_link'), companyId: Uuid, kind: z.enum(['SALES', 'MEASURE', 'DISCOVERY']).default('SALES'), label: Text(120).nullish(), minutes: z.number().int().min(15).max(600).default(90),
    expiresDays: z.number().int().min(1).max(366).default(180) }),
  z.object({ op: z.literal('revoke_link'), linkId: Uuid }),
]);

export const POST = route({ access: { cap: 'projects.leads', action: 'view' }, ops: { reminders: { cap: 'projects.leads', action: 'edit' }, booking_link: { cap: 'projects.settings', action: 'configure' }, revoke_link: { cap: 'projects.settings', action: 'configure' } },
  mask: false, body: Body }, async ({ req, db, body, tenant }) => {
  switch (body.op) {
    case 'book':
      assertCompany(tenant, body.companyId);
      return { appointmentId: await resRpc<string>(db, 'wc_book_appointment', { p_location: body.companyId, p_attrs: {
        rep_id: body.repId, starts_at: body.startsAt, minutes: body.minutes, kind: body.kind, lead_id: body.leadId ?? null, job_id: body.jobId ?? null,
        contact_id: body.contactId ?? null, appointment_id: body.appointmentId ?? null, address: body.address ?? null, zip: body.zip ?? null, lat: body.lat ?? null,
        lng: body.lng ?? null, skill: body.skill ?? null, notes: body.notes ?? null, measure_fee_cents: body.measureFeeCents ?? null } }) };
    case 'status':
      return resRpc(db, 'wc_set_appointment_status', { p_appointment: body.appointmentId, p_status: body.status, p_note: body.note ?? null });
    case 'reminders':
      assertCompany(tenant, body.companyId);
      return { reminded: await resRpc<number>(db, 'wc_send_appointment_reminders', { p_location: body.companyId }) };
    case 'booking_link': {
      assertCompany(tenant, body.companyId);
      const t = tradeToken();
      const id = await resRpc<string>(db, 'wc_create_booking_link', { p_location: body.companyId, p_token_hash: t.hash, p_kind: body.kind, p_label: body.label ?? null, p_minutes: body.minutes, p_expires_days: body.expiresDays });
      // the token is shown once (only its sha-256 is stored)
      return { linkId: id, url: `${linkBase(req)}/api/residential/public-book/${encodeURIComponent(t.token)}` };
    }
    case 'revoke_link':
      return resRpc(db, 'wc_revoke_booking_link', { p_link: body.linkId });
  }
});
