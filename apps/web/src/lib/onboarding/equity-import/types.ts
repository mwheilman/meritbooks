/**
 * Equity / cap-table onboarding — shared TYPES.
 *
 * The equity section captures the OWNERSHIP detail of a company: its owners /
 * members, each one's ownership % (or units/shares), capital contributed, and the
 * equity class (common / preferred / LLC unit). This is the cap-table layer that
 * sets up a holding-company structure and the consolidation ownership on day one.
 *
 * Money is bigint CENTS; percentages are numeric (0..100). Everything here is a
 * PROPOSAL shape — the AI (or a CSV / manual entry) proposes these facts and a
 * human confirms; nothing is authoritative until it is committed.
 */

/** The kind of equity a holder owns. */
export type EquityClass = 'COMMON' | 'PREFERRED' | 'LLC_UNIT' | 'PARTNER' | 'OTHER';

export const EQUITY_CLASSES: readonly EquityClass[] = [
  'COMMON',
  'PREFERRED',
  'LLC_UNIT',
  'PARTNER',
  'OTHER',
] as const;

/** The legal form of the entity being capitalized (informational). */
export type EntityForm = 'LLC' | 'CORP' | 'PARTNERSHIP' | 'SOLE_PROP' | 'OTHER';

/** How ownership is expressed in the source document. */
export type OwnershipBasis = 'PERCENT' | 'UNITS';

/** Preferred-equity economics, when a holder is a preferred class. Free-form-safe. */
export interface PreferredTerms {
  /** Liquidation preference multiple (1 = 1x). Null if not stated. */
  liquidation_preference?: number | null;
  /** Stated/cumulative dividend rate as a PERCENT (8 = 8%). Null if not stated. */
  dividend_rate?: number | null;
  /** True when the preferred participates alongside common after its preference. */
  participating?: boolean | null;
  /** Seniority rank / series label (e.g. "Series A", "Senior"). */
  seniority?: string | null;
  notes?: string | null;
}

/**
 * A single proposed owner / member on the cap table. Dollar amounts are CENTS;
 * fields the source could not determine are null for the human to complete —
 * never guessed.
 */
export interface ProposedOwner {
  /** Legal name of the owner / member / shareholder. */
  name: string;
  /** Ownership as a PERCENT (0..100). Null when the source states units instead. */
  ownership_pct: number | null;
  /** Units / shares held. Null when the source states a percent instead. */
  units: number | null;
  /** Capital contributed to date, in CENTS. Null if not stated. */
  capital_contributed_cents: number | null;
  /** Equity class. */
  equity_class: EquityClass;
  /** True for preferred holders (drives the preferred-terms block). */
  is_preferred: boolean;
  /** Preferred economics, when known. Null for common / when not stated. */
  preferred_terms: PreferredTerms | null;
  /**
   * When this owner is itself ANOTHER company in the tenant (a parent holdco), the
   * `core.locations.id` of that entity. Set only during human review — it is what
   * lets `commit` write the consolidation ownership edge. Null for individuals /
   * external owners.
   */
  owner_entity_id: string | null;
  /** Per-field confidence 0..1 (from the AI; 1 for human/CSV-entered). */
  confidence: Record<string, number>;
  /** Fields left blank or low-confidence — the human should look at these. */
  lowConfidenceFields: string[];
}

/** A proposed cap table for one entity, before human confirmation. */
export interface ProposedCapTable {
  entityForm: EntityForm;
  ownershipBasis: OwnershipBasis;
  owners: ProposedOwner[];
  /** A short verbatim excerpt for traceability (parse path). */
  snippet: string | null;
  /** Anything unusual the source surfaced (multiple classes, illegible, draft). */
  documentNote: string | null;
}

/** The result of checking that ownership foots to ~100%. */
export interface OwnershipSumCheck {
  basis: OwnershipBasis;
  /** Effective ownership % per owner (derived from units when basis is UNITS). */
  effectivePercents: number[];
  /** Sum of the effective percents. */
  totalPct: number;
  /** Signed distance from 100 (positive = over-allocated). */
  varianceFromHundred: number;
  /** Sum of units across owners (0 when basis is PERCENT). */
  unitsTotal: number;
  /** True when the total is within tolerance of 100%. */
  withinTolerance: boolean;
}

/** The result of reconciling per-owner capital to the opening-TB equity accounts. */
export interface OpeningCapitalReconcile {
  /** Σ of the owners' stated capital contributions (cents). */
  holderCapitalCents: number;
  /** The opening-TB equity balance we reconcile against (cents), or null if unknown. */
  openingEquityCents: number | null;
  /** openingEquityCents − holderCapitalCents (cents). Null when opening is unknown. */
  varianceCents: number | null;
  /** True when the variance is within tolerance (or when there is nothing to check). */
  tied: boolean;
  /** True when NO owner stated capital, so there is nothing to reconcile. */
  noCapitalStated: boolean;
}
