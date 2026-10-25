export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';

const Uuid = z.string().uuid();

export interface InstallerDay {
  day: string;
  my_pay_this_week_cents: number;
  bookings: Array<{
    booking_id: string; job_id: string; job_number: string; job: string; status: 'BOOKED' | 'CONFIRMED'; sf: number | null; days: number;
    address: string | null; lat: number | null; lng: number | null; notes: string | null;
    areas: Array<{ room: string | null; kind: string | null; sqft: number | null; category: string | null }>;
    cuts: Array<{ cut_id: string; roll_id: string; roll: string | null; dye_lot: string | null; room: string | null; planned_len_in: number; status: 'PLANNED' | 'CUT' | 'VOID' }>;
    /** The codes a field_change line may use (no rates on the phone). */
    labor_codes: Array<{ code: string; description: string; unit: 'SY' | 'SF' | 'LF' | 'STEP' | 'EA' | 'JOB' | 'HOUR'; applies_to: string }>;
    site_checks_needed: string[];
  }>;
}

/**
 * GET /api/field/flooring?day= — additive (FLR-33): the installer's day — their crew's bookings with
 * address, rooms and areas, the cut list (with roll ids for the leftover on sign-off), the labor
 * codes an on-site change may use, site checks still needed — and their own pay this week.
 */
// mask: false — the only money is the caller's own pay (pm.flr_installer_day sums their own tickets only)
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) },
  async ({ db, query }) => resRpc<InstallerDay>(db, 'flr_installer_day', { p_day: query.day ?? null }));

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('on_my_way'), bookingId: Uuid }),
  z.object({ op: z.literal('signoff'), bookingId: Uuid, signerName: z.string().trim().min(1).max(200), signatureDocumentId: Uuid.nullish(),
    photoDocumentIds: z.array(Uuid).max(40).default([]), leftover: z.array(z.object({ roll_id: Uuid, len_in: z.number().min(0).max(100000) })).max(20).default([]),
    notes: z.string().trim().max(2000).nullish() }),
  // commandId: the phone's id for this change (lasting dedupe, pm.wc_field_commands) — a re-send returns the first change order
  z.object({ op: z.literal('field_change'), commandId: Uuid, jobId: Uuid, lines: z.array(z.object({ labor_code: z.string().regex(/^[A-Z0-9_]{2,32}$/), qty: z.number().positive().max(1e6),
    description: z.string().trim().max(200).nullish() })).min(1).max(20), signerName: z.string().trim().max(200).nullish(), signatureDocumentId: Uuid.nullish(), note: z.string().trim().max(200).nullish() }),
]);

/** on_my_way texts the customer; signoff closes the booking (leftover roll goods back to stock); field_change adds prep / steps the customer signs on the device. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: ['change_order', 'labor_rate'], body: Body }, async ({ db, body }) => {
  switch (body.op) {
    case 'on_my_way': return resRpc(db, 'flr_booking_status', { p_booking: body.bookingId, p_status: 'ON_MY_WAY' });
    case 'signoff': return resRpc(db, 'flr_record_signoff', { p_booking: body.bookingId, p_signer_name: body.signerName, p_signature_document: body.signatureDocumentId ?? null,
      p_photos: body.photoDocumentIds, p_leftover: body.leftover, p_notes: body.notes ?? null });
    case 'field_change': return resRpc(db, 'flr_field_change', { p_job: body.jobId, p_lines: body.lines, p_signer_name: body.signerName ?? null,
      p_signature_document: body.signatureDocumentId ?? null, p_note: body.note ?? null, p_command: body.commandId });
  }
});
