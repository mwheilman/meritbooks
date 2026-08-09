export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { runAiGateway } from '@meritbooks/core-ai';
import { formatMoney } from '@meritbooks/shared';
import { expandDrivers, type BudgetDriver } from '@/lib/budget/drivers';
import {
  buildThreeCase,
  summarizeExpansion,
  type ScenarioOverride,
  type ScenarioDefinition,
} from '@/lib/budget/scenarios';

/**
 * POST /api/fpna/nl-scenario — Natural-language what-if modeling for FP&A.
 *
 * The user types a scenario in plain English ("raise revenue 8% and cut
 * headcount cost 12% starting Q3", "what if we lose our biggest customer",
 * "model a 15% price increase with 5% volume attrition"). This route turns that
 * sentence into STRUCTURED, deterministic scenario levers layered on the tenant's
 * REAL driver-based budget — it never lets the model invent the resulting numbers.
 *
 * Grounding contract (why this is trustworthy, mirrors /api/reports/narrative):
 *   1. We deterministically EXPAND the tenant's plan-of-record drivers and compute
 *      the real base-case P&L (revenue / COGS / OPEX / net income) IN CODE.
 *   2. We hand the model ONLY those facts + the fixed lever vocabulary the engine
 *      supports (revenue growth %, cost change %, headcount ±N). The model's job is
 *      PARSING: map the sentence to lever percentages / head counts and assign each
 *      modeled scenario to best / base / worst by sentiment. It proposes DELTAS —
 *      never dollar results.
 *   3. We validate + clamp the parsed levers with zod, then re-run the SAME
 *      deterministic scenario engine (`buildThreeCase`) the UI uses, so the modeled
 *      P&L is reproducible and cannot drift from the model's prose.
 *
 * Timing note: the driver engine models a full fiscal year. When a change is
 * described as starting mid-year ("starting Q3"), the model is instructed to
 * express the ANNUAL-EQUIVALENT delta and record the timing as a human-readable
 * assumption — surfaced in the UI for the user to confirm or tweak. Line-item
 * specifics the ledger cannot resolve ("our biggest customer") are proposed as a
 * revenue % with the assumption flagged for the user to adjust.
 *
 * Degrade-safe: no key / blocked / unparseable → a deterministic keyword heuristic
 * so the feature always returns something honest (source: 'heuristic').
 *
 * Every AI call routes through the Core AI gateway (metered, budget-capped); this
 * route holds no Anthropic key beyond handing it to the gateway.
 */

const NL_MODEL = 'claude-sonnet-4-20250514';
const NL_FEATURE = 'NL_SCENARIO';

// ── Driver validation (mirrors /api/budgets/scenarios) ───────────────────────
const ACCOUNT_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'] as const;

const baseDriver = {
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  accountId: z.string().min(1),
  accountType: z.enum(ACCOUNT_TYPES),
};

const driverSchema = z.discriminatedUnion('driverType', [
  z.object({
    ...baseDriver,
    driverType: z.literal('volume_x_rate'),
    unitRateCents: z.number().int(),
    volumeByMonth: z.array(z.number()).max(12),
  }),
  z.object({
    ...baseDriver,
    driverType: z.literal('percent_of_revenue'),
    percentBps: z.number().int().min(0).max(1_000_000),
  }),
  z.object({
    ...baseDriver,
    driverType: z.literal('fixed'),
    annualAmountCents: z.number().int(),
    weights: z.array(z.number()).length(12).optional(),
  }),
  z.object({
    ...baseDriver,
    driverType: z.literal('growth_rate'),
    baseMonthlyCents: z.number().int(),
    monthlyGrowthBps: z.number().int().min(-9999).max(1_000_000),
  }),
]);

const schema = z.object({
  text: z.string().min(2).max(1000),
  baseDrivers: z.array(driverSchema).min(1).max(500),
  beginningCashCents: z.number().int().optional(),
  monthlyCostPerHeadCents: z.number().int().min(0).optional(),
  /** OPEX account a headcount override posts to (from the scope's accounts). */
  headcountAccountId: z.string().min(1).optional(),
});

type Body = z.infer<typeof schema>;
type CaseKey = 'best' | 'base' | 'worst';

/** The parsed levers for one case, in DISPLAY units (percent / head count). */
interface ParsedCaseLevers {
  revenueGrowthPct: number;
  costChangePct: number;
  headcountDelta: number;
}

