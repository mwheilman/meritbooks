export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data, error } = await supabase
    .from('organizations')
    .select('*')
    .limit(1)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Also get locations for portfolio companies
  const { data: locations } = await supabase
    .from('locations')
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
        quietStart: data.chase_quiet_start,
        quietEnd: data.chase_quiet_end,
        channel: data.chase_channel,
        autoApproveCents: data.chase_auto_approve_cents,
      },
      ai: {
        autoApproveThreshold: data.ai_auto_approve_threshold,
        autoApproveMaxCents: data.ai_auto_approve_max_cents,
      },
    },
    locations: locations ?? [],
  });
}

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  primary_contact_name: z.string().max(200).optional(),
  primary_contact_email: z.string().email().optional(),
  timezone: z.string().optional(),
  fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
  chase_first_reminder_minutes: z.number().int().min(5).max(1440).optional(),
  chase_followup_minutes: z.number().int().min(15).max(1440).optional(),
  chase_escalation_threshold: z.number().int().min(1).max(20).optional(),
  chase_quiet_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  chase_quiet_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  chase_channel: z.enum(['PUSH_SMS', 'PUSH_ONLY', 'SMS_ONLY', 'PUSH_SMS_EMAIL']).optional(),
  chase_auto_approve_cents: z.number().int().min(0).optional(),
  ai_auto_approve_threshold: z.number().min(0).max(1).optional(),
  ai_auto_approve_max_cents: z.number().int().min(0).optional(),
});

export async function PATCH(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const raw = await request.json();
  const result = updateSchema.safeParse(raw);
  if (!result.success) {
    return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
  }

  // Get org id
  const { data: org } = await supabase.from('organizations').select('id').limit(1).single();
  if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

  const { error } = await supabase.from('organizations').update(result.data).eq('id', org.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
