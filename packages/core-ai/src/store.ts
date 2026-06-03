/**
 * Data access for the AI gateway. All reads/writes hit Core-owned tables in the
 * `core` schema only. The gateway runs with the service-role client (trusted Core
 * code); RLS still protects any direct module access.
 */

import type { TierConfig } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type DB = any;

/** First day of the current month (UTC), as YYYY-MM-DD. */
export function currentPeriodMonth(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/** Resolve the tenant's tier config (falls back to 'default'). */
export async function getTierConfig(db: DB, orgId: string): Promise<TierConfig> {
  const { data: org } = await db
    .schema('core').from('organizations')
    .select('ai_tier, entitlements')
    .eq('id', orgId)
    .maybeSingle();
  const tier = (org?.ai_tier as string) || 'default';

  let row = await readTierRow(db, tier);
  if (!row && tier !== 'default') row = await readTierRow(db, 'default');

  return {
    tier: row?.tier ?? 'default',
    monthly_cap_cents: nullableInt(row?.monthly_cap_cents),
    per_user_cap_cents: nullableInt(row?.per_user_cap_cents),
    soft_warn_pct: row?.soft_warn_pct != null ? Number(row.soft_warn_pct) : 80,
    overage_policy: (row?.overage_policy as TierConfig['overage_policy']) ?? 'HARD_STOP',
    degrade_model: row?.degrade_model ?? null,
    max_tokens_ceiling: row?.max_tokens_ceiling != null ? Number(row.max_tokens_ceiling) : 8192,
    rate_per_user_per_min: nullableInt(row?.rate_per_user_per_min),
    rate_per_tenant_per_min: nullableInt(row?.rate_per_tenant_per_min),
    concurrency_limit: nullableInt(row?.concurrency_limit),
  };
}

async function readTierRow(db: DB, tier: string) {
  const { data } = await db
    .schema('core').from('ai_tier_config')
    .select('*')
    .eq('tier', tier)
    .eq('is_active', true)
    .maybeSingle();
  return data ?? null;
}

/** Read the entitlements map; the gateway checks the module is offered. */
export async function getEntitlements(db: DB, orgId: string): Promise<Record<string, unknown>> {
  const { data } = await db
    .schema('core').from('organizations')
    .select('entitlements')
    .eq('id', orgId)
    .maybeSingle();
  return (data?.entitlements as Record<string, unknown>) ?? {};
}

/** Optional per (tier, module, feature) cap. */
export async function getFeatureCap(
  db: DB, tier: string, moduleName: string, feature: string
): Promise<{ cap_cents: number; max_tokens: number | null } | null> {
  const { data } = await db
    .schema('core').from('ai_feature_caps')
    .select('cap_cents, max_tokens, is_active')
    .eq('tier', tier).eq('module', moduleName).eq('feature', feature)
    .eq('is_active', true)
    .maybeSingle();
  if (!data) return null;
  return { cap_cents: Number(data.cap_cents), max_tokens: nullableInt(data.max_tokens) };
}

/** Read a single monthly counter's cost (0 if none yet). */
export async function getCounterCost(
  db: DB, orgId: string, periodMonth: string, scope: 'TENANT' | 'USER' | 'FEATURE', scopeKey: string
): Promise<number> {
  const { data } = await db
    .schema('core').from('ai_usage_counters')
    .select('cost_cents')
    .eq('org_id', orgId).eq('period_month', periodMonth).eq('scope', scope).eq('scope_key', scopeKey)
    .maybeSingle();
  return data ? Number(data.cost_cents) : 0;
}

/** Token price for a model (cents per million tokens). Null if not configured. */
export async function getModelPrice(
  db: DB, model: string
): Promise<{ inPerMtok: number; outPerMtok: number } | null> {
  const { data } = await db
    .schema('core').from('ai_model_prices')
    .select('input_price_per_mtok_cents, output_price_per_mtok_cents, is_active')
    .eq('model', model)
    .maybeSingle();
  if (!data || data.is_active === false) return null;
  return {
    inPerMtok: Number(data.input_price_per_mtok_cents),
    outPerMtok: Number(data.output_price_per_mtok_cents),
  };
}

export async function bumpRate(db: DB, orgId: string, scope: 'USER' | 'TENANT', key: string): Promise<number> {
  const { data, error } = await db.schema('core').rpc('ai_bump_rate', {
    p_org: orgId, p_scope: scope, p_key: key,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export async function acquireConcurrency(
  db: DB, orgId: string, limit: number | null, ttlSeconds: number, correlationId: string
): Promise<boolean> {
  const { data, error } = await db.schema('core').rpc('ai_concurrency_acquire', {
    p_org: orgId, p_limit: limit, p_ttl_seconds: ttlSeconds, p_corr: correlationId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

export async function releaseConcurrency(db: DB, correlationId: string): Promise<void> {
  await db.schema('core').rpc('ai_concurrency_release', { p_corr: correlationId });
}

export async function incrementCounter(
  db: DB, orgId: string, periodMonth: string, scope: 'TENANT' | 'USER' | 'FEATURE', scopeKey: string, cost: number
): Promise<void> {
  const { error } = await db.schema('core').rpc('ai_increment_counter', {
    p_org: orgId, p_month: periodMonth, p_scope: scope, p_key: scopeKey, p_cost: cost,
  });
  if (error) throw new Error(error.message);
}

export interface UsageLogRow {
  orgId: string;
  userId: string | null;
  module: string;
  feature: string;
  model: string;
  modelUsed: string | null;
  status: string;
  tokensInput: number;
  tokensOutput: number;
  costCents: number;
  correlationId: string;
}

export async function writeUsageLog(db: DB, row: UsageLogRow): Promise<void> {
  await db.schema('core').from('ai_usage_log').insert({
    org_id: row.orgId,
    user_id: row.userId,
    module: row.module,
    feature: row.feature,
    model: row.model,
    model_used: row.modelUsed,
    status: row.status,
    tokens_input: row.tokensInput,
    tokens_output: row.tokensOutput,
    cost_cents: row.costCents,
    correlation_id: row.correlationId,
  });
}

function nullableInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}
