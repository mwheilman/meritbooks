import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { one, pm } from '@/lib/pm/db';
import { BILLING_COLS, COMMITMENT_COLS, ESTIMATE_COLS } from './queries';
import type { BillingRequestRow, CommitmentRow, EstimateRow } from './types';

export async function loadCommitment(db: SupabaseClient, id: string): Promise<CommitmentRow> {
  const c = one<CommitmentRow>(await pm(db).from('commitments').select(COMMITMENT_COLS).eq('id', id).maybeSingle(), 'commitment');
  if (!c) throw new HttpError(404, 'That commitment was not found in this workspace.', 'NOT_FOUND');
  return c;
}

export async function loadEstimate(db: SupabaseClient, id: string): Promise<EstimateRow> {
  const e = one<EstimateRow>(await pm(db).from('estimates').select(ESTIMATE_COLS).eq('id', id).maybeSingle(), 'estimate');
  if (!e) throw new HttpError(404, 'That estimate was not found in this workspace.', 'NOT_FOUND');
  return e;
}

export async function loadBillingRequest(db: SupabaseClient, id: string): Promise<BillingRequestRow> {
  const r = one<BillingRequestRow>(await pm(db).from('billing_requests').select(BILLING_COLS).eq('id', id).maybeSingle(), 'billing request');
  if (!r) throw new HttpError(404, 'That billing request was not found in this workspace.', 'NOT_FOUND');
  return r;
}
