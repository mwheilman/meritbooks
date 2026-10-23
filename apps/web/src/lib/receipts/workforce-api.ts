/**
 * The two Merit Workforce receipt endpoints, shared by the signed-in routes (`/api/w/me`)
 * and the magic-link routes (`/api/w/s/[token]`). The caller resolves WHICH card
 * assignments the visitor may act for (their own, or the one the link names) from a
 * trusted source; everything below is narrowed to that list. Service role, org pinned.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { captureReceipt, CaptureError } from './capture';
import { loadHolderView } from './holder-view';
import { parseReceiptUpload } from './upload-form';
import type { CardAssignmentRow } from './types';

export interface WorkforceJob {
  id: string;
  label: string;
  locationId: string;
}

/** The holder's companies' open jobs, for the "which job?" picker (Books-only tenants: none). */
async function jobsFor(admin: SupabaseClient, orgId: string, locationIds: string[]): Promise<WorkforceJob[]> {
  if (locationIds.length === 0) return [];
  const { data } = await admin
    .schema('core')
    .from('jobs')
    .select('id, job_number, name, location_id, status')
    .eq('org_id', orgId)
    .in('location_id', locationIds)
    .order('job_number', { ascending: false })
    .limit(300);
  return ((data ?? []) as Array<{ id: string; job_number: string | null; name: string; location_id: string; status: string | null }>)
    .filter((j) => !j.status || !/^(closed|complete|completed|cancelled|canceled|archived)$/i.test(j.status))
    .map((j) => ({ id: j.id, label: `${j.job_number ? `${j.job_number} · ` : ''}${j.name}`.slice(0, 120), locationId: j.location_id }));
}

export async function workforceViewResponse(admin: SupabaseClient, orgId: string, assignments: CardAssignmentRow[]): Promise<NextResponse> {
  const view = await loadHolderView(admin, orgId, assignments);
  const jobs = await jobsFor(admin, orgId, Array.from(new Set(assignments.map((a) => a.location_id))));
  return NextResponse.json({ ...view, jobs }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function workforceUploadResponse(
  req: Request,
  admin: SupabaseClient,
  orgId: string,
  assignments: CardAssignmentRow[],
  submittedBy: string,
): Promise<NextResponse> {
  const up = await parseReceiptUpload(req, { maxFiles: 5 });
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: up.status });
  const holder = up.fields.assignment_id ? assignments.find((a) => a.id === up.fields.assignment_id) ?? null : assignments[0] ?? null;
  if (!holder) return NextResponse.json({ error: 'That card was not found.' }, { status: 404 });
  if (up.fields.transaction_id && up.files.length > 1) return NextResponse.json({ error: 'Send one photo for this charge (a multi-page PDF is fine).' }, { status: 422 });

  const deps = { db: admin, now: () => new Date(), anthropicApiKey: getAnthropicApiKey() };
  const results: Array<Record<string, unknown>> = [];
  let failStatus = 400;
  for (const f of up.files) {
    if (f.error) {
      results.push({ fileName: f.file.fileName, ok: false, error: f.error });
      continue;
    }
    try {
      const r = await captureReceipt(deps, {
        orgId,
        locationId: holder.location_id,
        source: 'MOBILE_CAPTURE',
        file: f.file,
        holder,
        chargeId: up.fields.transaction_id ?? null,
        restrictToHolder: true,
        memo: up.fields.memo ?? null,
        jobId: up.fields.job_id ?? null,
        typed: { merchant: up.fields.merchant ?? null, amountCents: up.amountCents, date: up.fields.date ?? null },
        submittedBy,
      });
      results.push({
        fileName: f.file.fileName,
        ok: true,
        duplicate: r.duplicate,
        match: r.match.kind,
        merchant: r.facts.merchant,
        amountCents: r.facts.totalCents,
        date: r.facts.date,
        flags: r.match.kind === 'attached' ? r.match.flags : [],
      });
    } catch (e) {
      results.push({ fileName: f.file.fileName, ok: false, error: e instanceof CaptureError ? e.message : 'Something went wrong. Please try again.' });
      if (e instanceof CaptureError) failStatus = e.status;
      if (!(e instanceof CaptureError)) console.error('[workforce/upload]', e);
    }
  }
  const saved = results.filter((r) => r.ok).length;
  const firstErr = results.find((r) => !r.ok)?.error;
  return NextResponse.json({ results, saved, error: saved === 0 ? firstErr : undefined }, { status: saved > 0 ? 201 : failStatus });
}
