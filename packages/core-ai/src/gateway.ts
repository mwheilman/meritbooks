/**
 * Merit Suite Core — the single AI gateway (Architecture §3A).
 *
 * The ONLY path to Anthropic. Order of operations on each request (§3A.6):
 *   1. entitlement / feature availability
 *   2. runaway guards: rate limits + concurrency + max_tokens cap (§3A.5)
 *   3. budget check innermost-first: feature -> user -> tenant, vs running counters (§3A.3)
 *   4. if over hard cap: degrade / block per overage policy (§3A.4)
 *   5. else call Anthropic, tokens->cents via price table, write log + increment counters (§3A.2)
 *   6. return the standard response shape
 *
 * The tenant ceiling is the binding limit across ALL modules' combined usage.
 */

import { randomUUID } from 'crypto';
import { callAnthropic } from './provider';
import {
  acquireConcurrency, bumpRate, currentPeriodMonth, getCounterCost, getEntitlements,
  getFeatureCap, getModelPrice, getTierConfig, incrementCounter, releaseConcurrency, writeUsageLog,
} from './store';
import type {
  BudgetState, GatewayBudget, GatewayDeps, GatewayRequest, GatewayResponse, GatewayStatus, ProviderResult,
} from './types';

/** Convert token counts to cents using cents-per-million-tokens prices. */
export function tokensToCents(
  tokens: { input: number; output: number },
  price: { inPerMtok: number; outPerMtok: number }
): number {
  const cents = (tokens.input * price.inPerMtok + tokens.output * price.outPerMtok) / 1_000_000;
  return Math.round(cents);
}

interface LevelEval {
  applicable: boolean;
  state: BudgetState;
  pctUsed: number;     // 0..1+
}

/** Evaluate one budget level against its cap and the prior monthly counter. */
function evalLevel(priorCost: number, cap: number | null, softPct: number): LevelEval {
  if (cap == null || cap <= 0) return { applicable: false, state: 'under', pctUsed: 0 };
  const pct = priorCost / cap;
  const soft = softPct / 100;
  const state: BudgetState = pct >= 1 ? 'hard' : pct >= soft ? 'soft' : 'under';
  return { applicable: true, state, pctUsed: pct };
}

const SEVERITY: Record<BudgetState, number> = { under: 0, soft: 1, hard: 2 };

