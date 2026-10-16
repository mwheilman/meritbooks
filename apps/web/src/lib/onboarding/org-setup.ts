/**
 * Pure helpers for organization setup (/setup + /api/setup). No I/O — unit-tested.
 */

/** Derive a URL-safe org slug from a name: lowercase, dash-separated, 2–50 chars. */
export function deriveOrgSlug(source: string, suffix: string | null = null): string {
  const base = source
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const tail = suffix ? `-${suffix.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
  const room = Math.max(1, 50 - tail.length);
  let core = base.slice(0, room).replace(/-+$/g, '');
  if (core.length < 2) core = core ? `${core}-org` : 'org';
  return `${core}${tail}`.slice(0, 50);
}

/** True when `tz` is an IANA zone this runtime understands. */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Split "Jane Q. Doe" into first ("Jane") and last ("Q. Doe"). Total. */
export function splitFullName(full: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** The last calendar day of the month before `now`, as YYYY-MM-DD (local date parts). */
export function lastDayOfPreviousMonth(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), 0);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
