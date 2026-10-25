/**
 * Mount once inside the signed-in tree (e.g. AppProvider or the (tabs) layout):
 *
 *   usePushNotifications({ getToken, userId });
 *
 * Registers this phone for pushes after sign-in, shows pushes while the app is open, and opens
 * the matching screen when a push is tapped (also when the tap launched the app).
 */
import { useEffect, useRef } from 'react';
import { router, type Href } from 'expo-router';
import type { TokenGetter } from '@/lib/api';
import { parsePushData, routeForUrl } from './core';
import { configureForeground, notificationsModule, registerForPush, type NotificationResponse, type RegisterResult } from './push';

export interface UsePushOptions {
  getToken: TokenGetter;
  /** Clerk user id; null while signed out. */
  userId: string | null;
  onRegistered?: (r: RegisterResult) => void;
}

function openFrom(response: NotificationResponse | null, seen: Set<string>): void {
  if (!response) return;
  const id = response.notification.request.identifier;
  if (seen.has(id)) return;
  seen.add(id);
  const { url } = parsePushData(response.notification.request.content.data);
  const t = routeForUrl(url);
  router.push({ pathname: t.route, params: t.params } as unknown as Href);
}

export function usePushNotifications({ getToken, userId, onRegistered }: UsePushOptions): void {
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    void configureForeground();
    void registerForPush((o) => tokenRef.current(o), userId).then((r) => {
      if (!cancelled) onRegistered?.(r);
    });
    const N = notificationsModule();
    if (!N) return () => { cancelled = true; };
    void N.getLastNotificationResponseAsync().then((r) => openFrom(r, seen.current)).catch(() => undefined);
    const sub = N.addNotificationResponseReceivedListener((r) => openFrom(r, seen.current));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [userId, onRegistered]);
}
