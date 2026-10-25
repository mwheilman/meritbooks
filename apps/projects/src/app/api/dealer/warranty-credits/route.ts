export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { parseCreditMemo } from '@/lib/dealer/warranty-adapters';
import { CompanyOnlyQ, IsoDate, Req, Text, Uuid } from '@/lib/dealer/schemas';

/**
 * Warranty money in: deadlines to file and to hear back (v_dlr_claim_deadlines), credit memos and
 * their lines still to match to a claim.
 */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'repair_order', query: CompanyOnlyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const pm = db.schema('pm');
  const [deadlines, memos] = await Promise.all([
    xrows<Record<string, unknown>>(pm.from('v_dlr_claim_deadlines').select('*').eq('location_id', query.company).in('status', ['DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED']).order('submit_by', { ascending: true, nullsFirst: false }).limit(300), 'claim deadlines'),
    xrows<{ id: string; memo_ref: string; memo_on: string; brand: string | null; total_cents: number; status: string }>(pm.from('dlr_credit_memos').select('id, memo_ref, memo_on, brand, total_cents, status').eq('location_id', query.company).order('memo_on', { ascending: false }).limit(50), 'credit memos'),
  ]);
  const lines = memos.length
    ? await xrows<Record<string, unknown>>(pm.from('dlr_credit_memo_lines').select('id, memo_id, line_no, reference, claim_number, serial_number, description, amount_cents, proposed_claim_id, matched_claim_id, confidence, match_status').in('memo_id', memos.map((m) => m.id)).order('line_no'), 'credit memo lines')
    : [];
  return { deadlines, memos, lines };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('import'), companyId: Uuid, memoRef: Req(60, 'The memo number'), memoOn: IsoDate, brand: Text(30).nullish(), vendorId: Uuid.nullish(), text: Req(5_000_000, 'The statement') }),
  z.object({ op: z.literal('confirm'), lineId: Uuid, claimId: Uuid.nullish(), ignore: z.boolean().default(false) }),
]);

/** Import an OEM credit memo (proposed matches by claim number, serial, amount) and confirm each match. */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'repair_order', body: Op }, async ({ db, body, tenant }) => {
  if (body.op === 'import') {
    assertCompany(tenant, body.companyId);
    const parsed = parseCreditMemo(body.text);
    if (!parsed.lines.length) throw new HttpError(422, parsed.issues[0] ?? 'No credit lines were found.', 'VALIDATION');
    const r = await xcall<Record<string, unknown>>(db, 'dlr_import_credit_memo', { p_location: body.companyId, p_memo_ref: body.memoRef, p_memo_on: body.memoOn, p_lines: parsed.lines, p_oem_vendor: body.vendorId ?? null, p_brand: body.brand ?? null });
    return { ...r, issues: parsed.issues };
  }
  return xcall(db, 'dlr_confirm_credit_match', { p_line: body.lineId, p_claim: body.claimId ?? null, p_ignore: body.ignore });
});
