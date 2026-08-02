/**
 * Intangible-asset categories.
 *
 * An intangible is just an amortizable asset, so MeritBooks represents it as a
 * `public.fixed_assets` row — no new table. What distinguishes an intangible from
 * a tangible fixed asset is its `category`: every intangible category is prefixed
 * `INTANGIBLE_` so the register can filter cleanly and the two populations never
 * collide with the tangible categories ('VEHICLE', 'EQUIPMENT', …).
 *
 * Amortization is straight-line by default (the norm for finite-lived intangibles).
 * GOODWILL is the exception: under ASC 350 goodwill (and indefinite-lived
 * intangibles) is NOT amortized — it is tested for impairment. So goodwill assets
 * are created in the register but the amortization runner SKIPS them; their book
 * value only moves on a manual impairment write-down.
 */

/** Canonical intangible category values (stored in `fixed_assets.category`). */
export const INTANGIBLE_CATEGORIES = [
  'INTANGIBLE_SOFTWARE', // capitalized internal-use / purchased software (ASC 350-40)
  'INTANGIBLE_PATENT',
  'INTANGIBLE_TRADEMARK', // finite-lived trademark (indefinite-lived → treat as non-amortizing)
  'INTANGIBLE_COPYRIGHT',
  'INTANGIBLE_LICENSE', // licenses, permits, franchise rights
  'INTANGIBLE_CUSTOMER_LIST', // customer relationships acquired
  'INTANGIBLE_NONCOMPETE', // non-compete agreements
  'INTANGIBLE_GOODWILL', // NON-amortizing — impairment only
  'INTANGIBLE_OTHER',
] as const;

export type IntangibleCategory = (typeof INTANGIBLE_CATEGORIES)[number];

/** Human labels for the UI. */
export const INTANGIBLE_CATEGORY_LABELS: Record<IntangibleCategory, string> = {
  INTANGIBLE_SOFTWARE: 'Software',
  INTANGIBLE_PATENT: 'Patent',
  INTANGIBLE_TRADEMARK: 'Trademark',
  INTANGIBLE_COPYRIGHT: 'Copyright',
  INTANGIBLE_LICENSE: 'License / Franchise',
  INTANGIBLE_CUSTOMER_LIST: 'Customer List',
  INTANGIBLE_NONCOMPETE: 'Non-Compete',
  INTANGIBLE_GOODWILL: 'Goodwill',
  INTANGIBLE_OTHER: 'Other Intangible',
};

/**
 * Categories that are NEVER amortized (impairment-only). Goodwill is the canonical
 * case (ASC 350). Kept as a set so the rule has one home the engine + UI share.
 */
export const NON_AMORTIZING_CATEGORIES: ReadonlySet<string> = new Set<IntangibleCategory>([
  'INTANGIBLE_GOODWILL',
]);

/** True when a stored `category` value denotes an intangible asset. */
export function isIntangibleCategory(category: string | null | undefined): category is IntangibleCategory {
  if (!category) return false;
  return (INTANGIBLE_CATEGORIES as readonly string[]).includes(category) || category.startsWith('INTANGIBLE_');
}

/**
 * True when an intangible is NON-amortizing (goodwill / indefinite-lived). Such
 * assets are excluded from the periodic amortization run and only change value on
 * a manual impairment write-down.
 */
export function isNonAmortizing(category: string | null | undefined): boolean {
  if (!category) return false;
  return NON_AMORTIZING_CATEGORIES.has(category);
}
