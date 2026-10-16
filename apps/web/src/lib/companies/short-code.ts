/**
 * Company short codes — pure helpers (no I/O; safe in client and server bundles).
 *
 * A short code is the compact company tag shown in pickers, reports and entry
 * numbers: uppercase A–Z / 0–9, 1–10 characters, unique within a tenant
 * (`core.locations` unique (org_id, short_code)).
 */

export const SHORT_CODE_MAX = 10;
export const SHORT_CODE_RE = /^[A-Z0-9]{1,10}$/;

/**
 * Words that carry no identity in a company name: legal-form suffixes and filler.
 * Dropped before deriving initials so "Swan Creek Construction, LLC" → "SCC",
 * not "SCCL". If a name is ONLY these words ("The Company"), they are kept.
 */
const NOISE_WORDS = new Set([
  'THE', 'AND', 'OF', 'A', 'AN',
  'LLC', 'L', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY',
  'LTD', 'LIMITED', 'LP', 'LLP', 'LLLP', 'PLLC', 'PC', 'PLC', 'PA', 'GMBH',
]);

/** Uppercase, strip accents, split into A–Z/0–9 words. */
export function nameWords(name: string): string[] {
  return (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Case/space-insensitive company-name key for duplicate detection. */
export function companyNameKey(name: string): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Normalize a user-typed code to the stored form (uppercased, invalid chars removed). */
export function normalizeShortCode(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, SHORT_CODE_MAX);
}

/** The un-suffixed code a name suggests (before uniqueness is applied). */
export function baseShortCode(name: string): string {
  const words = nameWords(name);
  const meaningful = words.filter((w) => !NOISE_WORDS.has(w));
  const core = meaningful.length > 0 ? meaningful : words;
  if (core.length === 0) return 'CO';
  if (core.length === 1) return core[0].slice(0, 6);
  // Multi-word: initials ("Heartland HVAC" → "HH", "Iowa Custom Cabinetry" → "ICC").
  return core.map((w) => w[0]).join('').slice(0, SHORT_CODE_MAX);
}

/**
 * Derive a short code from a company name that is unique against `taken`
 * (compared case-insensitively). Collisions get a numeric suffix, trimming the
 * base so the result never exceeds 10 characters: SCC → SCC2 → SCC3 …
 */
export function deriveShortCode(name: string, taken: Set<string>): string {
  const takenUpper = new Set(Array.from(taken, (t) => String(t).toUpperCase()));
  const base = baseShortCode(name);
  if (!takenUpper.has(base)) return base;
  for (let n = 2; n < 100000; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, SHORT_CODE_MAX - suffix.length) + suffix;
    if (!takenUpper.has(candidate)) return candidate;
  }
  // Unreachable in practice (would need 100k collisions on one base).
  return `${base.slice(0, 4)}${Date.now().toString(36).toUpperCase()}`.slice(0, SHORT_CODE_MAX);
}

/**
 * Assign short codes to a whole batch at once (bulk create preview). Rows that
 * already carry a valid, non-colliding code keep it; the rest are derived so the
 * batch is unique against the tenant's existing codes AND against itself.
 */
export function assignShortCodes(
  rows: Array<{ name: string; shortCode?: string | null }>,
  existing: Iterable<string>,
): string[] {
  const taken = new Set(Array.from(existing, (c) => c.toUpperCase()));
  // Reserve explicit codes first so a derived code never steals a typed one.
  const explicit = rows.map((r) => normalizeShortCode(r.shortCode));
  const out: string[] = new Array(rows.length).fill('');
  explicit.forEach((code, i) => {
    if (code && SHORT_CODE_RE.test(code) && !taken.has(code)) {
      out[i] = code;
      taken.add(code);
    }
  });
  rows.forEach((r, i) => {
    if (out[i]) return;
    const code = deriveShortCode(r.name, taken);
    out[i] = code;
    taken.add(code);
  });
  return out;
}
