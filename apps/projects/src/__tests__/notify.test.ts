/**
 * Suite notifications (1114) — the app side: recipe matrix + preference precedence (mirror of
 * core.notify_modes), quiet hours (mirror of core.notify_quiet_end), digest grouping and email,
 * inbox grouping, the provider adapters (Resend / Twilio-shaped SMS / Expo push: disabled until
 * credentials exist, never "sent" without an id), STOP keywords, Twilio signatures, the worker
 * loop, request schemas. The database half is packages/projects-access/test/notifications.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  EVENT_INFO, INTERNAL_EVENTS, RECIPE_CODES, RECIPE_PERSONAS, effectiveMode, recipeFor, recipeDefaults,
} from '@/lib/notify/recipes';
import { clockLabel, inQuietHours, quietEnd } from '@/lib/notify/quiet-hours';
import { absoluteLink, buildDigestEmail, buildNotificationEmail, groupDigest, type DigestSourceItem } from '@/lib/notify/digest';
import { ago, groupByRecord, hrefOf, rankForBell } from '@/lib/notify/format';
import { emailConfig, headerSafe, resendSender } from '@/lib/notify/email';
import { checkTwilioNumber, parseSmsKeyword, toE164, twilioSender, twilioSignature, twiml, verifyTwilioSignature } from '@/lib/notify/sms';
import { buildExpoMessages, expoSender, foldTickets, isExpoToken, pushConfig } from '@/lib/notify/push';
import { resultArgs, runNotificationWorker, type ClaimedRow, type DigestRow, type WorkerPort } from '@/lib/notify/dispatch';
import { DeviceBody, MarkBody, PrefsBody, SenderBody, SettingsBody } from '@/lib/notify/schemas';
import type { InboxItem, SendOutcome } from '@/lib/notify/types';

const TOKEN = 'ExponentPushToken[abcdefghijk123]';

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('recipes per role (panel 06 §2e)', () => {
  it('every event has a code for every persona; codes are P / I / D / -', () => {
    for (const e of INTERNAL_EVENTS) {
      expect(RECIPE_CODES[e]).toHaveLength(RECIPE_PERSONAS.length);
      for (const c of RECIPE_CODES[e]) expect(['P', 'I', 'D', '-']).toContain(c);
    }
    expect(recipeDefaults()).toHaveLength(INTERNAL_EVENTS.length * RECIPE_PERSONAS.length);
  });
  it('field roles get push for their own work; office gets inbox + digest; crew never sees contract signings', () => {
    expect(recipeFor('projects_labor', 'task.assigned')).toEqual({ in_app: 'instant', push: 'instant', email: 'off', sms: 'off' });
    expect(recipeFor('projects_supervisor', 'time.submitted').push).toBe('instant');
    expect(recipeFor('projects_owner', 'change_order.signed')).toEqual({ in_app: 'instant', push: 'off', email: 'digest', sms: 'off' });
    expect(recipeFor('projects_labor', 'change_order.signed').in_app).toBe('off');
    expect(recipeFor('projects_dispatcher', 'lead.assigned').push).toBe('instant');
    expect(recipeFor('projects_sales', 'lead.sla_breach').push).toBe('instant');
    expect(recipeFor('projects_pm', 'approval.requested').push).toBe('instant');
    expect(recipeFor('default', 'comment.mention').in_app).toBe('instant');
  });
  it('approval needed is platform-mandatory', () => {
    expect(EVENT_INFO['approval.requested'].mandatory).toBe(true);
    expect(INTERNAL_EVENTS.filter((e) => EVENT_INFO[e].mandatory)[0]).toBe('approval.requested');
    // Wave B (13) and Wave C (7, 1124) internal events are all mandatory (inbox floor)
    expect(INTERNAL_EVENTS.filter((e) => EVENT_INFO[e].mandatory)).toHaveLength(21);
  });
});

describe('preference precedence (mirror of core.notify_modes)', () => {
  const base = { persona: 'projects_labor' as const, rules: [], mandatory: false };
  it('the person overrides the role default; digest only on email', () => {
    expect(effectiveMode({ ...base, event: 'task.assigned', channel: 'push' })).toBe('instant');
    expect(effectiveMode({ ...base, event: 'task.assigned', channel: 'push', rules: [{ event_type: 'task.assigned', channel: 'push', mode: 'off' }] })).toBe('off');
    expect(effectiveMode({ ...base, event: 'task.assigned', channel: 'email', rules: [{ event_type: 'task.assigned', channel: 'email', mode: 'digest' }] })).toBe('digest');
    expect(effectiveMode({ ...base, event: 'task.assigned', channel: 'push', rules: [{ event_type: 'task.assigned', channel: 'push', mode: 'digest' }] })).toBe('off');
  });
  it('mandatory: the inbox copy cannot be turned off; muted and personal rules are ignored', () => {
    const rules = [{ event_type: 'approval.requested' as const, channel: 'in_app' as const, mode: 'off' as const }];
    expect(effectiveMode({ ...base, event: 'approval.requested', channel: 'in_app', rules, mandatory: true, muted: ['approval.requested'] })).toBe('instant');
  });
  it('Books muted kinds silence a non-mandatory event; Books email off and digest off narrow email', () => {
    expect(effectiveMode({ ...base, event: 'punch.assigned', channel: 'in_app', muted: ['punch.assigned'] })).toBe('off');
    const pa = { persona: 'projects_owner' as const, rules: [], mandatory: false, event: 'change_order.signed' as const, channel: 'email' as const };
    expect(effectiveMode(pa)).toBe('digest');
    expect(effectiveMode({ ...pa, emailOn: false })).toBe('off');
    expect(effectiveMode({ ...pa, digest: 'off' })).toBe('off');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('quiet hours (mirror of core.notify_quiet_end)', () => {
  const w = { start: '22:00', end: '07:00' };
  it('overnight window: before and after midnight end at 07:00; outside is untouched', () => {
    expect(quietEnd(new Date('2026-10-24T23:30:00Z'), w, 'UTC').toISOString()).toBe('2026-10-25T07:00:00.000Z');
    expect(quietEnd(new Date('2026-10-25T03:00:00Z'), w, 'UTC').toISOString()).toBe('2026-10-25T07:00:00.000Z');
    const noon = new Date('2026-10-24T12:00:00Z');
    expect(quietEnd(noon, w, 'UTC')).toBe(noon);
    expect(inQuietHours(noon, w, 'UTC')).toBe(false);
  });
  it('same-day window and the recipient\'s time zone (Central, DST)', () => {
    expect(quietEnd(new Date('2026-10-24T13:00:00Z'), { start: '12:00', end: '14:00' }, 'UTC').toISOString()).toBe('2026-10-24T14:00:00.000Z');
    // 23:00 CDT on Oct 24 = 04:00Z Oct 25 → ends 07:00 CDT = 12:00Z
    expect(quietEnd(new Date('2026-10-25T04:00:00Z'), w, 'America/Chicago').toISOString()).toBe('2026-10-25T12:00:00.000Z');
    // after the fall-back (CST, UTC-6): 23:00 CST Nov 2 = 05:00Z Nov 3 → 07:00 CST = 13:00Z
    expect(quietEnd(new Date('2026-11-03T05:00:00Z'), w, 'America/Chicago').toISOString()).toBe('2026-11-03T13:00:00.000Z');
  });
  it('no window, equal ends, unknown zone → safe', () => {
    const at = new Date('2026-10-24T23:30:00Z');
    expect(quietEnd(at, null, 'UTC')).toBe(at);
    expect(quietEnd(at, { start: '07:00', end: '07:00' }, 'UTC')).toBe(at);
    expect(quietEnd(at, w, 'Not/AZone').toISOString()).toBe('2026-10-25T07:00:00.000Z');
    expect(clockLabel('22:00:00')).toBe('10:00 p.m.');
    expect(clockLabel('07:05')).toBe('7:05 a.m.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const item = (o: Partial<DigestSourceItem>): DigestSourceItem => ({
  id: o.id ?? Math.random().toString(36).slice(2), title: o.title ?? 'Update', body: o.body ?? null, deepLink: o.deepLink ?? '/inbox',
  severity: o.severity ?? 'info', eventType: o.eventType ?? 'task.assigned', jobId: o.jobId ?? null, jobLabel: o.jobLabel ?? null,
  itemCount: o.itemCount ?? 1, createdAt: o.createdAt ?? '2026-10-24T12:00:00Z',
});

describe('digest grouping', () => {
  const items = [
    item({ id: 'a', jobId: 'j1', jobLabel: 'J-1001 Smith kitchen', title: 'CO-7 signed', eventType: 'change_order.signed', createdAt: '2026-10-24T10:00:00Z' }),
    item({ id: 'b', jobId: 'j2', jobLabel: 'J-1002 Lee bath', title: 'Approval needed', severity: 'attention', eventType: 'approval.requested' }),
    item({ id: 'c', jobId: 'j1', jobLabel: 'J-1001 Smith kitchen', title: 'Time to approve', eventType: 'time.submitted', itemCount: 3, createdAt: '2026-10-24T11:00:00Z' }),
    item({ id: 'd', jobId: null, title: 'Lead waiting', severity: 'attention', eventType: 'lead.sla_breach' }),
    item({ id: 'e', jobId: 'j2', jobLabel: 'J-1002 Lee bath', title: 'Schedule changed', eventType: 'schedule.changed', createdAt: '2026-10-23T09:00:00Z' }),
  ];
  it('groups by job, "needs you" groups first, the general group after jobs, newest first inside', () => {
    const g = groupDigest(items);
    expect(g.groups.map((x) => x.label)).toEqual(['J-1002 Lee bath', 'Across your work', 'J-1001 Smith kitchen']);
    expect(g.groups[0]?.items.map((i) => i.id)).toEqual(['b', 'e']);
    expect(g.groups[2]?.items.map((i) => i.id)).toEqual(['c', 'a']);
    expect(g.total).toBe(7); // the batched "3 updates" row counts 3
    expect(g.needsYou).toBe(2);
    expect(g.headline).toBe('2 things need you');
  });
  it('headline without urgent items counts updates', () => {
    expect(groupDigest([item({}), item({})]).headline).toBe('2 updates');
    expect(groupDigest([item({ severity: 'critical' })]).headline).toBe('1 thing needs you');
  });
  it('the email: subject, escaped text, internal links only, plain-text twin', () => {
    const m = buildDigestEmail({ tenantName: 'Dorrian HVAC', firstName: 'Dana Lee', cadence: 'weekly', items: [...items, item({ title: '<script>x</script>', deepLink: '//evil.test/x' })], appUrl: 'https://projects.example.test/' });
    expect(m.subject).toBe('This week at Dorrian HVAC: 2 things need you');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('evil.test');
    expect(m.html).toContain('https://projects.example.test/inbox');
    expect(m.text).toContain('Hi Dana,');
    expect(m.text).toContain('J-1002 LEE BATH (1 needs you)');
    expect(absoluteLink('https://a.test', 'https://b.test')).toBe('https://a.test/');
  });
  it('more than the per-group cap folds into "…and N more"', () => {
    const many = Array.from({ length: 11 }, (_, i) => item({ id: `m${i}`, jobId: 'j9', jobLabel: 'J9' }));
    expect(buildDigestEmail({ tenantName: 'T', firstName: null, cadence: 'daily', items: many, appUrl: 'https://x.test' }).text).toContain('…and 3 more on this job.');
  });
  it('single notification email', () => {
    const m = buildNotificationEmail({ tenantName: 'T', title: 'Task assigned', body: 'Hang doors', deepLink: '/jobs/1', appUrl: 'https://x.test' });
    expect(m.text).toContain('https://x.test/jobs/1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const inbox = (o: Partial<InboxItem>): InboxItem => ({
  id: o.id ?? 'x', kind: 'k', eventType: null, sourceApp: 'projects', severity: o.severity ?? 'info', title: o.title ?? 't', body: null,
  deepLink: o.deepLink ?? null, jobId: o.jobId ?? null, jobLabel: o.jobLabel ?? null, subjectType: null, subjectId: null, itemCount: 1,
  delivery: 'instant', readAt: o.readAt ?? null, doneAt: o.doneAt ?? null, createdAt: o.createdAt ?? '2026-10-24T12:00:00Z', updatedAt: '2026-10-24T12:00:00Z',
});

describe('inbox presentation', () => {
  it('bell order: unread, then needs-you, then newest', () => {
    const r = rankForBell([
      inbox({ id: 'read', readAt: '2026-10-24T12:00:00Z', createdAt: '2026-10-24T13:00:00Z' }),
      inbox({ id: 'info', createdAt: '2026-10-24T11:00:00Z' }),
      inbox({ id: 'urgent', severity: 'attention', createdAt: '2026-10-24T10:00:00Z' }),
    ]);
    expect(r.map((x) => x.id)).toEqual(['urgent', 'info', 'read']);
  });
  it('groups a page by record, keeping page order; links fall back to the job, then the inbox', () => {
    const g = groupByRecord([inbox({ id: '1', jobId: 'j1', jobLabel: 'J1' }), inbox({ id: '2' }), inbox({ id: '3', jobId: 'j1', jobLabel: 'J1', readAt: 'x' })]);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id), x.unread])).toEqual([['J1', ['1', '3'], 1], ['Other', ['2'], 1]]);
    expect(hrefOf({ deepLink: null, jobId: 'j1' })).toBe('/jobs/j1');
    expect(hrefOf({ deepLink: '/time', jobId: 'j1' })).toBe('/time');
    expect(hrefOf({ deepLink: null, jobId: null })).toBe('/inbox');
  });
  it('relative times', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    expect(ago('2026-10-24T11:59:30Z', now)).toBe('now');
    expect(ago('2026-10-24T11:15:00Z', now)).toBe('45 min');
    expect(ago('2026-10-24T07:00:00Z', now)).toBe('5 h');
    expect(ago('2026-10-01T12:00:00Z', now)).toBe('Oct 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('email adapter (the Books sender: Resend + INVOICE_FROM_EMAIL)', () => {
  it('is disabled until RESEND_API_KEY and a From exist', async () => {
    expect(emailConfig({}).configured).toBe(false);
    expect(emailConfig({ RESEND_API_KEY: 'k' }).reason).toMatch(/sending address/);
    const s = resendSender({});
    expect(await s.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' })).toMatchObject({ status: 'not_configured' });
  });
  it('sends with header-safe values; a 2xx without an id is NOT sent', async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { id: 'em_1' } }));
    const s = resendSender({ RESEND_API_KEY: 'k', INVOICE_FROM_EMAIL: 'books@x.test', NOTIFY_FROM_EMAIL: 'notify@x.test' }, ok.f);
    expect(await s.send({ to: 'a@b.test', subject: 'Hi\r\nBcc: evil@x', html: 'h', text: 't' })).toEqual({ status: 'sent', provider: 'resend', providerMessageId: 'em_1' });
    const sent = JSON.parse(String(ok.calls[0]?.init.body)) as { from: string; subject: string };
    expect(sent.from).toBe('notify@x.test');
    expect(sent.subject).toBe('Hi Bcc: evil@x');
    const noId = fakeFetch(() => ({ status: 200, body: {} }));
    expect(await resendSender({ RESEND_API_KEY: 'k', INVOICE_FROM_EMAIL: 'b@x.test' }, noId.f).send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' })).toMatchObject({ status: 'failed', retry: true });
    const bad = fakeFetch(() => ({ status: 422, body: { message: 'bad' } }));
    expect(await resendSender({ RESEND_API_KEY: 'k', INVOICE_FROM_EMAIL: 'b@x.test' }, bad.f).send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' })).toMatchObject({ status: 'failed', retry: false });
    expect(headerSafe('a\u2028b')).toBe('a b');
  });
});

describe('SMS adapter (Twilio-shaped, disabled until credentials exist)', () => {
  it('not configured without TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN', async () => {
    expect(await twilioSender({}).send({ to: '+15155550142', body: 'x', from: '+15155550100' })).toMatchObject({ status: 'not_configured' });
  });
  it('sends form-encoded with basic auth, From the tenant\'s verified number', async () => {
    const ok = fakeFetch(() => ({ status: 201, body: { sid: 'SM1' } }));
    const s = twilioSender({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok' }, ok.f);
    expect(await s.send({ to: '+15155550142', body: 'On the way', from: '+15155550100' })).toEqual({ status: 'sent', provider: 'twilio', providerMessageId: 'SM1' });
    expect(ok.calls[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    expect(String(ok.calls[0]?.init.body)).toContain('From=%2B15155550100');
    expect((ok.calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('AC1:tok').toString('base64')}`);
  });
  it('security re-review: a shared Messaging Service / global number is never used; no verified number = refused, nothing sent', async () => {
    const svc = fakeFetch(() => ({ status: 201, body: { sid: 'SM2' } }));
    const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_MESSAGING_SERVICE_SID: 'MG1', TWILIO_FROM_NUMBER: '+15155559999' } as Parameters<typeof twilioSender>[0];
    await twilioSender(env, svc.f).send({ to: '+15155550142', body: 'x', from: '+15155550100' });
    const sent = String(svc.calls[0]?.init.body);
    expect(sent).toContain('From=%2B15155550100');
    expect(sent).not.toContain('MessagingServiceSid');
    expect(sent).not.toContain('15155559999');
    const none = fakeFetch(() => ({ status: 201, body: { sid: 'SM3' } }));
    expect(await twilioSender(env, none.f).send({ to: '+15155550142', body: 'x', from: null })).toMatchObject({ status: 'failed', retry: false });
    expect(none.calls).toHaveLength(0);
  });
  it('an unsubscribed recipient (21610) is permanent — no retry', async () => {
    const stop = fakeFetch(() => ({ status: 400, body: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } }));
    expect(await twilioSender({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok' }, stop.f).send({ to: '+15155550142', body: 'x', from: '+15155550100' })).toMatchObject({ status: 'failed', retry: false });
  });
  it('STOP / START / HELP keywords and E.164', () => {
    for (const w of ['STOP', 'stop', ' Stop please', 'UNSUBSCRIBE', 'cancel', 'End', 'QUIT', 'STOPALL', 'Revoke', 'opt-out']) expect(parseSmsKeyword(w), w).toBe('opt_out');
    for (const w of ['START', 'unstop', 'Yes']) expect(parseSmsKeyword(w), w).toBe('opt_in');
    expect(parseSmsKeyword('help')).toBe('help');
    expect(parseSmsKeyword('Running 10 min late')).toBe('message');
    expect(toE164('(515) 555-0142')).toBe('+15155550142');
    expect(toE164('1-515-555-0142')).toBe('+15155550142');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(toE164('555-0142')).toBeNull();
  });
  it('Twilio signature: valid passes (param order irrelevant); tampered body / URL / missing fail', () => {
    const url = 'https://projects.example.test/api/webhooks/notifications/sms';
    const params = { To: '+15155550100', From: '+15155550142', Body: 'STOP', MessageSid: 'SM9' };
    const sig = twilioSignature('secret', url, params);
    expect(verifyTwilioSignature('secret', url, { MessageSid: 'SM9', Body: 'STOP', From: '+15155550142', To: '+15155550100' }, sig)).toBe(true);
    expect(verifyTwilioSignature('secret', url, { ...params, Body: 'START' }, sig)).toBe(false);
    expect(verifyTwilioSignature('secret', `${url}?x=1`, params, sig)).toBe(false);
    expect(verifyTwilioSignature(undefined, url, params, sig)).toBe(false);
    expect(verifyTwilioSignature('secret', url, params, null)).toBe(false);
    expect(twiml('a & <b>')).toContain('<Message>a &amp; &lt;b&gt;</Message>');
    expect(twiml(null)).toContain('<Response></Response>');
  });
});

describe('texting-number verification (security review M)', () => {
  const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok' };
  const ORG = 'a0000000-0000-4000-8000-000000000001';
  const twilio = (numbers: Array<{ sid: string; phone_number: string; friendly_name: string }>) => fakeFetch(() => ({ status: 200, body: { incoming_phone_numbers: numbers } }));
  it('verified only when the number is in the Merit account AND tagged for this tenant', async () => {
    const ok = twilio([{ sid: 'PN1', phone_number: '+15155550100', friendly_name: `Dorrian main merit-org:${ORG}` }]);
    expect(await checkTwilioNumber(ORG, '+15155550100', env, ok.f)).toEqual({ status: 'verified', providerSid: 'PN1' });
    expect(ok.calls[0]?.url).toContain('IncomingPhoneNumbers.json?PhoneNumber=%2B15155550100');
    const other = twilio([{ sid: 'PN1', phone_number: '+15155550100', friendly_name: 'merit-org:b0000000-0000-4000-8000-000000000001' }]);
    expect(await checkTwilioNumber(ORG, '+15155550100', env, other.f)).toMatchObject({ status: 'refused' });
    expect(await checkTwilioNumber(ORG, '+15155550100', env, twilio([]).f)).toMatchObject({ status: 'refused' });
  });
  it('without Twilio credentials the request stays pending', async () => {
    expect(await checkTwilioNumber(ORG, '+15155550100', {})).toMatchObject({ status: 'unavailable' });
  });
  it('the settings patch cannot carry a texting number; the sender route takes one', () => {
    expect(SettingsBody.safeParse({ companyId: ORG, patch: { sms_from_number: '+15155550100' } }).success).toBe(false);
    expect(SenderBody.safeParse({ companyId: ORG, phone: '(515) 555-0100' }).success).toBe(true);
  });
});

describe('push adapter (Expo, disabled until EXPO_ACCESS_TOKEN exists)', () => {
  it('not configured without the token', async () => {
    expect(pushConfig({}).configured).toBe(false);
    expect((await expoSender({}).send({ tokens: [TOKEN], title: 't', body: 'b', deepLink: null, data: {} })).outcome.status).toBe('not_configured');
  });
  it('one message per valid token, with the deep link in data', () => {
    const m = buildExpoMessages({ tokens: [TOKEN, 'not-a-token'], title: 'x'.repeat(200), body: 'b', deepLink: '/jobs/1', data: { notificationId: 'n1' } });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ to: TOKEN, sound: 'default', data: { notificationId: 'n1', url: '/jobs/1' } });
    expect(m[0]?.title).toHaveLength(120);
    expect(isExpoToken('ExpoPushToken[abcdefgh12]')).toBe(true);
  });
  it('tickets: any ok = sent; DeviceNotRegistered tokens come back to revoke; all dead = no retry', () => {
    const msgs = buildExpoMessages({ tokens: [TOKEN, 'ExponentPushToken[zzzzzzzzzz99]'], title: 't', body: 'b', deepLink: null, data: {} });
    const mixed = foldTickets(msgs, [{ status: 'ok', id: 't1' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }]);
    expect(mixed.outcome).toEqual({ status: 'sent', provider: 'expo', providerMessageId: 't1' });
    expect(mixed.deadTokens).toEqual(['ExponentPushToken[zzzzzzzzzz99]']);
    const dead = foldTickets(msgs, msgs.map(() => ({ status: 'error' as const, details: { error: 'DeviceNotRegistered' } })));
    expect(dead.outcome).toMatchObject({ status: 'failed', retry: false });
  });
  it('posts to the Expo push API with the bearer token', async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { data: [{ status: 'ok', id: 'tk' }] } }));
    const r = await expoSender({ EXPO_ACCESS_TOKEN: 'ex' }, ok.f).send({ tokens: [TOKEN], title: 't', body: 'b', deepLink: null, data: {} });
    expect(r.outcome.status).toBe('sent');
    expect(ok.calls[0]?.url).toBe('https://exp.host/--/api/v2/push/send');
    expect((ok.calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer ex');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the worker loop', () => {
  function port(rows: ClaimedRow[], digests: DigestRow[] = []) {
    const results: Array<[string, SendOutcome]> = [];
    const revoked: string[] = [];
    const done: Array<[string, boolean]> = [];
    const p: WorkerPort = {
      sweep: async () => 2,
      claim: async () => rows,
      result: async (id, o) => { results.push([id, o]); },
      revokeToken: async (t) => { revoked.push(t); },
      orgNames: async () => new Map([['o1', 'Dorrian HVAC']]),
      collectDigests: async () => digests,
      digestDone: async (id, ok) => { done.push([id, ok]); },
    };
    return { p, results, revoked, done };
  }
  const row = (o: Partial<ClaimedRow>): ClaimedRow => ({
    id: o.id ?? 'r', org_id: 'o1', channel: o.channel ?? 'push', audience: o.audience ?? 'internal', membership_id: 'm1', to_address: o.to_address ?? null,
    subject: 'Task', body: 'Hang doors', deep_link: '/jobs/1', data: {}, attempts: 1, push_tokens: o.push_tokens ?? [TOKEN], sms_from: o.sms_from ?? null,
  });
  const sent = (id: string): SendOutcome => ({ status: 'sent', provider: 'x', providerMessageId: id });

  it('sends each claimed row on its channel, records every outcome, revokes dead tokens, sends digests', async () => {
    const { p, results, revoked, done } = port(
      [row({ id: 'p1' }), row({ id: 'e1', channel: 'email', to_address: 'a@b.test' }), row({ id: 's1', channel: 'sms', to_address: '+15155550142', sms_from: '+15155550100' })],
      [{ digest_id: 'd1', org_id: 'o1', org_name: 'Dorrian HVAC', membership_id: 'm1', email: 'a@b.test', first_name: 'Dana', cadence: 'daily', items: [item({})] }],
    );
    const emails: string[] = [];
    const summary = await runNotificationWorker({
      port: p,
      appUrl: 'https://x.test',
      email: { id: 'resend', send: async (m) => { emails.push(m.subject); return sent('em'); } },
      sms: { id: 'twilio', send: async (m) => (m.from === '+15155550100' ? sent('sm') : { status: 'failed', provider: 'twilio', reason: 'no from', retry: false }) },
      push: { id: 'expo', send: async () => ({ outcome: sent('tk'), deadTokens: ['ExponentPushToken[deaddeaddead]'] }) },
    });
    expect(summary).toMatchObject({ swept: 2, claimed: 3, sent: 3, failed: 0, skipped: 0, digestsSent: 1, revokedTokens: 1 });
    expect(results.map(([id, o]) => [id, o.status])).toEqual([['p1', 'sent'], ['e1', 'sent'], ['s1', 'sent']]);
    expect(revoked).toEqual(['ExponentPushToken[deaddeaddead]']);
    expect(done).toEqual([['d1', true]]);
    expect(emails).toContain('Today at Dorrian HVAC: 1 update');
  });
  it('a channel that is not set up is recorded as skipped (never "sent"); a failed digest frees its claim', async () => {
    const { p, results, done } = port([row({ id: 'p1' })], [{ digest_id: 'd1', org_id: 'o1', org_name: null, membership_id: 'm1', email: 'a@b.test', first_name: null, cadence: 'weekly', items: [item({})] }]);
    const summary = await runNotificationWorker({
      port: p, appUrl: 'https://x.test',
      email: resendSender({}), sms: twilioSender({}), push: expoSender({}),
    });
    expect(results[0]?.[1].status).toBe('not_configured');
    expect(resultArgs('p1', results[0]![1])).toMatchObject({ p_status: 'skipped', p_retry: false });
    expect(done).toEqual([['d1', false]]);
    expect(summary.notConfigured.join(' ')).toMatch(/EXPO_ACCESS_TOKEN/);
    expect(summary.notConfigured.join(' ')).toMatch(/RESEND_API_KEY/);
  });
  it('a provider throwing is a retryable failure', async () => {
    const { p, results } = port([row({ id: 'p1' })]);
    await runNotificationWorker({ port: p, appUrl: 'https://x.test', email: resendSender({}), sms: twilioSender({}),
      push: { id: 'expo', send: async () => { throw new Error('boom'); } } });
    expect(resultArgs('p1', results[0]![1])).toMatchObject({ p_status: 'failed', p_retry: true, p_error: 'boom' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('request schemas', () => {
  it('mark: ids required except for the *_all states', () => {
    expect(MarkBody.safeParse({ state: 'read' }).success).toBe(false);
    expect(MarkBody.safeParse({ state: 'read_all' }).success).toBe(true);
    expect(MarkBody.safeParse({ state: 'done', ids: ['00000000-0000-4000-8000-000000000001'] }).success).toBe(true);
  });
  it('prefs: digest only on email; quiet hours need both ends; a number needs consent', () => {
    expect(PrefsBody.safeParse({ rules: [{ event_type: 'task.assigned', channel: 'push', mode: 'digest' }] }).success).toBe(false);
    expect(PrefsBody.safeParse({ quietStart: '22:00' }).success).toBe(false);
    expect(PrefsBody.safeParse({ quietStart: '22:00', quietEnd: '07:00', timezone: 'America/Chicago' }).success).toBe(true);
    expect(PrefsBody.safeParse({ smsPhone: '5155550142' }).success).toBe(false);
    expect(PrefsBody.safeParse({ smsPhone: '5155550142', smsConsent: true }).success).toBe(true);
    expect(PrefsBody.safeParse({ rules: [{ event_type: 'customer.on_my_way', channel: 'push', mode: 'off' }] }).success).toBe(false);
  });
  it('devices: Expo tokens only; settings: something to change', () => {
    expect(DeviceBody.safeParse({ token: TOKEN, platform: 'ios' }).success).toBe(true);
    expect(DeviceBody.safeParse({ token: 'apns-raw-token', platform: 'ios' }).success).toBe(false);
    expect(SettingsBody.safeParse({ companyId: '00000000-0000-4000-8000-000000000001', patch: {} }).success).toBe(false);
    expect(SettingsBody.safeParse({ companyId: '00000000-0000-4000-8000-000000000001', patch: { customer_messages_live: true } }).success).toBe(true);
  });
});