interface ParsedScenario {
  scenarioName: string;
  cases: Record<CaseKey, ParsedCaseLevers>;
  assumptions: string[];
  notes: string | null;
  confidence: number; // 0..1
}

/** Locally-typed gateway meta — the package response type collapses to `never`
 *  in this build graph (see /api/nl/route.ts), which poisons field reads. */
interface GatewayMeta {
  status: string;
  result: unknown;
  message?: string | null;
  correlation_id?: string | null;
  model_used?: string | null;
  cost_cents?: number | null;
  budget?: { state?: string | null } | null;
}

const EMPTY_LEVERS: ParsedCaseLevers = { revenueGrowthPct: 0, costChangePct: 0, headcountDelta: 0 };

function clampPct(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-100, Math.min(1000, Math.round(v * 100) / 100));
}
function clampHeads(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1000, Math.min(1000, Math.trunc(v)));
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const block = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return block?.text ?? null;
}

/** Pull the first balanced JSON object out of a model response (tolerates code
 *  fences and surrounding prose). */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.replace(/```json/gi, '```').split('```');
  const candidates = fenced.length > 1 ? fenced : [text];
  for (const chunk of candidates) {
    const start = chunk.indexOf('{');
    const end = chunk.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const obj = JSON.parse(chunk.slice(start, end + 1));
      if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function coerceCase(raw: unknown): ParsedCaseLevers {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    revenueGrowthPct: clampPct(o.revenueGrowthPct ?? o.revenue_growth_pct ?? 0),
    costChangePct: clampPct(o.costChangePct ?? o.cost_change_pct ?? 0),
    headcountDelta: clampHeads(o.headcountDelta ?? o.headcount_delta ?? 0),
  };
}

function coerceParsed(obj: Record<string, unknown>): ParsedScenario {
  const casesRaw = (obj.cases && typeof obj.cases === 'object' ? obj.cases : {}) as Record<string, unknown>;
  const assumptionsRaw = Array.isArray(obj.assumptions) ? obj.assumptions : [];
  const conf = Number(obj.confidence);
  return {
    scenarioName: String(obj.scenarioName ?? obj.name ?? 'NL scenario').slice(0, 120),
    cases: {
      best: coerceCase(casesRaw.best),
      base: coerceCase(casesRaw.base),
      worst: coerceCase(casesRaw.worst),
    },
    assumptions: assumptionsRaw.map((a) => String(a).slice(0, 240)).slice(0, 12),
    notes: obj.notes == null ? null : String(obj.notes).slice(0, 600),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
  };
}

function leversToOverrides(
  lv: ParsedCaseLevers,
  monthlyCostPerHeadCents: number,
  accountId: string | undefined,
): ScenarioOverride[] {
  const out: ScenarioOverride[] = [];
  if (lv.revenueGrowthPct !== 0) out.push({ kind: 'revenue_growth', deltaBps: Math.round(lv.revenueGrowthPct * 100) });
  if (lv.costChangePct !== 0) out.push({ kind: 'cost_change', deltaBps: Math.round(lv.costChangePct * 100) });
  if (lv.headcountDelta !== 0 && accountId) {
    out.push({ kind: 'headcount', deltaHeads: lv.headcountDelta, monthlyCostPerHeadCents, accountId });
  }
  return out;
}

// ── Deterministic fallback heuristic (no AI) ─────────────────────────────────
// A clause-aware keyword parser so the feature degrades HONESTLY when the AI
// provider is unavailable. It handles BOTH natural orderings — "raise revenue 8%"
// (verb→noun) and "revenue up 8%" (noun→verb) — plus multi-clause inputs
// ("raise revenue 8% and cut costs 12%"), headcount moves ("hire 3 people"), and
// unquantified downside ("what if we lose our biggest customer").

/** Default revenue hit assumed when a lost customer/contract is described with
 *  no percentage — surfaced as an explicit, adjustable assumption. */
const DEF_CUSTOMER_LOSS_PCT = 15;

const HEUR_DOWN = /\b(cut|cuts|reduc\w*|decreas\w*|declin\w*|lower\w*|trim\w*|drop\w*|down|slash\w*|shrink\w*|fall\w*|lose|lost|los\w*|attrition|churn|fewer|less)\b/;
const HEUR_UP = /\b(rais\w*|increas\w*|grow\w*|grew|boost\w*|expand\w*|gain\w*|jump\w*|bump\w*|higher|more|up|add\w*)\b/;
const HEUR_COST = /\b(cost|costs|expens\w*|opex|spend\w*|overhead|payroll|salar\w*|wage\w*|burn)\b/;
const HEUR_REV = /\b(revenue|sales|top.?line|price|pricing|volume|booking\w*|turnover)\b/;
const HEUR_HEAD_NOUN = '(?:head|heads|headcount|employee|employees|person|people|staff|worker|workers|hire|hires|fte|ftes|role|roles|position|positions|job|jobs)';
const HEUR_HIRE = new RegExp(`\\b(?:hir\\w*|add\\w*|onboard\\w*)\\s+(\\d+)\\s+${HEUR_HEAD_NOUN}`);
const HEUR_FIRE = new RegExp(`\\b(?:lay\\s?off|layoff\\w*|cut\\w*|reduc\\w*|remov\\w*|eliminat\\w*|los\\w*|lost)\\s+(\\d+)\\s+${HEUR_HEAD_NOUN}`);
const HEUR_ADVERSE = /\b(lose|lost|los\w*|recession|downturn|attrition|churn|worst|risk|declin\w*|slow\w*|headwind|shortfall)\b/;
const HEUR_UPSIDE = /\b(price\s+increase|new\s+(?:contract|customer|deal|logo)|upside|best\s+case|expansion|tailwind)\b/;

function heuristicParse(text: string): ParsedScenario {
  const t = text.toLowerCase();
  // Split into clauses on connectives + punctuation so each move ("cut costs
  // 12%") is scored against its OWN subject/direction, not the whole sentence.
  const clauses = t
    .split(/\s+and\s+|\s+with\s+|\s+plus\s+|\s+while\s+|\s+but\s+|[,;.]/)
    .map((c) => c.trim())
    .filter(Boolean);
  const units = clauses.length > 0 ? clauses : [t];

  let revenuePct = 0;
  let costPct = 0;
  let headcount = 0;
  const flagged: string[] = [];

  for (const c of units) {
    // Headcount moves carry a bare integer (+ a headcount noun), not a %.
    const hire = c.match(HEUR_HIRE);
    if (hire) headcount += Number(hire[1]);
    const fire = c.match(HEUR_FIRE);
    if (fire) headcount -= Number(fire[1]);

    // A percentage move in this clause → attribute to cost vs revenue by the
    // clause's own keywords; direction from the clause's own verbs.
    const pm = c.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pm) {
      const val = Number(pm[1]);
      const down = HEUR_DOWN.test(c) && !HEUR_UP.test(c);
      const signed = down ? -val : val;
      const isCost = HEUR_COST.test(c);
      const isRev = HEUR_REV.test(c);
      if (isCost && !isRev) costPct += signed;
      else if (isRev) revenuePct += signed; // revenue wins ties (price/volume language)
      else if (isCost) costPct += signed;
      // neither keyword present → cannot attribute; skip rather than guess.
    } else if (
      /\b(los\w*|lost|lose|leav\w*|drop\w*)\b/.test(c) &&
      /\b(customer|client|account|contract|deal|logo)\b/.test(c)
    ) {
      // Unquantified downside (a named customer/contract the ledger can't resolve).
      revenuePct -= DEF_CUSTOMER_LOSS_PCT;
      flagged.push(
        `Assumed ~${DEF_CUSTOMER_LOSS_PCT}% revenue loss from a lost customer/contract — no percentage was given; adjust to that account's actual share.`,
      );
    }
  }

  const levers: ParsedCaseLevers = {
    revenueGrowthPct: clampPct(revenuePct),
    costChangePct: clampPct(costPct),
    headcountDelta: clampHeads(headcount),
  };

  // Assign the modeled change to best / base / worst by sentiment, falling back
  // to the net favorability of the parsed levers (revenue up / cost down = good).
  const adverse = HEUR_ADVERSE.test(t);
  const upside = HEUR_UPSIDE.test(t);
  const favorable = levers.revenueGrowthPct > 0 || levers.costChangePct < 0;
  const unfavorable = levers.revenueGrowthPct < 0 || levers.costChangePct > 0;
  let target: CaseKey;
  if (adverse && !upside) target = 'worst';
  else if (upside && !adverse) target = 'best';
  else if (unfavorable && !favorable) target = 'worst';
  else if (favorable && !unfavorable) target = 'best';
  else target = 'base';

  const cases: Record<CaseKey, ParsedCaseLevers> = {
    best: { ...EMPTY_LEVERS }, base: { ...EMPTY_LEVERS }, worst: { ...EMPTY_LEVERS },
  };
  cases[target] = levers;

  const assumptions: string[] = [];
  if (levers.revenueGrowthPct) assumptions.push(`Revenue ${levers.revenueGrowthPct > 0 ? '+' : ''}${levers.revenueGrowthPct}% (applied to all revenue drivers)`);
  if (levers.costChangePct) assumptions.push(`Costs ${levers.costChangePct > 0 ? '+' : ''}${levers.costChangePct}% (across COGS + OPEX)`);
  if (levers.headcountDelta) assumptions.push(`Headcount ${levers.headcountDelta > 0 ? '+' : ''}${levers.headcountDelta} (each at the assumed monthly cost / head)`);
  assumptions.push(...flagged);

  return {
    scenarioName: text.slice(0, 60),
    cases,
    notes: 'AI unavailable — modeled with a keyword parser. Review and tweak the levers before applying.',
    assumptions,
    confidence: assumptions.length > 0 ? 0.4 : 0.15,
  };
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM =
  'You translate a plain-English financial "what-if" into STRUCTURED scenario levers ' +
  'for a driver-based annual budget. You do NOT compute results — a deterministic engine does that. ' +
  'The ONLY levers available are, per case: revenueGrowthPct (scales every revenue driver, %), ' +
  'costChangePct (scales COGS + OPEX, %), and headcountDelta (whole heads added(+)/removed(−), each ' +
  'costing a fixed monthly amount). Rules: ' +
  '(1) Assign each modeled scenario to best, base, or worst by sentiment — a neutral reforecast → base, ' +
  'a downside/risk (lost customer, recession, attrition) → worst, an upside (price increase, new contract) → best. ' +
  'Leave untouched cases at all-zero (they represent the unchanged plan of record). You MAY populate several ' +
  'cases only if the user explicitly gives a range. ' +
  '(2) Direction matters: "cut costs 12%" → costChangePct -12; "lose biggest customer" → a NEGATIVE revenueGrowthPct you estimate. ' +
  '(3) If a change starts mid-year (e.g. "starting Q3"), express the ANNUAL-EQUIVALENT percentage (a Q3 start affects ~half the year) ' +
  'and state the timing in assumptions. ' +
  '(4) For line-item specifics the ledger cannot resolve (a named customer/product), propose your best revenue/cost % and FLAG the assumption. ' +
  '(5) Respond with ONLY a JSON object, no prose, shaped exactly: ' +
  '{"scenarioName": string, "cases": {"best": {"revenueGrowthPct": number, "costChangePct": number, "headcountDelta": number}, ' +
  '"base": {...}, "worst": {...}}, "assumptions": string[], "notes": string, "confidence": number between 0 and 1}. ' +
  'Every non-zero lever must have a matching plain-English line in assumptions.';

