/**
 * Push registration and handling on the phone (Expo push tokens → Merit Projects
 * POST /api/notifications/devices; tap → the matching screen).
 *
 * Needs the `expo-notifications` package (and its config plugin in app.json) plus an EAS project
 * id (`eas init`). The module is loaded lazily so the rest of the app — and the unit tests — run
 * without it; until it is installed, registration reports 'unavailable' and nothing else changes.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getJson, setJson } from '@/lib/kv';
import { PROJECTS_API, type TokenGetter } from '@/lib/api';
import { isExpoPushToken, isRegistration, needsRegistration, platformOf, shouldAskPermission, type PermissionState } from './core';

/** The subset of expo-notifications this app uses (typed here so the app compiles without it). */
export interface NotificationsModule {
  getPermissionsAsync(): Promise<{ status: PermissionState; canAskAgain: boolean }>;
  requestPermissionsAsync(): Promise<{ status: PermissionState; canAskAgain: boolean }>;
  getExpoPushTokenAsync(o: { projectId: string }): Promise<{ data: string }>;
  setNotificationHandler(h: { handleNotification: () => Promise<{ shouldShowBanner: boolean; shouldShowList: boolean; shouldPlaySound: boolean; shouldSetBadge: boolean }> } | null): void;
  addNotificationResponseReceivedListener(cb: (r: NotificationResponse) => void): { remove(): void };
  getLastNotificationResponseAsync(): Promise<NotificationResponse | null>;
  setNotificationChannelAsync(id: string, c: { name: string; importance: number }): Promise<unknown>;
  AndroidImportance: { HIGH: number };
}

export interface NotificationResponse {
  notification: { request: { identifier: string; content: { data: unknown } } };
}

let loaded: NotificationsModule | null | undefined;

export function notificationsModule(): NotificationsModule | null {
  if (loaded !== undefined) return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('expo-notifications') as NotificationsModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

const KEY = 'push.registration';

function projectId(): string | null {
  const c = Constants as unknown as { expoConfig?: { extra?: { eas?: { projectId?: string } } }; easConfig?: { projectId?: string } };
  return c.expoConfig?.extra?.eas?.projectId ?? c.easConfig?.projectId ?? null;
}

export type RegisterResult =
  | { state: 'registered'; token: string }
  | { state: 'unchanged'; token: string }
  | { state: 'denied' }
  | { state: 'unavailable'; reason: string }
  | { state: 'failed'; reason: string };

/** Show pushes while the app is open, and the Android channel the server's messages use. */
export async function configureForeground(): Promise<void> {
  const N = notificationsModule();
  if (!N) return;
  N.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
  if (Platform.OS === 'android') {
    await N.setNotificationChannelAsync('default', { name: 'Work updates', importance: N.AndroidImportance.HIGH }).catch(() => undefined);
  }
}

/**
 * Ask (once), get the Expo token, and tell Merit Projects which seat it belongs to. Safe to call
 * on every sign-in / app start: it only re-registers when the token or the person changed, or
 * weekly.
 */
export async function registerForPush(getToken: TokenGetter, userId: string, opts: { ask?: boolean } = {}): Promise<RegisterResult> {
  const N = notificationsModule();
  if (!N) return { state: 'unavailable', reason: 'expo-notifications is not installed in this build.' };
  if (Platform.OS === 'web') return { state: 'unavailable', reason: 'Push needs the phone app.' };
  const pid = projectId();
  if (!pid) return { state: 'unavailable', reason: 'No EAS project id (run eas init).' };
  if (!PROJECTS_API) return { state: 'unavailable', reason: 'EXPO_PUBLIC_PROJECTS_API is not set.' };
  try {
    let perm = await N.getPermissionsAsync();
    if (perm.status !== 'granted' && (opts.ask ?? true) && shouldAskPermission(perm.status, perm.canAskAgain)) perm = await N.requestPermissionsAsync();
    if (perm.status !== 'granted') return { state: 'denied' };
    const token = (await N.getExpoPushTokenAsync({ projectId: pid })).data;
    if (!isExpoPushToken(token)) return { state: 'failed', reason: 'The phone returned an unexpected push token.' };
    const last = await getJson(KEY, isRegistration);
    if (!needsRegistration(last?.value ?? null, token, userId, Date.now())) return { state: 'unchanged', token };
    const bearer = await getToken();
    if (!bearer) return { state: 'failed', reason: 'Sign in again.' };
    const res = await fetch(`${PROJECTS_API}/api/notifications/devices`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        token, platform: platformOf(Platform.OS), deviceName: (Constants as unknown as { deviceName?: string }).deviceName ?? null,
        appVersion: Constants.expoConfig?.version ?? null,
      }),
    });
    if (!res.ok) return { state: 'failed', reason: `The office did not accept this phone (${res.status}).` };
    await setJson(KEY, { token, userId, at: Date.now() });
    return { state: 'registered', token };
  } catch (e) {
    return { state: 'failed', reason: e instanceof Error ? e.message : 'Push registration failed.' };
  }
}

/** On sign-out: stop pushes to this phone for that person (best effort, before the session ends). */
export async function unregisterPush(getToken: TokenGetter): Promise<void> {
  const last = await getJson(KEY, isRegistration);
  if (!last || !PROJECTS_API) return;
  const bearer = await getToken().catch(() => null);
  if (bearer) {
    await fetch(`${PROJECTS_API}/api/notifications/devices`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: last.value.token }),
    }).catch(() => undefined);
  }
  await setJson(KEY, null).catch(() => undefined);
}
