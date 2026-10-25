/**
 * SSR smoke for the notification UI: the bell (empty / unread / needs-you badge), the inbox
 * (populated, grouped by job; empty; error), the preferences matrix (mandatory locked) and the
 * company messaging screen (held queue, go-live state). merit-ui asserts banned copy in dev.
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/inbox',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { NotificationBell } from '@/components/notifications/NotificationBell';
import { InboxView } from '@/components/notifications/InboxView';
import { PreferencesForm } from '@/components/notifications/PreferencesForm';
import { CompanyMessaging } from '@/components/notifications/CompanyMessaging';
import type { InboxItem, NotificationPrefs } from '@/lib/notify/types';

const wrap = (el: ReactElement) => renderToString(<MeritProvider>{el}</MeritProvider>);
const C = '11111111-1111-4111-8111-111111111111';

const it1 = (o: Partial<InboxItem>): InboxItem => ({
  id: o.id ?? 'n1', kind: 'task.assigned', eventType: 'task.assigned', sourceApp: o.sourceApp ?? 'projects', severity: o.severity ?? 'info',
  title: o.title ?? 'New task: Hang doors', body: o.body ?? 'J-1001 Smith kitchen', deepLink: '/jobs/j1', jobId: o.jobId ?? 'j1', jobLabel: o.jobLabel ?? 'J-1001 Smith kitchen',
  subjectType: 'task', subjectId: null, itemCount: o.itemCount ?? 1, delivery: o.delivery ?? 'instant', readAt: o.readAt ?? null, doneAt: null,
  createdAt: '2026-10-24T12:00:00Z', updatedAt: '2026-10-24T12:00:00Z',
});

describe('bell', () => {
  it('shows the unread count in its label', () => {
    const html = wrap(<NotificationBell initial={{ unread: 3, needsYou: 1, items: [it1({}), it1({ id: 'n2', severity: 'attention', title: 'Approval needed' })] }} />);
    expect(html).toContain('Notifications, 3 unread');
    expect(html).toContain('>3<');
  });
  it('no badge when caught up', () => {
    const html = wrap(<NotificationBell initial={{ unread: 0, needsYou: 0, items: [] }} />);
    expect(html).toContain('aria-label="Notifications"');
  });
});

describe('inbox', () => {
  it('populated: grouped by job, batched count, Books tag, digest tag', () => {
    const html = wrap(
      <InboxView
        initialFilter="all"
        initial={{
          unread: 2, nextBefore: '2026-10-20T00:00:00Z',
          items: [it1({}), it1({ id: 'n2', title: 'Time to approve on J-1001', itemCount: 3, delivery: 'digest' }), it1({ id: 'n3', jobId: null, jobLabel: null, sourceApp: 'books', title: 'Invoice INV-77 paid', readAt: '2026-10-24T12:00:00Z' })],
        }}
      />,
    );
    expect(html).toContain('J-1001 Smith kitchen');
    expect(html).toContain('3 updates');
    expect(html).toContain('Digest');
    expect(html).toContain('Books');
    expect(html).toContain('Show older');
  });
  it('empty and error states', () => {
    expect(wrap(<InboxView initialFilter="unread" initial={{ unread: 0, nextBefore: null, items: [] }} />)).toContain('You are caught up');
    expect(wrap(<InboxView initialFilter="unread" initial={null} initialError="boom" />)).toContain('The inbox did not load');
  });
});

describe('preferences', () => {
  const prefs: NotificationPrefs = {
    persona: 'projects_supervisor', digest: 'instant', quietStart: '21:00:00', quietEnd: '06:30:00', timezone: 'America/Chicago', smsPhone: null,
    smsConsent: null, emailOn: true, muted: ['punch.assigned'], rules: [{ event_type: 'task.assigned', channel: 'push', mode: 'off' }],
    mandatoryEvents: ['approval.requested'], pushDevices: 0, smsAvailable: false,
  };
  it('renders the matrix with required / muted tags and the role defaults', () => {
    const html = wrap(<PreferencesForm initial={prefs} roleTitle="Superintendent" />);
    expect(html).toContain('defaults for Superintendent');
    expect(html).toContain('Required');
    expect(html).toContain('Muted in Merit Books');
    expect(html).toContain('Sign in on your phone');
    expect(html).toContain('Role: on');
  });
});

describe('company messages', () => {
  it('held queue and go-live state', () => {
    const html = wrap(
      <CompanyMessaging
        companyNames={{ [C]: 'Dorrian HVAC' }}
        providers={{ email: true, sms: false, push: false }}
        settings={[{ companyId: C, customerMessagesLive: false, liveAt: null, liveBy: null, smsEnabled: false, smsFromNumber: null, mandatoryEvents: [], pushPerHour: 6, smsPerDay: 3, emailPerHour: 12, customerSmsPerDay: 2, leadSlaMinutes: 60, quietStart: null, quietEnd: null, timezone: null }]}
        held={[{ id: 'h1', companyId: C, channel: 'email', eventType: 'customer.on_my_way', toAddress: 'pat@example.test', subject: 'On the way', body: 'Your installer is 20 minutes out.', bodyMasked: false, statusReason: 'Customer messages are held until this company goes live', jobId: null, createdAt: '2026-10-24T12:00:00Z' }]}
      />,
    );
    expect(html).toContain('Customer messages held');
    expect(html).toContain('Go live for customers');
    expect(html).toContain('pat@example.test');
    expect(html).toContain('Texting is not connected yet');
  });
});
