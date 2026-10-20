/**
 * Integer-exact money helpers for the commission engine. BigInt is used for the
 * intermediate products (cents × bps can exceed 2^53 on large jobs), results are
 * returned as safe integers. Rounding is half away from zero, applied ONCE per
 * computed amount so statements foot to the cent.
 */

const BPS_DENOM = 10_000n;

function assertInt(n: number, label: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} must be a safe integer (got ${n})`);
}

/** round(numerator / denominator), half away from zero, BigInt in → number out. */
function divRound(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) throw new RangeError('division by zero');
  const neg = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  const out = Number(neg ? -rounded : rounded);
  if (!Number.isSafeInteger(out)) throw new RangeError('result exceeds safe integer range');
  return out;
}

/** cents × bps / 10_000, rounded. `applyBps(10_000, 500)` → 500 (5% of $100). */
export function applyBps(cents: number, bps: number): number {
  assertInt(cents, 'cents');
  assertInt(bps, 'bps');
  return divRound(BigInt(cents) * BigInt(bps), BPS_DENOM);
}

/** cents × numerator / denominator, rounded (pro-rating by a ratio of integers). */
export function prorate(cents: number, numerator: number, denominator: number): number {
  assertInt(cents, 'cents');
  assertInt(numerator, 'numerator');
  assertInt(denominator, 'denominator');
  if (denominator === 0) return 0;
  return divRound(BigInt(cents) * BigInt(numerator), BigInt(denominator));
}

/**
 * Split `totalCents` across weights so the parts sum EXACTLY to the total
 * (largest-remainder method; ties broken by index for determinism). Used to
 * allocate a tiered period total back to the source lines for audit.
 */
export function allocateByWeights(totalCents: number, weights: number[]): number[] {
  assertInt(totalCents, 'totalCents');
  const w = weights.map((x) => (Number.isSafeInteger(x) && x > 0 ? BigInt(x) : 0n));
  const sumW = w.reduce((s, x) => s + x, 0n);
  if (sumW === 0n || weights.length === 0) return weights.map(() => 0);
  const total = BigInt(totalCents);
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const floors = w.map((x) => (abs * x) / sumW);
  const remainders = w.map((x, i) => ({ i, r: (abs * x) % sumW }));
  let leftover = abs - floors.reduce((s, x) => s + x, 0n);
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of remainders) {
    if (leftover <= 0n) break;
    floors[i] += 1n;
    leftover -= 1n;
  }
  return floors.map((x) => Number(x * sign));
}

/** Whole days from ISO date a to ISO date b (b − a). Dates only, UTC, no clock. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** ISO date + n days. */
export function addDays(iso: string, n: number): string {
  const d = new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}
