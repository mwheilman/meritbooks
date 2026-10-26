/**
 * The COA mapping cascade (spec §7.1) — per source account, FIRST HIT WINS, and every hit
 * names the rule that produced it:
 *
 *   1  firm mapping memory (a rule approved on another client)   0.97 (≥2 clients) / 0.93 (1)
 *                                                                 a conflicting rule → 0.66
 *   2  platform crosswalk (detail type → account role)            0.95 control / 0.85 other
 *   3  exact account number                                       0.99 keep chart / 0.75 standard
 *   4  name heuristics (exact 0.90, contained 0.70)
 *   5  AI proposal (never sees a balance)                         capped at 0.89
 *   6  unmapped — a person decides
 *
 * Bands are the bank feed's: Ready ≥ 0.90 · Check 0.70–0.89 · Decide < 0.70 or a type
 * warning. The type guard is hard: an incompatible type lands in Decide and can't be
 * accepted without a typed reason. Review order is by absolute cutover balance.
 * PURE — no I/O, no AI call (AI proposals are passed in).
 */

import type {
  ChartStrategy,
  MappingBand,
  MappingProposal,
  MappingRuleRef,
  MappingSourceAccount,
  MappingTarget,
  MeritAccountType,
  TypeGuard,
} from '../types';
import { crosswalkFor, isOpeningBalanceEquity } from './crosswalk';
import { nameKey, numberKey } from './memory';

export const READY_AT = 0.9;
export const CHECK_AT = 0.7;
export const AI_CAP = 0.89;

export function bandFor(confidence: number, guard: TypeGuard): MappingBand {
  if (guard === 'block') return 'decide';
  if (confidence >= READY_AT && guard === 'ok') return 'ready';
  if (confidence >= CHECK_AT) return 'check';
  return 'decide';
}

/** Hard type guard: ASSET→ASSET …; COGS ↔ OPEX warns; OTHER is allowed; unknown is allowed. */
export function typeGuard(source: MeritAccountType | null, target: MeritAccountType | null): TypeGuard {
  if (!source || !target || source === target) return 'ok';
  if (source === 'OTHER' || target === 'OTHER') return 'ok';
  const pl = new Set<MeritAccountType>(['COGS', 'OPEX']);
  if (pl.has(source) && pl.has(target)) return 'warn';
  return 'block';
}

const TYPE_WORD: Record<MeritAccountType, string> = {
  ASSET: 'asset', LIABILITY: 'liability', EQUITY: 'equity', REVENUE: 'revenue', COGS: 'cost of sales', OPEX: 'expense', OTHER: 'other',
};

function guardReason(guard: TypeGuard, s: MeritAccountType | null, t: MeritAccountType | null): string {
  if (guard === 'ok' || !s || !t) return '';
  return guard === 'warn'
    ? ` · ${TYPE_WORD[s]} → ${TYPE_WORD[t]}: allowed, check it`
    : ` · ${TYPE_WORD[s]} → ${TYPE_WORD[t]}: needs a typed reason`;
}

export interface AiSuggestion {
  targetAccountId: string;
  confidence: number;
  reasoning: string | null;
}