function buildPrompt(text: string, baseDrivers: BudgetDriver[], monthlyCostPerHeadCents: number): string {
  const expansion = expandDrivers(baseDrivers);
  const s = summarizeExpansion(expansion, 0);
  const driverLines = expansion.drivers
    .slice(0, 60)
    .map((d) => `- ${d.label} · ${d.accountType} · ${formatMoney(d.annualCents)}/yr`)
    .join('\n');
  return [
    'TENANT PLAN OF RECORD (deterministically computed — do not alter these figures):',
    `Revenue: ${formatMoney(s.revenueCents)}`,
    `COGS: ${formatMoney(s.cogsCents)} · Gross profit: ${formatMoney(s.grossProfitCents)} (${(s.grossMarginBps / 100).toFixed(1)}%)`,
    `OPEX: ${formatMoney(s.opexCents)}`,
    `Net income: ${formatMoney(s.netIncomeCents)} (${(s.netMarginBps / 100).toFixed(1)}%)`,
    `Assumed cost per added head: ${formatMoney(monthlyCostPerHeadCents)}/month`,
    '',
    'Budget drivers:',
    driverLines || '(none)',
    '',
    `USER SCENARIO: """${text}"""`,
    '',
    'Return the JSON now.',
  ].join('\n');
}

/** Compute the modeled three-case P&L from parsed levers (same engine as the UI). */
function modelImpact(body: Body, parsed: ParsedScenario) {
  const costPerHead = body.monthlyCostPerHeadCents ?? 0;
  const def: ScenarioDefinition = {
    name: parsed.scenarioName,
    baseDrivers: body.baseDrivers as BudgetDriver[],
    beginningCashCents: body.beginningCashCents ?? 0,
    cases: {
      best: leversToOverrides(parsed.cases.best, costPerHead, body.headcountAccountId),
      base: leversToOverrides(parsed.cases.base, costPerHead, body.headcountAccountId),
      worst: leversToOverrides(parsed.cases.worst, costPerHead, body.headcountAccountId),
    },
  };
  const r = buildThreeCase(def);
  return {
    best: { summary: r.best.summary },
    base: { summary: r.base.summary },
    worst: { summary: r.worst.summary },
    varianceVsBase: r.varianceVsBase,
  };
}

