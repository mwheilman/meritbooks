/**
 * Custom statement layouts (report_layouts, mig 185) — validation + persistence.
 * Reads run on the caller's RLS client; writes go through the service role after the
 * route authenticated + authorized the caller (members hold no write grant).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { validateLayout, type LayoutIssue } from './layout';
import type { LayoutRowDef } from './types';

export interface LayoutSummary {
  id: string;
  name: string;
  statement: 'PNL' | 'BS';
  description: string | null;
  rows: LayoutRowDef[];
  updatedAt: string;
}

export class LayoutValidationError extends Error {
  constructor(readonly issues: LayoutIssue[]) {
    super(issues[0]?.message ?? 'Invalid layout');
  }
}

const COLS = 'id, name, statement, description, rows, is_archived, updated_at';

function toSummary(r: Record<string, unknown>): LayoutSummary {
  return {
    id: String(r.id),
    name: String(r.name),
    statement: r.statement === 'BS' ? 'BS' : 'PNL',
    description: (r.description as string) ?? null,
    rows: (r.rows ?? []) as LayoutRowDef[],
    updatedAt: String(r.updated_at ?? ''),
  };
}

export async function listLayouts(supabase: SupabaseClient): Promise<LayoutSummary[]> {
  const { data, error } = await supabase.from('report_layouts').select(COLS).eq('is_archived', false).order('name');
  if (error) {
    if (error.code === '42P01') return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(toSummary);
}

export interface LayoutInput {
  name: string;
  statement: 'PNL' | 'BS';
  description?: string | null;
  rows: LayoutRowDef[];
}

export async function saveLayout(orgId: string, userId: string, input: LayoutInput, id?: string, writer?: SupabaseClient): Promise<LayoutSummary> {
  const issues = validateLayout(input.rows, input.statement);
  if (issues.length) throw new LayoutValidationError(issues);
  const w = serviceWriter(writer);
  const now = new Date().toISOString();
  if (id) {
    const { data, error } = await w
      .from('report_layouts')
      .update({ name: input.name, statement: input.statement, description: input.description ?? null, rows: input.rows, updated_by: userId, updated_at: now })
      .eq('id', id)
      .eq('org_id', orgId)
      .select(COLS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Layout not found');
    return toSummary(data as Record<string, unknown>);
  }
  const { data, error } = await w
    .from('report_layouts')
    .insert({ org_id: orgId, name: input.name, statement: input.statement, description: input.description ?? null, rows: input.rows, created_by: userId, updated_by: userId })
    .select(COLS)
    .single();
  if (error) throw error;
  return toSummary(data as Record<string, unknown>);
}

export async function archiveLayout(orgId: string, userId: string, id: string, writer?: SupabaseClient): Promise<void> {
  const w = serviceWriter(writer);
  const { error } = await w.from('report_layouts').update({ is_archived: true, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId);
  if (error) throw new Error(error.message);
}