export interface CascadeInput {
  sources: ReadonlyArray<MappingSourceAccount>;
  targets: ReadonlyArray<MappingTarget>;
  /** Firm mapping memory for this source family. */
  rules: ReadonlyArray<MappingRuleRef>;
  /** Crosswalk roles resolved to this tenant's accounts (role → target id). */
  roleTargets: ReadonlyMap<string, string>;
  /** The tenant's retained-earnings account (for Opening Balance Equity), when resolved. */
  retainedEarningsTargetId?: string | null;
  chartStrategy: ChartStrategy;
  /** AI proposals keyed by source key (from the existing CONVERSION_MAP gateway call). */
  ai?: ReadonlyMap<string, AiSuggestion>;
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

function make(
  source: MappingSourceAccount,
  target: MappingTarget | undefined,
  p: Omit<MappingProposal, 'key' | 'band' | 'typeGuard' | 'targetAccountId'> & { targetAccountId: string | null },
): MappingProposal {
  const guard = target ? typeGuard(source.type, target.type) : 'ok';
  return {
    key: source.key,
    targetAccountId: p.targetAccountId,
    source: p.source,
    ruleId: p.ruleId,
    confidence: Math.max(0, Math.min(1, Math.round(p.confidence * 1000) / 1000)),
    band: p.targetAccountId ? bandFor(p.confidence, guard) : 'decide',
    typeGuard: guard,
    reason: p.reason + guardReason(guard, source.type, target?.type ?? null),
    conflict: p.conflict,
  };
}

/** Propose a target for every source account. Output is ordered largest balance first. */
export function runCascade(input: CascadeInput): MappingProposal[] {
  const byId = new Map(input.targets.map((t) => [t.id, t]));
  const byNumber = new Map(input.targets.map((t) => [t.number.trim(), t]));
  const ruleByKey = new Map<string, MappingRuleRef>();
  for (const r of input.rules) ruleByKey.set(`${r.matchKind}:${r.matchValue}`, r);

  const out: MappingProposal[] = [];
  for (const s of input.sources) {
    // 1. Firm mapping memory — exact number, then normalized name.
    const nk = numberKey(s.number);
    const mk = nameKey(s.name);
    const rule = (nk ? ruleByKey.get(`exact_number:${nk}`) : undefined) ?? (mk ? ruleByKey.get(`normalized_name:${mk}`) : undefined);
    if (rule && byId.has(rule.targetAccountId)) {
      const t = byId.get(rule.targetAccountId)!;
      const conf = rule.conflict ? 0.66 : rule.evidenceCount >= 2 ? 0.97 : 0.93;
      out.push(make(s, t, {
        targetAccountId: t.id,
        source: 'rule',
        ruleId: rule.id,
        confidence: conf,
        reason: rule.conflict
          ? `Your team’s rule, but clients disagree on it — settle it once`
          : `Your team’s rule · approved on ${rule.evidenceCount === 1 ? '1 client' : `${rule.evidenceCount} clients`}`,
        conflict: rule.conflict,
      }));
      continue;
    }

    // 2. Opening Balance Equity → retained earnings (data-quality item; controller approves).
    if (isOpeningBalanceEquity({ detailType: s.detailType, name: s.name }) && input.retainedEarningsTargetId && byId.has(input.retainedEarningsTargetId)) {
      const t = byId.get(input.retainedEarningsTargetId)!;
      out.push(make(s, t, { targetAccountId: t.id, source: 'crosswalk', ruleId: null, confidence: 0.7, reason: 'Opening Balance Equity usually belongs in retained earnings — the controller approves', conflict: false }));
      continue;
    }

    // 3. Platform crosswalk (detail type → role → this tenant's account).
    const cw = crosswalkFor({ detailType: s.detailType, sourceType: s.sourceType });
    const cwTarget = cw ? input.roleTargets.get(cw.role) : undefined;
    if (cw && cwTarget && byId.has(cwTarget)) {
      const t = byId.get(cwTarget)!;
      out.push(make(s, t, { targetAccountId: t.id, source: 'crosswalk', ruleId: null, confidence: cw.confidence, reason: cw.reason, conflict: false }));
      continue;
    }

    // 4. Exact account number.
    const num = s.number?.trim();
    if (num && byNumber.has(num)) {
      const t = byNumber.get(num)!;
      const conf = input.chartStrategy === 'keep_source_chart' ? 0.99 : 0.75;
      out.push(make(s, t, {
        targetAccountId: t.id,
        source: 'number',
        ruleId: null,
        confidence: conf,
        reason: input.chartStrategy === 'keep_source_chart' ? 'Same account number' : 'Same account number — numbers can coincide across charts, check the name',
        conflict: false,
      }));
      continue;
    }

    // 5. Name heuristics.
    const sn = normName(s.name);
    if (sn.length >= 3) {
      const exact = input.targets.find((t) => normName(t.name) === sn);
      if (exact) {
        out.push(make(s, exact, { targetAccountId: exact.id, source: 'name', ruleId: null, confidence: 0.9, reason: `Same name as “${exact.name}”`, conflict: false }));
        continue;
      }
      const contained = input.targets.find((t) => {
        const tn = normName(t.name);
        return tn.length >= 4 && (tn.includes(sn) || sn.includes(tn));
      });
      if (contained) {
        out.push(make(s, contained, { targetAccountId: contained.id, source: 'name', ruleId: null, confidence: 0.7, reason: `Name contains “${contained.name}”`, conflict: false }));
        continue;
      }
    }

    // 6. AI proposal (capped so AI alone never lands in Ready).
    const ai = input.ai?.get(s.key);
    if (ai && byId.has(ai.targetAccountId)) {
      const t = byId.get(ai.targetAccountId)!;
      out.push(make(s, t, {
        targetAccountId: t.id,
        source: 'ai',
        ruleId: null,
        confidence: Math.min(AI_CAP, Math.max(0, ai.confidence)),
        reason: `AI proposal · capped at ${Math.round(AI_CAP * 100)}${ai.reasoning ? ` · ${ai.reasoning.slice(0, 120)}` : ''}`,
        conflict: false,
      }));
      continue;
    }

    // 7. Nothing — a person decides.
    out.push(make(s, undefined, { targetAccountId: null, source: 'unmapped', ruleId: null, confidence: 0, reason: 'No good match — choose an account or request a new one', conflict: false }));
  }

  const bal = new Map(input.sources.map((s) => [s.key, Math.abs(s.balanceCents)]));
  return out.sort((a, b) => (bal.get(b.key) ?? 0) - (bal.get(a.key) ?? 0) || a.key.localeCompare(b.key));
}

export interface BandTotals {
  ready: { count: number; cents: number };
  check: { count: number; cents: number };
  decide: { count: number; cents: number };
}

/** Counts and absolute balance per band (the band header sums to its rows). */
export function bandTotals(rows: ReadonlyArray<{ band: MappingBand; balanceCents: number }>): BandTotals {
  const t: BandTotals = { ready: { count: 0, cents: 0 }, check: { count: 0, cents: 0 }, decide: { count: 0, cents: 0 } };
  for (const r of rows) {
    t[r.band].count++;
    t[r.band].cents += Math.abs(r.balanceCents);
  }
  return t;
}
