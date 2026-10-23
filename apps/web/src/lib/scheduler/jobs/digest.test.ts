import { describe, it, expect } from 'vitest';
import { digestDue } from './digest';
import { buildDigestEmail } from '@/lib/notify/digest-email';

// Mon 2026-11-02 14:00Z = 08:00 America/Chicago (CST).
const MON_8AM_CT = new Date('2026-11-02T14:00:00Z');
const base = { channels: ['in_app', 'email'], timezone: 'America/Chicago', quietStart: null, quietEnd: null };

describe('digestDue', () => {
  it('daily at 8 a.m. local, weekly only on Mondays', () => {
    expect(digestDue({ ...base, digest: 'daily', now: MON_8AM_CT })).toMatchObject({ due: true, cadence: 'daily' });
    expect(digestDue({ ...base, digest: 'weekly', now: MON_8AM_CT })).toMatchObject({ due: true, cadence: 'weekly' });
    const tue = new Date('2026-11-03T14:00:00Z');
    expect(digestDue({ ...base, digest: 'weekly', now: tue }).due).toBe(false);
    expect(digestDue({ ...base, digest: 'daily', now: tue }).due).toBe(true);
    expect(digestDue({ ...base, digest: 'daily', now: new Date('2026-11-02T15:00:00Z') }).reason).toBe('not the digest hour');
  });
  it('instant / off members, no email channel, and quiet hours get nothing', () => {
    expect(digestDue({ ...base, digest: 'instant', now: MON_8AM_CT }).due).toBe(false);
    expect(digestDue({ ...base, digest: 'off', now: MON_8AM_CT }).due).toBe(false);
    expect(digestDue({ ...base, channels: ['in_app'], digest: 'daily', now: MON_8AM_CT }).reason).toBe('email channel off');
    expect(digestDue({ ...base, quietStart: '20:00', quietEnd: '09:00', digest: 'daily', now: MON_8AM_CT }).reason).toBe('quiet hours');
  });
});

describe('buildDigestEmail', () => {
  it('escapes content, links inside the app only, and counts what it left out', () => {
    const m = buildDigestEmail({
      tenantName: 'Heritage <Interiors>',
      recipientName: 'Mike Heilman',
      cadence: 'daily',
      appUrl: 'https://app.example.com/',
      more: 3,
      items: [
        { title: '2 payment reminders ready', body: 'Review <now>', deepLink: '/requests', severity: 'attention', createdAt: '2026-11-02T10:00:00Z' },
        { title: 'Pay run', body: null, deepLink: '//evil.com', severity: 'info', createdAt: '2026-11-02T09:00:00Z' },
      ],
    });
    expect(m.subject).toBe('Today in Heritage <Interiors>: 5 updates (1 needs you)');
    expect(m.html).toContain('Heritage &lt;Interiors&gt;');
    expect(m.html).toContain('Review &lt;now&gt;');
    expect(m.html).toContain('https://app.example.com/requests');
    expect(m.html).not.toContain('evil.com');
    expect(m.text).toContain('…and 3 more in the app.');
    expect(m.text).toContain('Hi Mike,');
  });
});
