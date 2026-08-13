/**
 * Equity / cap-table onboarding — PURE normalizer + deterministic checks.
 *
 * This file has NO Supabase, NO gateway, NO React — every function is pure and
 * unit-tested. It is the shared source of truth for:
 *   • turning a loose model / CSV / manual payload into validated ProposedOwner[]
 *     (enum mapping + blank-on-unknown + confidence flags — never a guessed value);
 *   • checking that ownership foots to ~100% (the human-facing tie);
 *   • reconciling per-owner capital to the opening-TB equity total (report a
 *     variance, never force);
 *   • the deterministic commit gate (capTableBlockers).
 *
 * Money is bigint CENTS; percentages are numeric. Degrade-safe: with AI off, the
 * CSV / manual path produces the identical ProposedOwner shape the model would.
 */

import { dollarsToCents } from '@meritbooks/shared';
import {
  EQUITY_CLASSES,
  type EquityClass,
  type EntityForm,
  type OwnershipBasis,
  type PreferredTerms,
  type ProposedOwner,
  type ProposedCapTable,
  type OwnershipSumCheck,
  type OpeningCapitalReconcile,
} from './types';

/** Ownership is considered tied to 100% within this many percentage points. */
export const OWNERSHIP_TOLERANCE_PCT = 0.5;
/** Opening-capital reconcile tolerance (cents) — $1 of rounding is immaterial. */
export const CAPITAL_RECONCILE_TOLERANCE_CENTS = 100;
/** Confidence below this flags a field as "needs you". */
const LOW_CONFIDENCE = 0.6;

// ─────────────────────────────────────────────────────────────────────────────
// Coercion primitives (mirrors the parse-loan template).
// ─────────────────────────────────────────────────────────────────────────────

function toNumberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,%\s]/g, '');
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
  }
  const s = raw.trim();
  return s === '' ? null : s;
}

function toBoolOrNull(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'preferred', 'pref'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'common'].includes(s)) return false;
  }
  return null;
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Clamp a percent to [0, 100], or null when undeterminable. */
function toPercentOrNull(raw: unknown): number | null {
  const n = toNumberOrNull(raw);
  if (n === null) return null;
  // A ratio like 0.25 stated as a fraction becomes 25%. We DON'T auto-scale here —
  // the source columns are labeled "percent"; a value in (0,1] is treated verbatim
  // and the ownership-sum check surfaces any mistake to the human.
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** Money → cents. Accepts dollars (number/string) OR an explicit `_cents` field. */
function toCapitalCents(rawDollars: unknown, rawCents?: unknown): number | null {
  if (rawCents !== undefined && rawCents !== null && rawCents !== '') {
    const c = toNumberOrNull(rawCents);
    return c === null ? null : Math.round(c);
  }
  const d = toNumberOrNull(rawDollars);
  if (d === null) return null;
  return dollarsToCents(d);
}

export function mapEquityClass(raw: unknown, isPreferred?: boolean): EquityClass {
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (s.includes('PREF')) return 'PREFERRED';
    if (s.includes('COMMON')) return 'COMMON';
    if (s.includes('UNIT') || s.includes('MEMBER') || s.includes('LLC')) return 'LLC_UNIT';
    if (s.includes('PARTNER')) return 'PARTNER';
    if ((EQUITY_CLASSES as readonly string[]).includes(s)) return s as EquityClass;
  }
  return isPreferred ? 'PREFERRED' : 'COMMON';
}

export function mapEntityForm(raw: unknown): EntityForm {
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (s.includes('LLC') || s.includes('LIMITED LIABILITY')) return 'LLC';
    if (s.includes('CORP') || s.includes('INC') || s === 'C-CORP' || s === 'S-CORP') return 'CORP';
    if (s.includes('PARTNER') || s === 'LP' || s === 'LLP') return 'PARTNERSHIP';
    if (s.includes('SOLE') || s.includes('PROP')) return 'SOLE_PROP';
  }
  return 'LLC';
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner normalizer
// ─────────────────────────────────────────────────────────────────────────────

