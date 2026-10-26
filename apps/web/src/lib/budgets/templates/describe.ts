/**
 * Plain-English descriptions of a template line (PURE). The Templates tab shows how each line
 * picks its account and what its default driver assumes — in words an owner or department head
 * reads, never the raw safe-pattern syntax (`salar|wage`, `workers*comp`, see ./pattern.ts).
 *
 * The wording mirrors the matcher in ./resolve.ts exactly: types (and sub-types) gate, a name
 * match beats a group match, an excluded word removes the account, and a line with neither a
 * name nor a group pattern takes any account of its type.
 */
import type { TemplateLine } from '../types';

type AcctType = TemplateLine['selector']['types'][number];

const TYPE_WORDS: Record<AcctType, string> = {
  REVENUE: 'revenue',
  COGS: 'cost of sales',
  OPEX: 'operating expense',
  OTHER: 'other income or expense',
};

/** "a", "a or b", "a, b or c". */
export function orList(items: readonly string[], joiner = 'or'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]}`;
}

/** One safe-pattern alternative in words: `workers*comp` → “workers … comp”. */
function altWords(alt: string): string | null {
  const pieces = alt.split('*').map((p) => p.trim()).filter((p) => p.length > 0);
  if (pieces.length === 0) return null;
  return `“${pieces.join(' … ')}”`;
}

/** A safe pattern in words: `salar|wage` → “salar” or “wage”. Empty / blank → null. */
export function patternWords(src: string | undefined, joiner = 'or'): string | null {
  if (!src || !src.trim()) return null;
  const words = src.split('|').map(altWords).filter((w): w is string => w !== null);
  return words.length ? orList(words, joiner) : null;
}

function subTypeWord(s: string): string {
  return s.toLowerCase().replace(/_/g, ' ');
}

/**
 * How the line picks its account, e.g.
 *   "Operating expense accounts whose name mentions “salar” or “wage” — except names mentioning “payable” or “accrued”"
 *   "Any revenue account — except names mentioning “interdep”, “intercompany” or “elimin”"
 */
export function describeSelector(line: Pick<TemplateLine, 'selector'>): string {
  const sel = line.selector;
  const types = sel.types.length ? orList(sel.types.map((t) => TYPE_WORDS[t] ?? t.toLowerCase())) : 'any';
  const subs = sel.subTypes && sel.subTypes.length ? ` (${orList(sel.subTypes.map(subTypeWord))} only)` : '';
  const name = patternWords(sel.name);
  const group = patternWords(sel.group);
  const not = patternWords(sel.notName);

  let base: string;
  if (!name && !group) base = `Any ${types} account${subs}`;
  else {
    const head = `${types.charAt(0).toUpperCase()}${types.slice(1)} accounts${subs}`;
    if (name && group) base = `${head} whose name mentions ${name}, or in a group mentioning ${group}`;
    else if (name) base = `${head} whose name mentions ${name}`;
    else base = `${head} in a group mentioning ${group}`;
  }
  return not ? `${base} — except names mentioning ${not}` : base;
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

function dollars(cents: number): string {
  const neg = cents < 0;
  const v = Math.abs(cents) / 100;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  return `${neg ? '−' : ''}$${s}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The driver's default assumptions in words ("growth 4%", "15% of revenue",
 * "1 person × $0 a month + 15% burden, from Jan"). Unknown keys fall back to "key value" so a
 * tenant-added parameter is never hidden. Empty when the line has no parameters.
 */
export function describeParams(line: Pick<TemplateLine, 'params'>): string {
  const p = { ...line.params };
  const out: string[] = [];
  const take = (k: string): number | undefined => {
    const v = p[k];
    delete p[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };

  const headcount = take('headcount');
  const rate = take('monthlyRateCents');
  const burden = take('burdenBps');
  const start = take('startMonth');
  if (headcount !== undefined || rate !== undefined) {
    const people = headcount !== undefined ? `${headcount} ${headcount === 1 ? 'person' : 'people'}` : 'Headcount';
    let s = `${people} × ${rate !== undefined && rate > 0 ? `${dollars(rate)} a month` : 'monthly rate (set it)'}`;
    if (burden !== undefined && burden > 0) s += ` + ${pct(burden)} burden`;
    out.push(s);
  } else if (burden !== undefined) out.push(`${pct(burden)} burden`);
  if (start !== undefined && start >= 1 && start <= 12) out.push(`from ${MONTHS[start - 1]}`);

  const units = take('unitsPerMonth');
  const unitRate = take('rateCents');
  if (units !== undefined || unitRate !== undefined) {
    out.push(`${units !== undefined && units > 0 ? units.toLocaleString('en-US') : 'Units (set them)'} a month × ${unitRate !== undefined && unitRate > 0 ? dollars(unitRate) : 'rate (set it)'}`);
  }

  const growth = take('growthBps');
  if (growth !== undefined) out.push(growth === 0 ? 'no growth' : `${growth > 0 ? 'growth' : 'decline'} ${pct(Math.abs(growth))}`);
  const share = take('pctBps');
  if (share !== undefined) out.push(`${pct(share)} of revenue`);
  const monthly = take('monthlyCents');
  if (monthly !== undefined) out.push(monthly > 0 ? `${dollars(monthly)} a month` : 'monthly amount (set it)');
  const annual = take('annualCents');
  if (annual !== undefined) out.push(annual > 0 ? `${dollars(annual)} a year` : 'annual amount (set it)');

  for (const [k, v] of Object.entries(p)) out.push(`${k} ${v}`);
  return out.join(', ');
}
