/**
 * Journal-entry deep links (audit 06 §5 bug 5 / L.2 #5).
 *
 * Callers link to a JE several ways: `?id=` (Explain, most links), `?entry=`
 * (payroll run drawer, search, portfolio tower) and `?highlight=` (internal
 * invoices "View GL"). The list page used to honor only `?id=`, so the others
 * silently landed on the plain list. All three now open the entry drawer;
 * the URL is normalized to the canonical `?id=` form.
 */
export const JE_DEEP_LINK_PARAMS = ['id', 'entry', 'highlight'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The JE id a URL query string points at, or null. Only well-formed UUIDs count. */
export function jeDeepLinkId(search: string | URLSearchParams): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  for (const key of JE_DEEP_LINK_PARAMS) {
    const v = params.get(key)?.trim();
    if (v && UUID_RE.test(v)) return v;
  }
  return null;
}

/**
 * Rewrite a URL so it carries only the canonical `?id=` (or none), dropping the
 * legacy `entry` / `highlight` aliases. Other params are preserved.
 */
export function withCanonicalJeId(href: string, selectedId: string | null): string {
  const url = new URL(href);
  for (const key of JE_DEEP_LINK_PARAMS) url.searchParams.delete(key);
  if (selectedId) url.searchParams.set('id', selectedId);
  return url.toString();
}