interface RawOwner {
  name?: unknown;
  ownership_pct?: unknown;
  ownership_percent?: unknown;
  units?: unknown;
  shares?: unknown;
  capital?: unknown;
  capital_contributed?: unknown;
  capital_contributed_cents?: unknown;
  class?: unknown;
  equity_class?: unknown;
  is_preferred?: unknown;
  preferred_terms?: unknown;
  confidence?: unknown;
}

function normalizePreferredTerms(raw: unknown): PreferredTerms | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const terms: PreferredTerms = {
    liquidation_preference: toNumberOrNull(t.liquidation_preference),
    dividend_rate: toNumberOrNull(t.dividend_rate),
    participating: toBoolOrNull(t.participating),
    seniority: toStringOrNull(t.seniority),
    notes: toStringOrNull(t.notes),
  };
  const anySet =
    terms.liquidation_preference !== null ||
    terms.dividend_rate !== null ||
    terms.participating !== null ||
    terms.seniority !== null ||
    terms.notes !== null;
  return anySet ? terms : null;
}

/** Normalize one loose owner record into a validated ProposedOwner. Never throws. */
export function normalizeOwner(raw: unknown): ProposedOwner {
  const o: RawOwner = (raw ?? {}) as RawOwner;

  const name = toStringOrNull(o.name) ?? '';
  const ownership_pct = toPercentOrNull(o.ownership_pct ?? o.ownership_percent);
  const units = toNumberOrNull(o.units ?? o.shares);
  const capital_contributed_cents = toCapitalCents(
    o.capital ?? o.capital_contributed,
    o.capital_contributed_cents,
  );
  const is_preferred = toBoolOrNull(o.is_preferred) ?? false;
  const equity_class = mapEquityClass(o.equity_class ?? o.class, is_preferred);
  const preferred_terms = normalizePreferredTerms(o.preferred_terms);

  const c = (o.confidence ?? {}) as Record<string, unknown>;
  const confidence: Record<string, number> = {
    name: conf(c.name),
    ownership_pct: conf(c.ownership_pct ?? c.ownership),
    units: conf(c.units),
    capital: conf(c.capital),
  };

  const low: string[] = [];
  if (!name) low.push('name');
  else if (confidence.name < LOW_CONFIDENCE) low.push('name');
  // Need either a percent OR units to place the owner on the cap table.
  if (ownership_pct === null && units === null) {
    low.push('ownership_pct');
  } else if (ownership_pct !== null && confidence.ownership_pct > 0 && confidence.ownership_pct < LOW_CONFIDENCE) {
    low.push('ownership_pct');
  }
  if (capital_contributed_cents !== null && confidence.capital > 0 && confidence.capital < LOW_CONFIDENCE) {
    low.push('capital');
  }

  return {
    name,
    ownership_pct,
    units,
    capital_contributed_cents,
    equity_class,
    is_preferred: is_preferred || equity_class === 'PREFERRED',
    preferred_terms,
    owner_entity_id: null,
    confidence,
    lowConfidenceFields: Array.from(new Set(low)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cap-table extraction normalizer (model JSON → ProposedCapTable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn the model's loose JSON into a validated ProposedCapTable. Determines the
 * ownership basis (percent vs units) from what the owners actually carry. Never
 * throws.
 */
export function normalizeEquityExtraction(raw: unknown): ProposedCapTable {
  const root = (raw ?? {}) as { cap_table?: Record<string, unknown> } & Record<string, unknown>;
  const ct = (root.cap_table ?? root) as Record<string, unknown>;

  const rawOwners = Array.isArray(ct.owners)
    ? ct.owners
    : Array.isArray((ct as { members?: unknown }).members)
      ? ((ct as { members: unknown[] }).members)
      : [];
  const owners = rawOwners.map(normalizeOwner).filter((o) => o.name || o.ownership_pct !== null || o.units !== null);

  // Basis: percent when any owner has a percent; else units when any has units.
  const anyPct = owners.some((o) => o.ownership_pct !== null);
  const anyUnits = owners.some((o) => o.units !== null);
  const ownershipBasis: OwnershipBasis = anyPct || !anyUnits ? 'PERCENT' : 'UNITS';

  return {
    entityForm: mapEntityForm(ct.entity_form ?? ct.form ?? (root as { entity_form?: unknown }).entity_form),
    ownershipBasis,
    owners,
    snippet: toStringOrNull(ct.snippet),
    documentNote: toStringOrNull(ct.document_note ?? (root as { document_note?: unknown }).document_note),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV / manual path (degrade-safe — identical output shape, no AI)
// ─────────────────────────────────────────────────────────────────────────────

/** Column → source-header mapping for the CSV path. */
export interface EquityColumnMap {
  name?: string;
  ownership_pct?: string;
  units?: string;
  capital?: string;
  equity_class?: string;
  is_preferred?: string;
}

/**
 * Map parsed CSV records into ProposedOwner[] using a column map. Pure — the
 * caller (route) does the CSV parsing; this only shapes + normalizes. Human-entered
 * values get confidence 1 (they are already a decision, not a guess).
 */
export function csvRowsToOwners(
  records: ReadonlyArray<Record<string, string>>,
  map: EquityColumnMap,
): ProposedOwner[] {
  const owners: ProposedOwner[] = [];
  for (const rec of records) {
    const pick = (key?: string): string | undefined => (key ? rec[key] : undefined);
    const name = (pick(map.name) ?? '').trim();
    const pctCell = pick(map.ownership_pct);
    const unitsCell = pick(map.units);
    const capitalCell = pick(map.capital);
    const classCell = pick(map.equity_class);
    const prefCell = pick(map.is_preferred);
    // Skip fully-blank lines (nothing to place).
    if (!name && !pctCell && !unitsCell && !capitalCell) continue;

    const owner = normalizeOwner({
      name,
      ownership_pct: pctCell,
      units: unitsCell,
      capital: capitalCell,
      class: classCell,
      is_preferred: prefCell,
      // Human/CSV-sourced → full confidence on whatever was provided.
      confidence: {
        name: name ? 1 : 0,
        ownership_pct: pctCell ? 1 : 0,
        units: unitsCell ? 1 : 0,
        capital: capitalCell ? 1 : 0,
      },
    });
    owners.push(owner);
  }
  return owners;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership-sum check (foots to ~100%)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check that ownership foots to ~100%. When the basis is UNITS, each owner's
 * effective percent is units / totalUnits × 100. Pure and total.
 */
export function ownershipSumCheck(
  owners: ReadonlyArray<Pick<ProposedOwner, 'ownership_pct' | 'units'>>,
  basis: OwnershipBasis,
): OwnershipSumCheck {
  const unitsTotal = owners.reduce((acc, o) => acc + (o.units ?? 0), 0);

  let effectivePercents: number[];
  if (basis === 'UNITS' && unitsTotal > 0) {
    effectivePercents = owners.map((o) => ((o.units ?? 0) / unitsTotal) * 100);
  } else {
    effectivePercents = owners.map((o) => o.ownership_pct ?? 0);
  }

  const totalPct = effectivePercents.reduce((acc, p) => acc + p, 0);
  const varianceFromHundred = totalPct - 100;
  const withinTolerance = Math.abs(varianceFromHundred) <= OWNERSHIP_TOLERANCE_PCT;

  return {
    basis,
    effectivePercents,
    totalPct: round4(totalPct),
    varianceFromHundred: round4(varianceFromHundred),
    unitsTotal,
    withinTolerance,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening-capital reconcile (report a variance; never force)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile the sum of per-owner capital contributions to the opening trial
 * balance's equity total. Opening balances arrive via the conversion pipeline; this
 * section captures the cap-table detail, so here we only REPORT how the two compare
 * — a non-zero variance is surfaced, not auto-corrected. Pure and total.
 *
 * `openingEquityCents` is the equity carried in the opening TB (natural credit
 * balance, positive), or null when it is not yet known (no opening entry posted).
 */
export function reconcileOpeningCapital(
  owners: ReadonlyArray<Pick<ProposedOwner, 'capital_contributed_cents'>>,
  openingEquityCents: number | null,
): OpeningCapitalReconcile {
  const stated = owners.filter((o) => o.capital_contributed_cents !== null);
  const holderCapitalCents = stated.reduce((acc, o) => acc + (o.capital_contributed_cents ?? 0), 0);
  const noCapitalStated = stated.length === 0;

  if (openingEquityCents === null || noCapitalStated) {
    return {
      holderCapitalCents,
      openingEquityCents,
      varianceCents: null,
      tied: true, // nothing to reconcile against
      noCapitalStated,
    };
  }

  const varianceCents = openingEquityCents - holderCapitalCents;
  const tied = Math.abs(varianceCents) <= CAPITAL_RECONCILE_TOLERANCE_CENTS;
  return { holderCapitalCents, openingEquityCents, varianceCents, tied, noCapitalStated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit gate (deterministic blockers — validate())
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The deterministic reasons a proposed cap table cannot be committed. An empty
 * array ⇒ ready. Pure and total — this is what the section's `validate()` wraps.
 *
 * Blockers (hard): no named owners; an owner with no name; an owner with neither a
 * percent nor units; a negative capital contribution; ownership that does not foot
 * to ~100% (a real cap table must total the whole company).
 */
export function capTableBlockers(proposal: {
  owners: ReadonlyArray<ProposedOwner>;
  ownershipBasis: OwnershipBasis;
}): string[] {
  const blockers: string[] = [];
  const owners = proposal.owners ?? [];

  const named = owners.filter((o) => o.name && o.name.trim() !== '');
  if (named.length === 0) {
    blockers.push('Add at least one owner / member.');
    return blockers;
  }
  if (named.length !== owners.length) {
    blockers.push('Every owner needs a name.');
  }
  for (const o of owners) {
    if (o.ownership_pct === null && o.units === null) {
      blockers.push(`"${o.name || 'An owner'}" needs an ownership % or a unit/share count.`);
    }
    if (o.ownership_pct !== null && (o.ownership_pct < 0 || o.ownership_pct > 100)) {
      blockers.push(`"${o.name || 'An owner'}" has an ownership % outside 0–100.`);
    }
    if (o.units !== null && o.units < 0) {
      blockers.push(`"${o.name || 'An owner'}" has negative units.`);
    }
    if (o.capital_contributed_cents !== null && o.capital_contributed_cents < 0) {
      blockers.push(`"${o.name || 'An owner'}" has a negative capital contribution.`);
    }
  }

  const check = ownershipSumCheck(owners, proposal.ownershipBasis);
  if (!check.withinTolerance) {
    const over = check.varianceFromHundred > 0;
    blockers.push(
      `Ownership totals ${check.totalPct}% — it must foot to 100% (currently ${over ? 'over' : 'under'} by ${Math.abs(check.varianceFromHundred)}%).`,
    );
  }

  return blockers;
}

/**
 * Derive the consolidation method a parent-owned edge implies from the parent's
 * ownership %: >50% = control → FULL (with NCI for the minority); 20–50% =
 * significant influence → EQUITY; below 20% = NONE (excluded). Pure.
 */
export function deriveConsolidationMethod(ownershipPercent: number): 'FULL' | 'EQUITY' | 'NONE' {
  if (ownershipPercent > 50) return 'FULL';
  if (ownershipPercent >= 20) return 'EQUITY';
  return 'NONE';
}