export const POST = apiHandler(schema, async (body: Body, ctx) => {
  const { userId, orgId, supabase } = ctx;

  const apiKey = getAnthropicApiKey();

  // No key → deterministic heuristic, still grounded via the real engine.
  if (!apiKey) {
    const parsed = heuristicParse(body.text);
    return NextResponse.json({
      parsed,
      result: modelImpact(body, parsed),
      meta: { source: 'heuristic', model: null, message: 'AI provider key not configured', budgetState: 'under' },
    });
  }

  const admin = createAdminSupabase();
  let gw: GatewayMeta;
  try {
    gw = (await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: orgId ?? '',
        user_id: userId,
        module: 'BOOKS',
        feature: NL_FEATURE,
        model: NL_MODEL,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: buildPrompt(body.text, body.baseDrivers as BudgetDriver[], body.monthlyCostPerHeadCents ?? 0) }],
          },
        ],
        max_tokens: 700,
      },
    )) as unknown as GatewayMeta;
  } catch (e) {
    const parsed = heuristicParse(body.text);
    return NextResponse.json({
      parsed,
      result: modelImpact(body, parsed),
      meta: { source: 'heuristic', model: null, message: e instanceof Error ? e.message : 'Gateway error', budgetState: 'under' },
    });
  }

  if (gw.status === 'blocked' || gw.result == null) {
    const parsed = heuristicParse(body.text);
    return NextResponse.json({
      parsed,
      result: modelImpact(body, parsed),
      meta: { source: 'heuristic', model: gw.model_used ?? null, message: gw.message ?? 'AI request blocked', budgetState: gw.budget?.state ?? 'under' },
    });
  }

  const text = extractText(gw.result);
  const obj = text ? parseJsonObject(text) : null;
  if (!obj) {
    const parsed = heuristicParse(body.text);
    return NextResponse.json({
      parsed,
      result: modelImpact(body, parsed),
      meta: { source: 'heuristic', model: gw.model_used ?? null, message: 'Could not parse the model response', budgetState: gw.budget?.state ?? 'under' },
    });
  }

  const parsed = coerceParsed(obj);
  const result = modelImpact(body, parsed);

  // Audit the AI proposal to the existing decision-log rail (org-scoped, RLS).
  let decisionId: string | null = null;
  if (orgId) {
    try {
      const { data } = await supabase
        .from('ai_decisions')
        .insert({
          org_id: orgId,
          feature: NL_FEATURE,
          model_requested: NL_MODEL,
          model_used: gw.model_used,
          correlation_id: gw.correlation_id,
          input_summary: `NL scenario: ${body.text}`.slice(0, 2000),
          proposed_output: { parsed, source: 'ai' },
          reasoning: 'AI parsed a plain-English what-if into scenario levers; the deterministic engine computed all figures.',
          status: 'PROPOSED',
          created_by_user: userId,
        })
        .select('id')
        .single();
      decisionId = (data as { id: string } | null)?.id ?? null;
    } catch (e) {
      console.error('[fpna-nl-scenario] decision log failed (non-fatal):', e);
    }
  }

  return NextResponse.json({
    parsed,
    result,
    meta: {
      source: 'ai',
      model: gw.model_used ?? null,
      decisionId,
      budgetState: gw.budget?.state ?? 'under',
      costCents: gw.cost_cents ?? 0,
      message: gw.message ?? null,
    },
  });
});
