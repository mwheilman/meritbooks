/**
 * Plain-English money + date formatting for the migration slice (integer math only —
 * never floats on money). Shared by the preflight library, the certificate and the UI.
 */

/** "$1,234.56" from integer cents; negatives "-$1,234.56". */
export function dollars(cents: number): string {
  const c = Math.trunc(Number.isFinite(cents) ? cents : 0);
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${c < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Whole dollars, half-up ("$113,717") — for tower subtotals (spec AC-26). */
export function wholeDollars(cents: number): string {
  const c = Math.trunc(Number.isFinite(cents) ? cents : 0);
  const abs = Math.abs(c);
  const rounded = Math.floor((abs + 50) / 100);
  return `${c < 0 ? '-' : ''}$${rounded.toLocaleString('en-US')}`;
}

/** "Sep 30, 2026" from an ISO date (no timezone drift). */
export function longDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return 'Not set';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

/** The day after an ISO date ("MeritBooks takes over Oct 1"). */
export function dayAfter(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  const pa = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const pb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((pb - pa) / 86_400_000);
}

/** "1 account" / "3 accounts". */
export function plural(n: number, one: string, many?: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : (many ?? `${one}s`)}`;
}
