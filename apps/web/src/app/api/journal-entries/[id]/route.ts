export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * GET /api/journal-entries/[id]
 * Full journal entry for the detail drawer: header + balanced lines with account
 * numbers/names and dimension labels. accounts is in `public` (embed OK);
 * locations/departments/classes are in `core` and stitched in JS.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  const orgId = (org as { id: string } | null)?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: entry, error } = await supabase
    .from('gl_entries')
    .select(`
      id, entry_number, entry_date, entry_type, memo, source_module, source_id,
      status, posted_at, posted_by, created_by, created_at, is_reversing,
      reversal_of_id, reversed_by_id, void_reason, location_id, fiscal_period_id
    `)
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();

  if (error || !entry) return NextResponse.json({ error: 'Journal entry not found' }, { status: 404 });

  const { data: lineRows } = await supabase
    .from('gl_entry_lines')
    .select(`
      id, line_number, debit_cents, credit_cents, memo,
      department_id, class_id,
      account:accounts!gl_entry_lines_account_id_fkey(id, account_number, name, account_type)
    `)
    .eq('gl_entry_id', params.id)
    .order('line_number', { ascending: true });

  const lines = (lineRows ?? []) as Array<Record<string, any>>;

  // Stitch core dimensions (location on header; departments/classes on lines).
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [entry.location_id]);
  const deptMap = await fetchCoreMap<{ id: string; name: string; code: string }>(
    supabase, 'departments', 'id, name, code', lines.map((l) => l.department_id));
  const classMap = await fetchCoreMap<{ id: string; name: string; code: string }>(
    supabase, 'classes', 'id, name, code', lines.map((l) => l.class_id));

  // Period label.
  let periodLabel: string | null = null;
  if (entry.fiscal_period_id) {
    const { data: fp } = await supabase
      .from('fiscal_periods')
      .select('period_year, period_month, status')
      .eq('id', entry.fiscal_period_id)
      .single();
    if (fp) periodLabel = `${fp.period_year}-${String(fp.period_month).padStart(2, '0')} (${fp.status})`;
  }

  let totalDebits = 0;
  let totalCredits = 0;
  const detailLines = lines.map((l) => {
    const acct = Array.isArray(l.account) ? l.account[0] : l.account;
    totalDebits += Number(l.debit_cents ?? 0);
    totalCredits += Number(l.credit_cents ?? 0);
    const dept = l.department_id ? deptMap.get(l.department_id) ?? null : null;
    const cls = l.class_id ? classMap.get(l.class_id) ?? null : null;
    return {
      id: l.id,
      lineNumber: l.line_number,
      accountId: (acct as { id?: string } | null)?.id ?? null,
      accountNumber: (acct as { account_number?: string } | null)?.account_number ?? '',
      accountName: (acct as { name?: string } | null)?.name ?? '',
      debitCents: Number(l.debit_cents ?? 0),
      creditCents: Number(l.credit_cents ?? 0),
      memo: l.memo ?? null,
      departmentLabel: dept ? `${dept.code} · ${dept.name}` : null,
      classLabel: cls ? `${cls.code} · ${cls.name}` : null,
    };
  });

  const loc = entry.location_id ? locMap.get(entry.location_id) ?? null : null;

  return NextResponse.json({
    id: entry.id,
    entryNumber: entry.entry_number,
    entryDate: entry.entry_date,
    entryType: entry.entry_type,
    memo: entry.memo,
    sourceModule: entry.source_module,
    status: entry.status,
    postedAt: entry.posted_at,
    createdAt: entry.created_at,
    isReversing: entry.is_reversing,
    voidReason: entry.void_reason,
    locationName: loc?.name ?? '',
    locationCode: loc?.short_code ?? '',
    periodLabel,
    totalDebitsCents: totalDebits,
    totalCreditsCents: totalCredits,
    balanced: totalDebits === totalCredits,
    lines: detailLines,
  });
}

// ─── PATCH /api/journal-entries/[id] — state-aware edit with override ───
//
// A journal entry IS the GL record. A DRAFT entry edits in place (lines must
// balance). A POSTED entry can't be mutated (period locks + immutability), so an
// override edit REVERSES the entry and RE-POSTS a corrected one — the only
// audit-clean way to change posted history. Every change is written to audit_log
// with the actor and reason.
import { z } from 'zod';
import { postJournalEntry, voidJournalEntry } from '@/lib/services/gl-posting';

