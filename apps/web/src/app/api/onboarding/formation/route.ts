export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { ENTITY_TYPES } from '@/lib/onboarding/formation/parse-formation';

/**
 * /api/onboarding/formation — read + CONFIRM the company legal record.
 *
 * GET  — return the caller's org legal record(s) (optionally filtered by
 *        ?location_id). RLS scopes every read to the caller's org.
 *
 * POST — CONFIRM + PERSIST a human-reviewed legal record. Validates a Zod body of the
 *        `core.company_legal_records` fields and UPSERTS keyed by (org_id, location_id):
 *        org_id = ctx.orgId, created_by_user = ctx.userId. Links source_document_id
 *        when provided. Returns the saved record.
 *
 * This is the human-confirm step of the formation drop-and-parse flow: the AI proposes
 * (`POST /api/onboarding/formation/parse`), the human reviews/edits, and only the
 * confirmed record lands here. RLS enforces tenant isolation on every read/write; the
 * user-scoped client is used throughout (no admin client for tenant reads/writes).
 */

const CORE = 'core' as const;
const TABLE = 'company_legal_records' as const;

/** A member / manager / owner as stored in the `members` jsonb column. */
const memberSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().max(200).nullable().optional().default(null),
  ownership_pct: z.number().min(0).max(100).nullable().optional().default(null),
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'formation_date must be YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'formation_date is not a real calendar date');

const confirmSchema = z.object({
  location_id: z.string().uuid().nullable().optional().default(null),
  legal_name: z.string().trim().min(1, 'legal_name is required').max(300),
  entity_type: z.enum(ENTITY_TYPES as unknown as [string, ...string[]]).nullable().optional().default(null),
  ein: z.string().trim().max(30).nullable().optional().default(null),
  formation_state: z.string().trim().max(100).nullable().optional().default(null),
  formation_date: isoDate.nullable().optional().default(null),
  registered_agent: z.string().trim().max(500).nullable().optional().default(null),
  members: z.array(memberSchema).max(200).optional().default([]),
  source_document_id: z.string().uuid().nullable().optional().default(null),
  notes: z.string().trim().max(5000).nullable().optional().default(null),
});

/** The row shape persisted to core.company_legal_records (core is not in generated types). */
interface LegalRecordRow {
  id: string;
  org_id: string;
  location_id: string | null;
  legal_name: string | null;
  entity_type: string | null;
  ein: string | null;
  formation_state: string | null;
  formation_date: string | null;
  registered_agent: string | null;
  members: unknown;
  source_document_id: string | null;
  notes: string | null;
  created_by_user: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  'id, org_id, location_id, legal_name, entity_type, ein, formation_state, formation_date, registered_agent, members, source_document_id, notes, created_by_user, created_at, updated_at';

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const url = new URL(request.url);
  const locationId = url.searchParams.get('location_id');

  let query = supabase
    .schema(CORE)
    .from(TABLE)
    .select(SELECT_COLS)
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false });
  if (locationId) query = query.eq('location_id', locationId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message, code: 'READ_FAILED' }, { status: 500 });
  }

  const records = (data ?? []) as unknown as LegalRecordRow[];
  return NextResponse.json({ records });
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', issues: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const body = parsed.data;

  // If a location is supplied, confirm it belongs to this org (RLS also enforces it).
  if (body.location_id) {
    const { data: loc } = await supabase
      .schema(CORE)
      .from('locations')
      .select('id')
      .eq('id', body.location_id)
      .eq('org_id', orgId)
      .maybeSingle();
    if (!loc) {
      return NextResponse.json({ error: 'Selected company not found.', code: 'LOCATION_NOT_FOUND' }, { status: 400 });
    }
  }

  const payload = {
    org_id: orgId,
    location_id: body.location_id,
    legal_name: body.legal_name,
    entity_type: body.entity_type,
    ein: body.ein,
    formation_state: body.formation_state,
    formation_date: body.formation_date,
    registered_agent: body.registered_agent,
    members: body.members,
    source_document_id: body.source_document_id,
    notes: body.notes,
  };

  // UPSERT keyed by (org_id, location_id). The unique index treats NULL location_ids
  // as distinct, so `onConflict` can't dedupe an org-level (null-location) record —
  // do the update/insert explicitly so a re-confirm is idempotent either way.
  const table = supabase.schema(CORE).from(TABLE);

  let existingQuery = table.select('id').eq('org_id', orgId);
  existingQuery = body.location_id
    ? existingQuery.eq('location_id', body.location_id)
    : existingQuery.is('location_id', null);
  const { data: existing, error: existErr } = await existingQuery.maybeSingle();
  if (existErr) {
    return NextResponse.json({ error: existErr.message, code: 'LOOKUP_FAILED' }, { status: 500 });
  }

  const existingId = (existing as { id: string } | null)?.id ?? null;

  if (existingId) {
    const { data, error } = await supabase
      .schema(CORE)
      .from(TABLE)
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', existingId)
      .eq('org_id', orgId)
      .select(SELECT_COLS)
      .single();
    if (error) {
      return NextResponse.json({ error: error.message, code: 'UPDATE_FAILED' }, { status: 500 });
    }
    return NextResponse.json({ record: data as unknown as LegalRecordRow, created: false });
  }

  const { data, error } = await supabase
    .schema(CORE)
    .from(TABLE)
    .insert({ ...payload, created_by_user: userId })
    .select(SELECT_COLS)
    .single();
  if (error) {
    return NextResponse.json({ error: error.message, code: 'INSERT_FAILED' }, { status: 500 });
  }
  return NextResponse.json({ record: data as unknown as LegalRecordRow, created: true });
}
