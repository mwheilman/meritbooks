/**
 * Push notifications — the pure core (no React Native imports; unit-tested). The server sends
 * through the Expo push service (Merit Projects lib/notify/push.ts) with `data.url` = the record's
 * web path ("/jobs/…", "/punch-list", "/time", "/review", "/leads/…"); this maps it to a screen
 * of this app. The app never shows money, and neither does a push: the server masks per person.
 */

export type AppRoute = '/' | '/punch' | '/(tabs)/crew' | '/(tabs)/clock' | '/(tabs)/log' | '/(tabs)/me' | '/queue' | '/inbox' | '/drawings' | '/pay' | '/ro';

export interface Target {
  route: AppRoute;
  params: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The record path from Merit Projects → a screen here. Unknown paths open Today. */
export function routeForUrl(url: unknown): Target {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return { route: '/', params: {} };
  const [path = '/'] = url.split(/[?#]/);
  const parts = path.split('/').filter(Boolean);
  const head = parts[0] ?? '';
  if (head === 'jobs' && parts[1] && UUID.test(parts[1])) {
    if (parts[2] === 'drawings' || parts[2] === 'documents') return { route: '/drawings', params: { jobId: parts[1] } };
    return { route: '/', params: { job: parts[1] } };
  }
  if (head === 'approvals') return { route: '/(tabs)/crew', params: {} };
  if (head === 'flooring' && parts[1] === 'pay') return { route: '/pay', params: {} };
  if (head === 'dealer' && (parts[1] === 'tech' || parts[1] === 'ro')) return { route: '/ro', params: {} };
  if (head === 'punch-list') return { route: '/punch', params: {} };
  if (head === 'time' || head === 'review') return { route: '/(tabs)/crew', params: {} };
  if (head === 'daily-logs') return { route: '/(tabs)/log', params: {} };
  if (head === 'inbox') return { route: '/inbox', params: {} };
  if (head === 'me') return { route: '/(tabs)/me', params: {} };
  return { route: '/', params: {} };
}

export interface PushData {
  url: string | null;
  notificationId: string | null;
  event: string | null;
}

export function parsePushData(data: unknown): PushData {
  const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const s = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 500 ? v : null);
  return { url: s(d.url) ?? s(d.deepLink), notificationId: s(d.notificationId), event: s(d.event) };
}

export function isExpoPushToken(t: unknown): t is string {
  return typeof t === 'string' && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/.test(t);
}

export interface Registration {
  token: string;
  /** Clerk user the token was registered for (a phone can change hands). */
  userId: string;
  at: number;
}

export function isRegistration(v: unknown): v is Registration {
  return typeof v === 'object' && v !== null && isExpoPushToken((v as Registration).token)
    && typeof (v as Registration).userId === 'string' && typeof (v as Registration).at === 'number';
}

const WEEK = 7 * 86_400_000;

/** Re-register when the token or the person changed, or weekly (keeps last_seen fresh server-side). */
export function needsRegistration(last: Registration | null, token: string, userId: string, now: number): boolean {
  if (!last) return true;
  return last.token !== token || last.userId !== userId || now - last.at > WEEK;
}

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/** Ask once, politely: never re-prompt after a denial (the OS would ignore it anyway). */
export function shouldAskPermission(state: PermissionState, canAskAgain: boolean): boolean {
  return state === 'undetermined' && canAskAgain;
}

export function platformOf(os: string): 'ios' | 'android' | 'web' {
  return os === 'ios' ? 'ios' : os === 'android' ? 'android' : 'web';
}
