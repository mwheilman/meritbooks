export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  const { data, error } = await supabase
    .schema('core').from('organizations')
    .select('*')
    .eq('id', orgId ?? '')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Also get locations for portfolio companies (RLS scopes to this org)
  const { data: locations } = await supabase
    .schema('core').from('locations')
    .select('id, name, short_code, industry, is_active, created_at')
    .order('name');

  return NextResponse.json({
    org: {
      id: data.id,
      name: data.name,
      slug: data.slug,
      primaryContactName: data.primary_contact_name,
      primaryContactEmail: data.primary_contact_email,
      timezone: data.timezone,
      fiscalYearStartMonth: data.fiscal_year_start_month,
      setupComplete: data.setup_complete,
      chase: {
        firstReminderMinutes: data.chase_first_reminder_minutes,
        followupMinutes: data.chase_followup_minutes,
        escalationThreshold: data.chase_escalation_threshold,
        // Postgres `time` serializes as HH:MM:SS; the UI (and the round-trip) want HH:MM.
        quietStart: data.chase_quiet_start ? String(data.chase_quiet_start).slice(0, 5) : data.chase_quiet_start,
        quietEnd: data.chase_quiet_end ? String(data.chase_quiet_end).slice(0, 5) : data.chase_quiet_end,
        channel: data.chase_channel,
        autoApproveCents: data.chase_auto_approve_cents,
      },
      ai: {
        // `numeric` serializes as a string ("0.8500"); hand the UI a real number.
        autoApproveThreshold: data.ai_auto_approve_threshold == null ? null : Number(data.ai_auto_approve_threshold),
        autoApproveMaxCents: data.ai_auto_approve_max_cents,
      },
    },
    locations: locations ?? [],
  });
}

// HH:MM, tolerating an optional :SS (Postgres `time` serializes with seconds).
const hhmm = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  primary_contact_name: z.string().max(200).optional(),
  primary_contact_email: z.string().email().optional(),
  timezone: z.string().optional(),
  // z.coerce.* so string-serialized numeric/int values (e.g. "0.8500" from a
  // `numeric` column round-tripped through the form) validate instead of 422-ing.
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12).optional(),
  chase_first_reminder_minutes: z.coerce.number().int().min(5).max(1440).optional(),
  chase_followup_minutes: z.coerce.number().int().min(15).max(1440).optional(),
  chase_escalation_threshold: z.coerce.number().int().min(1).max(20).optional(),
  chase_quiet_start: hhmm.optional(),
  chase_quiet_end: hhmm.optional(),
  chase_channel: z.enum(['PUSH_SMS', 'PUSH_ONLY', 'SMS_ONLY', 'PUSH_SMS_EMAIL']).optional(),
  chase_auto_approve_cents: z.coerce.number().int().min(0).optional(),
  ai_auto_approve_threshold: z.coerce.number().min(0).max(1).optional(),
  ai_auto_approve_max_cents: z.coerce.number().int().min(0).optional(),
});

export async function PATCH(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  const raw = await request.json();
  const result = updateSchema.safeParse(raw);
  if (!result.success) {
    return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
  }

  // Tenant is the token's org claim; RLS also enforces id = get_org_id().
  const { error } = await supabase.schema('core').from('organizations').update(result.data).eq('id', orgId ?? '');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
