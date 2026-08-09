/**
 * 1099 BOX CLASSIFICATION — deterministic, ledger-sourced mapping of a vendor's
 * reportable payments to the correct information return + box.
 *
 * The whole point of doing 1099s off the OWNED general ledger (rather than a
 * spreadsheet) is that we already know which GL expense account each dollar was
 * coded to. That account tells us the RETURN: services land on 1099-NEC Box 1
 * (nonemployee compensation), but rent lands on 1099-MISC Box 1, royalties on
 * MISC Box 2, medical / health-care payments on MISC Box 6, and attorney gross
 * proceeds on MISC Box 10 — issuing a NEC for those would be the wrong form.
 *
 * This module is PURE: a function of the account's number + name only. No I/O, no
 * clock, no randomness — so it is unit-testable without a DB and renders identical
 * classifications every run. It is intentionally conservative: anything it can't
 * confidently place as MISC defaults to NEC Box 1 (the dominant AP case), which a
 * CPA can always override by re-coding the underlying expense.
 */

export type Form1099Type = 'NEC' | 'MISC';

/** Stable box codes we classify into. `<FORM>_<BOX>`. */
export type Box1099Code = 'NEC_1' | 'MISC_1' | 'MISC_2' | 'MISC_3' | 'MISC_6' | 'MISC_10';

export interface BoxMeta {
  code: Box1099Code;
  form: Form1099Type;
  /** IRS box number as printed on the form. */
  box: string;
  /** Full IRS box label. */
  label: string;
  /** Compact label for dense UI (e.g. table chips). */
  short: string;
}

export const BOX_META: Record<Box1099Code, BoxMeta> = {
  NEC_1: { code: 'NEC_1', form: 'NEC', box: '1', label: 'Nonemployee compensation', short: 'NEC 1 · Services' },
  MISC_1: { code: 'MISC_1', form: 'MISC', box: '1', label: 'Rents', short: 'MISC 1 · Rents' },
  MISC_2: { code: 'MISC_2', form: 'MISC', box: '2', label: 'Royalties', short: 'MISC 2 · Royalties' },
  MISC_3: { code: 'MISC_3', form: 'MISC', box: '3', label: 'Other income', short: 'MISC 3 · Other' },
  MISC_6: {
    code: 'MISC_6',
    form: 'MISC',
    box: '6',
    label: 'Medical and health care payments',
    short: 'MISC 6 · Medical',
  },
  MISC_10: {
    code: 'MISC_10',
    form: 'MISC',
    box: '10',
    label: 'Gross proceeds paid to an attorney',
    short: 'MISC 10 · Attorney',
  },
};

export const NEC_BOX: Box1099Code = 'NEC_1';

/**
 * Classify a single GL expense account into a 1099 box. Order matters — the most
 * specific MISC signals are checked first; everything else falls through to NEC.
 *
 * Deliberate carve-outs:
 *   - "release" must NOT match "lease"; "leasehold improvement" is a capital cost
 *     (a build-out paid to a contractor → still NEC services), so we match `lease`
 *     only as a whole word.
 *   - Attorney *fees for services* are NEC Box 1; only attorney GROSS PROCEEDS
 *     (settlements) belong in MISC Box 10 — so we route on "settlement" / "gross
 *     proceeds", never on the bare word "legal" / "attorney".
 */
export function classify1099Box(accountNumber: string | null, accountName: string | null): Box1099Code {
  const name = (accountName ?? '').toLowerCase();
  const num = (accountNumber ?? '').trim();

  // Royalties.
  if (/\broyalt/.test(name)) return 'MISC_2';

  // Rents (real property, equipment rental). Whole-word `lease` avoids "release".
  if (/\brent(s|al|als)?\b/.test(name) || /\blease\b/.test(name)) return 'MISC_1';

  // Medical / health care.
  if (/\bmedical\b/.test(name) || /health\s*care|healthcare/.test(name)) return 'MISC_6';

  // Attorney gross proceeds (settlements) — NOT ordinary legal fees.
  if (/settlement/.test(name) || /gross\s+proceeds/.test(name)) return 'MISC_10';

  // Prizes / awards / other income.
  if (/\bprize/.test(name) || /\baward/.test(name) || /other\s+income/.test(name)) return 'MISC_3';

  // Account-number hint: some COAs number rent expense in a dedicated band. We keep
  // this narrow and only as a fallback so it never overrides an explicit name match.
  void num;

  return 'NEC_1';
}

/** Sum a set of `{ box, cents }` weights into a per-box total map. */
export type BoxCents = Partial<Record<Box1099Code, number>>;

/**
 * Apportion `cents` across the boxes present in `weights` (a box→cents map, e.g. a
 * bill's expense-line coding), preserving integer cents exactly. Uses the
 * largest-remainder method so the parts always sum back to `cents`. When `weights`
 * is empty / zero-total, the whole amount defaults to NEC Box 1.
 */
export function apportionCents(cents: number, weights: BoxCents): BoxCents {
  const c = Math.max(0, Math.trunc(Number(cents) || 0));
  if (c === 0) return {};
  const entries = (Object.entries(weights) as [Box1099Code, number][]).filter(([, w]) => (w || 0) > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (entries.length === 0 || total <= 0) return { NEC_1: c };

  // Floor each share, then hand the remainder to the largest fractional parts.
  const raw = entries.map(([box, w]) => {
    const exact = (c * w) / total;
    const floor = Math.floor(exact);
    return { box, floor, frac: exact - floor };
  });
  let assigned = raw.reduce((s, r) => s + r.floor, 0);
  let remainder = c - assigned;
  raw.sort((a, b) => b.frac - a.frac);
  const out: BoxCents = {};
  for (const r of raw) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    out[r.box] = (out[r.box] ?? 0) + r.floor + extra;
    assigned += extra;
  }
  return out;
}

/** Merge box→cents map `b` into accumulator `a` (in place) and return it. */
export function mergeBoxCents(a: BoxCents, b: BoxCents): BoxCents {
  for (const [box, cents] of Object.entries(b) as [Box1099Code, number][]) {
    a[box] = (a[box] ?? 0) + (cents || 0);
  }
  return a;
}
