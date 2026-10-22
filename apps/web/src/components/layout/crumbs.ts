/**
 * Default breadcrumbs for the bar, from the pathname (pure). The last crumb is the
 * page. A route that matches a rail item uses the rail's label; deeper routes add
 * one crumb for the sub-page (record pages set their own via the shell context).
 */
import { activeHref, type Crumb } from '@meritbooks/merit-ui';
import { navigation } from '@/lib/navigation';

const ALL_ITEMS = navigation.flatMap((g) => g.items);
const LOOKS_LIKE_ID = /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d+|[A-Z0-9_-]{10,})$/i;

function humanize(seg: string): string {
  const s = decodeURIComponent(seg).replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function crumbsFor(pathname: string): Crumb[] {
  const path = (pathname.split(/[?#]/)[0] || '/').replace(/\/+$/, '') || '/';
  const href = activeHref([{ items: ALL_ITEMS }], path);
  const item = href ? ALL_ITEMS.find((i) => i.href === href) : undefined;
  if (item && path === item.href) return [{ label: item.label }];
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return [{ label: 'Home' }];
  const last = parts[parts.length - 1] ?? '';
  const leaf = LOOKS_LIKE_ID.test(last) ? 'Detail' : humanize(last);
  if (item) return [{ label: item.label, href: item.href }, { label: leaf }];
  if (parts.length === 1) return [{ label: humanize(parts[0] ?? '') }];
  return [{ label: humanize(parts[0] ?? ''), href: `/${parts[0]}` }, { label: leaf }];
}