const jeLineInput = z.object({
  account_id: z.string().uuid(),
  debit_cents: z.number().int().min(0).default(0),
  credit_cents: z.number().int().min(0).default(0),
  memo: z.string().max(500).nullable().optional(),
});
const jePatchSchema = z.object({
  memo: z.string().max(2000).nullable().optional(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(jeLineInput).min(2).optional(),
  override: z.object({ reason: z.string().min(3).max(500) }).optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  const supabase = createAdminSupabase();
  const { data: org } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  const orgId = (org as { id: string } | null)?.id;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: z.infer<typeof jePatchSchema>;
  try {
    const parsed = jePatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 422 });
    body = parsed.data;
  } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { data: je, error: jeErr } = await supabase
    .from('gl_entries')
    .select('id, status, location_id, entry_date, entry_type, memo, source_module, entry_number')
    .eq('org_id', orgId).eq('id', params.id).single();
  if (jeErr || !je) return NextResponse.json({ error: 'Journal entry not found' }, { status: 404 });

  // Balance check when lines are supplied.
  if (body.lines) {
    const dr = body.lines.reduce((s, l) => s + l.debit_cents, 0);
    const cr = body.lines.reduce((s, l) => s + l.credit_cents, 0);
    if (dr !== cr) return NextResponse.json({ error: `Entry must balance — debits ${dr} ≠ credits ${cr}`, code: 'UNBALANCED' }, { status: 422 });
    if (dr === 0) return NextResponse.json({ error: 'Entry has no amounts' }, { status: 422 });
  }

  const isDraft = je.status === 'DRAFT';
  if (!isDraft && !body.override) {
    return NextResponse.json({ error: 'This entry is posted. An override reason is required to edit it.', code: 'OVERRIDE_REQUIRED' }, { status: 403 });
  }

  const auditRows: Array<Record<string, unknown>> = [];
  const logField = (field: string, oldVal: unknown, newVal: unknown) => {
    if (newVal !== undefined && newVal !== oldVal) {
      auditRows.push({ org_id: orgId, table_name: 'gl_entries', record_id: je.id, action: 'UPDATE', field_name: field, old_value: oldVal != null ? String(oldVal) : null, new_value: newVal != null ? String(newVal) : null, user_id: userId });
    }
  };

  let resultEntryId = je.id;

  if (isDraft) {
    // Edit the draft in place.
    const headerUpd: Record<string, unknown> = {};
    if (body.memo !== undefined && body.memo !== je.memo) { headerUpd.memo = body.memo; logField('memo', je.memo, body.memo); }
    if (body.entry_date && body.entry_date !== je.entry_date) { headerUpd.entry_date = body.entry_date; logField('entry_date', je.entry_date, body.entry_date); }
    if (Object.keys(headerUpd).length) await supabase.from('gl_entries').update(headerUpd).eq('id', je.id);

    if (body.lines) {
      await supabase.from('gl_entry_lines').delete().eq('gl_entry_id', je.id);
      const rows = body.lines.map((l, i) => ({
        org_id: orgId, gl_entry_id: je.id, line_number: i + 1, account_id: l.account_id,
        debit_cents: l.debit_cents, credit_cents: l.credit_cents, location_id: je.location_id, memo: l.memo ?? null,
      }));
      const { error } = await supabase.from('gl_entry_lines').insert(rows);
      if (error) return NextResponse.json({ error: `Lines: ${error.message}` }, { status: 500 });
      logField('lines', 'edited', `${rows.length} lines`);
    }
  } else {
    // Posted: reverse + re-post corrected entry.
    const reason = body.override!.reason;
    const rev = await voidJournalEntry(supabase, orgId, je.id, userId, `JE ${je.entry_number} edited via override: ${reason}`);
    if (!rev.success) return NextResponse.json({ error: `Reverse failed: ${rev.error}` }, { status: 500 });

    if (!body.lines) return NextResponse.json({ error: 'Provide the corrected lines to re-post a posted entry.' }, { status: 422 });
    const reposted = await postJournalEntry(supabase, {
      org_id: orgId, location_id: je.location_id, entry_date: (body.entry_date ?? je.entry_date) as string,
      entry_type: je.entry_type ?? 'STANDARD', source_module: je.source_module ?? 'MANUAL', source_id: je.id,
      memo: body.memo ?? `${je.memo ?? ''} (override re-post)`.trim(), created_by: null,
      lines: body.lines.map((l) => ({ account_id: l.account_id, debit_cents: l.debit_cents, credit_cents: l.credit_cents, location_id: je.location_id, memo: l.memo ?? undefined })),
    });
    if (!reposted.success) return NextResponse.json({ error: `Re-post failed: ${reposted.error}` }, { status: 500 });
    resultEntryId = reposted.entry_id ?? je.id;
    logField('reposted_as', je.entry_number, reposted.entry_number);
    auditRows.push({ org_id: orgId, table_name: 'gl_entries', record_id: je.id, action: 'UPDATE', field_name: '_override_reason', old_value: je.status, new_value: reason, user_id: userId });
  }

  if (auditRows.length) await supabase.from('audit_log').insert(auditRows);
  return NextResponse.json({ ok: true, id: resultEntryId, reposted: !isDraft });
}