export async function runAiGateway(deps: GatewayDeps, req: GatewayRequest): Promise<GatewayResponse> {
  const { supabase: db } = deps;
  const correlationId = randomUUID();
  const periodMonth = currentPeriodMonth();
  const moduleName = String(req.module || '').toUpperCase();
  const feature = String(req.feature || 'default');
  const userKey = req.user_id ?? '';
  const callProvider = deps.callProvider ?? callAnthropic;
  const ttl = deps.inflightTtlSeconds ?? 120;

  // Helpers that always return through the same response shape.
  const reject = (status: GatewayStatus, message: string, budget?: GatewayBudget): GatewayResponse => ({
    status,
    result: null,
    model_used: null,
    tokens: { input: 0, output: 0 },
    cost_cents: 0,
    budget: budget ?? { state: 'under', tenant_pct_used: 0 },
    correlation_id: correlationId,
    message,
  });

  // ── 1. Entitlement / feature availability ──────────────────────────────────
  const entitlements = await getEntitlements(db, req.tenant_id);
  const moduleEntitled = entitlements[moduleName.toLowerCase()] === true || entitlements[moduleName] === true;
  if (!moduleEntitled) {
    await logBlocked(db, req, correlationId, moduleName, feature, 'blocked');
    return reject('blocked', `Module "${moduleName}" is not entitled for this tenant`);
  }

  const tier = await getTierConfig(db, req.tenant_id);

  // ── 2. Runaway guards (independent of budget) ──────────────────────────────
  if (tier.rate_per_user_per_min != null && req.user_id) {
    const c = await bumpRate(db, req.tenant_id, 'USER', userKey);
    if (c > tier.rate_per_user_per_min) {
      await logBlocked(db, req, correlationId, moduleName, feature, 'blocked');
      return reject('blocked', 'Rate limit exceeded (per-user calls/min)');
    }
  }
  if (tier.rate_per_tenant_per_min != null) {
    const c = await bumpRate(db, req.tenant_id, 'TENANT', '');
    if (c > tier.rate_per_tenant_per_min) {
      await logBlocked(db, req, correlationId, moduleName, feature, 'blocked');
      return reject('blocked', 'Rate limit exceeded (tenant calls/min)');
    }
  }

  const featureCap = await getFeatureCap(db, tier.tier, moduleName, feature);
  const perCallCeiling = Math.min(
    tier.max_tokens_ceiling,
    featureCap?.max_tokens ?? tier.max_tokens_ceiling
  );
  const maxTokens = Math.min(req.max_tokens ?? perCallCeiling, perCallCeiling);

  let haveSlot = false;
  try {
    haveSlot = await acquireConcurrency(db, req.tenant_id, tier.concurrency_limit, ttl, correlationId);
    if (!haveSlot) {
      await logBlocked(db, req, correlationId, moduleName, feature, 'blocked');
      return reject('blocked', 'Concurrency limit reached for this tenant');
    }

    // ── 3. Budget check (innermost-first: feature -> user -> tenant) ──────────
    const featureKey = `${moduleName}:${feature}`;
    const [featurePrior, userPrior, tenantPrior] = await Promise.all([
      featureCap ? getCounterCost(db, req.tenant_id, periodMonth, 'FEATURE', featureKey) : Promise.resolve(0),
      tier.per_user_cap_cents != null && req.user_id
        ? getCounterCost(db, req.tenant_id, periodMonth, 'USER', userKey) : Promise.resolve(0),
      getCounterCost(db, req.tenant_id, periodMonth, 'TENANT', ''),
    ]);

    const fEval = evalLevel(featurePrior, featureCap?.cap_cents ?? null, tier.soft_warn_pct);
    const uEval = evalLevel(userPrior, tier.per_user_cap_cents, tier.soft_warn_pct);
    const tEval = evalLevel(tenantPrior, tier.monthly_cap_cents, tier.soft_warn_pct);

    const worst = [fEval, uEval, tEval].reduce<BudgetState>(
      (acc, e) => (SEVERITY[e.state] > SEVERITY[acc] ? e.state : acc), 'under'
    );

    const budget: GatewayBudget = {
      state: worst,
      tenant_pct_used: round4(tEval.pctUsed),
      ...(uEval.applicable ? { user_pct_used: round4(uEval.pctUsed) } : {}),
      ...(fEval.applicable ? { feature_pct_used: round4(fEval.pctUsed) } : {}),
    };

    // ── 4. Over hard cap: degrade or block per overage policy ─────────────────
    let modelToUse = req.model;
    let degraded = false;
    if (worst === 'hard') {
      switch (tier.overage_policy) {
        case 'METERED':
          // pass-through (billed as overage); proceed but flag warn
          break;
        case 'DEGRADE_MODEL':
          if (tier.degrade_model && tier.degrade_model !== req.model) {
            modelToUse = tier.degrade_model;
            degraded = true;
          } else {
            return await blockHard(db, req, correlationId, moduleName, feature, budget, reject);
          }
          break;
        case 'UPSELL':
          return await blockHard(db, req, correlationId, moduleName, feature, budget, reject,
            'AI budget reached — upgrade your plan to continue');
        case 'HARD_STOP':
        default:
          return await blockHard(db, req, correlationId, moduleName, feature, budget, reject);
      }
    }

    // ── 5. Call the provider (or simulate on dry_run), meter, log, increment ──
    let provider: ProviderResult;
    if (req.dry_run) {
      const sim = req.sim_tokens ?? { input: 0, output: 0 };
      provider = { result: { dry_run: true }, model_used: modelToUse, tokens: { input: sim.input, output: sim.output } };
    } else {
      if (!deps.anthropicApiKey) {
        await logBlocked(db, req, correlationId, moduleName, feature, 'blocked');
        return reject('blocked', 'AI provider key not configured', budget);
      }
      provider = await callProvider({
        apiKey: deps.anthropicApiKey,
        model: modelToUse,
        max_tokens: maxTokens,
        messages: req.messages ?? [],
        system: req.system,
        params: req.params,
      });
    }

    const price = await getModelPrice(db, provider.model_used);
    const costCents = price ? tokensToCents(provider.tokens, price) : 0;

    let status: GatewayStatus =
      degraded ? 'degraded'
        : worst === 'hard' ? 'warn'  // METERED pass-through
          : worst === 'soft' ? 'warn'
            : 'ok';

    let message: string | null =
      degraded ? `Budget hard cap reached — served cheaper model (${modelToUse})`
        : worst === 'hard' ? 'Over budget cap — metered as overage'
          : worst === 'soft' ? 'Approaching AI budget cap'
            : (!price ? `Metered at $0: no price configured for model "${provider.model_used}"` : null);

    // Persist: one ai_usage_log row + counter increments (tenant + user always; feature when capped).
    await writeUsageLog(db, {
      orgId: req.tenant_id,
      userId: req.user_id,
      module: moduleName,
      feature,
      model: req.model,
      modelUsed: provider.model_used,
      status,
      tokensInput: provider.tokens.input,
      tokensOutput: provider.tokens.output,
      costCents,
      correlationId,
    });

    await incrementCounter(db, req.tenant_id, periodMonth, 'TENANT', '', costCents);
    if (req.user_id) await incrementCounter(db, req.tenant_id, periodMonth, 'USER', userKey, costCents);
    if (featureCap) await incrementCounter(db, req.tenant_id, periodMonth, 'FEATURE', featureKey, costCents);

    // ── 6. Return ─────────────────────────────────────────────────────────────
    return {
      status,
      result: provider.result,
      model_used: provider.model_used,
      tokens: provider.tokens,
      cost_cents: costCents,
      budget,
      correlation_id: correlationId,
      message,
    };
  } finally {
    if (haveSlot) await releaseConcurrency(db, correlationId).catch(() => {});
  }
}

async function blockHard(
  db: DB, req: GatewayRequest, correlationId: string, moduleName: string, feature: string,
  budget: GatewayBudget, reject: (s: GatewayStatus, m: string, b?: GatewayBudget) => GatewayResponse,
  message = 'AI budget reached'
): Promise<GatewayResponse> {
  await logBlocked(db, req, correlationId, moduleName, feature, 'blocked');
  return reject('blocked', message, budget);
}

async function logBlocked(
  db: DB, req: GatewayRequest, correlationId: string, moduleName: string, feature: string, status: GatewayStatus
): Promise<void> {
  await writeUsageLog(db, {
    orgId: req.tenant_id,
    userId: req.user_id,
    module: moduleName,
    feature,
    model: req.model,
    modelUsed: null,
    status,
    tokensInput: 0,
    tokensOutput: 0,
    costCents: 0,
    correlationId,
  }).catch(() => {});
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type DB = any;
