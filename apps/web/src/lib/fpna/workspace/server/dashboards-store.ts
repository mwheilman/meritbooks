/**
 * Dashboard persistence (migration 191, AC-W3). SERVER ONLY.
 *
 * Reads run as the member (RLS: tenant rows of the org + the member's OWN rows). Every write
 * goes through the service role AFTER the route's permission check and the pure lock rules
 * (dashboard-model.ts) — members hold no write grant on fpna_dashboards, so a `locked` or
 * `add_move` default cannot be bypassed through PostgREST. Every query also pins org_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { checkPersonalSave, rowFromDb, type PersonalSaveInput, type PublishInput } from '../dashboard-model';
import type { DashboardRow } from '../types';

export interface StoreCtx {
  supabase: SupabaseClient;
  orgId: string;
  /** Service client override (tests). */
  service?: SupabaseClient | null;
}

const COLUMNS = 'id, scope_kind, role_key, user_id, name, pack_key, cards, settings, lock_level, required_metrics, publish_mode, version, is_current, based_on_id, published_by, published_at, note, created_at, updated_at';

export class DashboardStoreError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422 | 500, readonly code: string, message: string) {
    super(message);
  }
}

function missingTable(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === '42P01' || /relation .*fpna_dashboards.* does not exist/i.test(e.message ?? ''));
}

/** The reader's current personal rows and the org's current tenant defaults. Degrades to none before 191 is applied. */
export async function listDashboards(ctx: StoreCtx, userId: string | null): Promise<{ personal: DashboardRow[]; tenant: DashboardRow[]; available: boolean }> {
  const { data, error } = await ctx.supabase.from('fpna_dashboards').select(COLUMNS).eq('org_id', ctx.orgId).eq('is_current', true).is('archived_at', null).order('updated_at', { ascending: false }).limit(200);
  if (error) {
    if (missingTable(error)) return { personal: [], tenant: [], available: false };
    throw new DashboardStoreError(500, 'DB_ERROR', error.message);
  }
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map(rowFromDb);
  return {
    personal: rows.filter((r) => r.scopeKind === 'user' && userId !== null && r.userId === userId),
    tenant: rows.filter((r) => r.scopeKind === 'tenant'),
    available: true,
  };
}

function writer(ctx: StoreCtx): SupabaseClient {
  return ctx.service ?? serviceWriter();
}

function conflict(e: { code?: string; message?: string }): boolean {
  return e.code === '23505' || /duplicate key|unique/i.test(e.message ?? '');
}

export async function savePersonal(ctx: StoreCtx, userId: string, role: string | null, input: PersonalSaveInput): Promise<DashboardRow> {
  const { tenant } = await listDashboards(ctx, userId);
  const check = checkPersonalSave(role, tenant, input.cards);
  if (!check.ok) throw new DashboardStoreError(check.status, check.code, check.message);
  const db = writer(ctx);
  const now = new Date().toISOString();
  if (input.id) {
    const { data: cur, error: readErr } = await db.from('fpna_dashboards').select('id, version, user_id, scope_kind').eq('id', input.id).eq('org_id', ctx.orgId).maybeSingle();
    if (readErr) throw new DashboardStoreError(500, 'DB_ERROR', readErr.message);
    const row = cur as { id: string; version: number; user_id: string | null; scope_kind: string } | null;
    if (!row || row.scope_kind !== 'user' || row.user_id !== userId) throw new DashboardStoreError(404, 'NOT_FOUND', 'That dashboard is not yours or no longer exists.');
    const { data, error } = await db
      .from('fpna_dashboards')
      .update({ name: input.name, pack_key: input.packKey, cards: input.cards, settings: input.settings, version: Number(row.version) + 1, updated_at: now })
      .eq('id', input.id)
      .eq('org_id', ctx.orgId)
      .eq('user_id', userId)
      .select(COLUMNS)
      .single();
    if (error) throw conflict(error) ? new DashboardStoreError(409, 'NAME_TAKEN', 'You already have a dashboard with that name.') : new DashboardStoreError(500, 'DB_ERROR', error.message);
    return rowFromDb(data as Record<string, unknown>);
  }
  const { data, error } = await db
    .from('fpna_dashboards')
    .insert({ org_id: ctx.orgId, scope_kind: 'user', user_id: userId, name: input.name, pack_key: input.packKey, cards: input.cards, settings: input.settings, created_by: userId, created_at: now, updated_at: now })
    .select(COLUMNS)
    .single();
  if (error) throw conflict(error) ? new DashboardStoreError(409, 'NAME_TAKEN', 'You already have a dashboard with that name.') : new DashboardStoreError(500, 'DB_ERROR', error.message);
  return rowFromDb(data as Record<string, unknown>);
}

