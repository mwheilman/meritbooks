import { describe, expect, it } from 'vitest';
import { isExpoPushToken, isRegistration, needsRegistration, parsePushData, platformOf, routeForUrl, shouldAskPermission } from './core';

const J = '00000000-0000-4000-8000-000000000001';
const T = 'ExponentPushToken[abcdefghijk123]';

describe('push deep links → screens', () => {
  it('maps record paths from Merit Projects', () => {
    expect(routeForUrl(`/jobs/${J}`)).toEqual({ route: '/', params: { job: J } });
    expect(routeForUrl('/punch-list')).toEqual({ route: '/punch', params: {} });
    expect(routeForUrl('/time?week=1')).toEqual({ route: '/(tabs)/crew', params: {} });
    expect(routeForUrl('/review')).toEqual({ route: '/(tabs)/crew', params: {} });
    expect(routeForUrl('/inbox')).toEqual({ route: '/inbox', params: {} });
    expect(routeForUrl('/approvals?tab=mine')).toEqual({ route: '/(tabs)/crew', params: {} });
    expect(routeForUrl(`/jobs/${J}/drawings`)).toEqual({ route: '/drawings', params: { jobId: J } });
    expect(routeForUrl('/flooring/pay')).toEqual({ route: '/pay', params: {} });
    expect(routeForUrl('/dealer/tech')).toEqual({ route: '/ro', params: {} });
  });
  it('anything else, or anything unsafe, opens Today', () => {
    for (const u of ['/leads/x', '/jobs/not-a-uuid', '//evil.test/x', 'https://evil.test', null, 42]) expect(routeForUrl(u).route).toBe('/');
  });
  it('reads the push payload defensively', () => {
    expect(parsePushData({ url: '/time', notificationId: 'n1', event: 'time.submitted', extra: 1 })).toEqual({ url: '/time', notificationId: 'n1', event: 'time.submitted' });
    expect(parsePushData({ deepLink: '/punch-list' }).url).toBe('/punch-list');
    expect(parsePushData(null)).toEqual({ url: null, notificationId: null, event: null });
  });
});

describe('token registration', () => {
  it('registers when new, when the token or the person changed, and weekly', () => {
    const now = Date.UTC(2026, 9, 24);
    expect(needsRegistration(null, T, 'u1', now)).toBe(true);
    const last = { token: T, userId: 'u1', at: now - 86_400_000 };
    expect(needsRegistration(last, T, 'u1', now)).toBe(false);
    expect(needsRegistration(last, 'ExponentPushToken[zzzzzzzzzz]', 'u1', now)).toBe(true);
    expect(needsRegistration(last, T, 'u2', now)).toBe(true);
    expect(needsRegistration({ ...last, at: now - 8 * 86_400_000 }, T, 'u1', now)).toBe(true);
    expect(isRegistration(last)).toBe(true);
    expect(isRegistration({ token: 'x', userId: 'u', at: 1 })).toBe(false);
  });
  it('asks for permission only when it has never been answered', () => {
    expect(shouldAskPermission('undetermined', true)).toBe(true);
    expect(shouldAskPermission('denied', true)).toBe(false);
    expect(shouldAskPermission('undetermined', false)).toBe(false);
  });
  it('token shape and platform', () => {
    expect(isExpoPushToken(T)).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[short]')).toBe(false);
    expect(platformOf('ios')).toBe('ios');
    expect(platformOf('android')).toBe('android');
    expect(platformOf('windows')).toBe('web');
  });
});