export async function archivePersonal(ctx: StoreCtx, userId: string, id: string): Promise<void> {
  const { data, error } = await writer(ctx).from('fpna_dashboards').update({ archived_at: new Date().toISOString(), is_current: false }).eq('id', id).eq('org_id', ctx.orgId).eq('scope_kind', 'user').eq('user_id', userId).select('id');
  if (error) throw new DashboardStoreError(500, 'DB_ERROR', error.message);
  if (!data || (data as unknown[]).length === 0) throw new DashboardStoreError(404, 'NOT_FOUND', 'That dashboard is not yours or no longer exists.');
}

/** Publish a role default as a NEW version (the prior one stops being current). */
export async function publishDefault(ctx: StoreCtx, userId: string, input: PublishInput): Promise<DashboardRow> {
  const db = writer(ctx);
  let q = db.from('fpna_dashboards').select('id, version').eq('org_id', ctx.orgId).eq('scope_kind', 'tenant').eq('is_current', true).is('archived_at', null);
  q = input.roleKey === null ? q.is('role_key', null) : q.eq('role_key', input.roleKey);
  const { data: prevRows, error: prevErr } = await q;
  if (prevErr) throw new DashboardStoreError(500, 'DB_ERROR', prevErr.message);
  const prev = ((prevRows ?? []) as Array<{ id: string; version: number }>)[0] ?? null;
  if (prev) {
    const { error } = await db.from('fpna_dashboards').update({ is_current: false, updated_at: new Date().toISOString() }).eq('id', prev.id).eq('org_id', ctx.orgId);
    if (error) throw new DashboardStoreError(500, 'DB_ERROR', error.message);
  }
  const now = new Date().toISOString();
  const required = input.lockLevel === 'add_move' ? (input.requiredMetrics?.length ? input.requiredMetrics : input.cards.map((c) => c.metric)) : [];
  const { data, error } = await db
    .from('fpna_dashboards')
    .insert({
      org_id: ctx.orgId,
      scope_kind: 'tenant',
      role_key: input.roleKey,
      name: input.name,
      pack_key: input.packKey,
      cards: input.cards,
      settings: input.settings,
      lock_level: input.lockLevel,
      required_metrics: required,
      publish_mode: input.publishMode,
      version: (prev ? Number(prev.version) : 0) + 1,
      is_current: true,
      based_on_id: prev?.id ?? null,
      published_by: userId,
      published_at: now,
      note: input.note ?? null,
      created_by: userId,
      created_at: now,
      updated_at: now,
    })
    .select(COLUMNS)
    .single();
  if (error) {
    if (prev) await db.from('fpna_dashboards').update({ is_current: true }).eq('id', prev.id).eq('org_id', ctx.orgId);
    throw conflict(error) ? new DashboardStoreError(409, 'PUBLISH_RACE', 'Someone else published this default at the same moment. Reload and try again.') : new DashboardStoreError(500, 'DB_ERROR', error.message);
  }
  return rowFromDb(data as Record<string, unknown>);
}

/** Withdraw a role default (the role falls back to the every-role default or its pack). */
export async function withdrawDefault(ctx: StoreCtx, id: string): Promise<void> {
  const { data, error } = await writer(ctx).from('fpna_dashboards').update({ is_current: false, archived_at: new Date().toISOString() }).eq('id', id).eq('org_id', ctx.orgId).eq('scope_kind', 'tenant').select('id');
  if (error) throw new DashboardStoreError(500, 'DB_ERROR', error.message);
  if (!data || (data as unknown[]).length === 0) throw new DashboardStoreError(404, 'NOT_FOUND', 'That default no longer exists.');
}
