/**
 * Pure parts of the request engine (FPB-request-engine-notifications §4, §8):
 * cadence math, quiet hours across time zones and DST, policy resolution (incl. the
 * existing Receipt chase settings), the W-9/COI decisions, token shape/hash, the email
 * payload, the Svix webhook signature, and deep-link safety.
 */
import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  afterSend,
  anchorBase,
  deferForQuietHours,
  describeCadence,
  inQuietHours,
  initialSchedule,
  localToUtc,
  nextSlotAfter,
  parseDayList,
  quietHoursOf,
  resolveTimeZone,
  shouldEscalate,
  slotTime,
} from './cadence';
import { mergePolicy, receiptChannels, receiptPolicy, resolvePolicy, type OrgChaseSettings, type PolicyRow } from './policy';
import { decideVendorDoc, requiredDocTypes } from './resolvers';
import { generateRequestToken, hashRequestToken, looksLikeRequestToken } from './tokens';
import { vendorNeeds } from './vendor-compliance';
import { buildRequestEmail } from '@/lib/notify/request-email';
import { verifySvixSignature } from '@/lib/notify/resend-webhook';
import { safeDeepLink } from '@/lib/notify/in-app';
import type { Cadence } from './types';

const DAY = 1440;
const MS_DAY = 86_400_000;
const iso = (d: Date | null | undefined) => d?.toISOString();

describe('cadence slots', () => {
  const c: Cadence = { anchor: 'created', offsetsMinutes: [0, 3 * DAY, 7 * DAY], repeatEveryMinutes: 7 * DAY, maxSends: 10 };
  const base = new Date('2026-11-02T15:00:00Z');

  it('day 0, 3, 7, then weekly', () => {
    expect(iso(slotTime(c, base, 1))).toBe('2026-11-02T15:00:00.000Z');
    expect(iso(slotTime(c, base, 2))).toBe('2026-11-05T15:00:00.000Z');
    expect(iso(slotTime(c, base, 3))).toBe('2026-11-09T15:00:00.000Z');
    expect(iso(slotTime(c, base, 4))).toBe('2026-11-16T15:00:00.000Z');
    expect(iso(slotTime(c, base, 5))).toBe('2026-11-23T15:00:00.000Z');
    expect(slotTime({ ...c, repeatEveryMinutes: null }, base, 4)).toBeNull();
  });

  it('after a send the next slot is the first one later than now — a late request never bursts', () => {
    // sent slot 1 twenty days late → next is the weekly slot after now, not slots 2 and 3 back to back
    const now = new Date(base.getTime() + 20 * MS_DAY);
    const next = afterSend(c, base, now, 1)!;
    expect(next.at.getTime()).toBeGreaterThan(now.getTime());
    expect(iso(next.at)).toBe('2026-11-23T15:00:00.000Z');
    expect(next.slot).toBe(5);
    expect(nextSlotAfter(c, base, new Date(base.getTime() + 1), 1)).toEqual({ slot: 2, at: slotTime(c, base, 2) });
  });

  it('a new request sends right away when slot 1 is past, else waits for it', () => {
    const now = new Date('2026-11-02T16:00:00Z');
    expect(iso(initialSchedule(c, base, now).at)).toBe(now.toISOString());
    const renewal: Cadence = { anchor: 'due', offsetsMinutes: [-30 * DAY, -15 * DAY, 0], repeatEveryMinutes: 7 * DAY, maxSends: 10 };
    const due = anchorBase('due', now, '2026-12-19', 'America/Chicago');
    expect(iso(due)).toBe('2026-12-19T15:00:00.000Z'); // 09:00 CST
    expect(iso(initialSchedule(renewal, due, now).at)).toBe('2026-11-19T15:00:00.000Z'); // T-30
    // FPB-vendor-compliance-chase AC 6: expiring Nov 19 → Oct 20, Nov 4, Nov 19, then weekly
    const nov19 = anchorBase('due', now, '2026-11-19', 'America/Chicago');
    expect([1, 2, 3, 4].map((s) => iso(slotTime(renewal, nov19, s))?.slice(0, 10))).toEqual(['2026-10-20', '2026-11-04', '2026-11-19', '2026-11-26']);
  });

  it('escalates once, at the threshold', () => {
    expect(shouldEscalate(2, 3, null)).toBe(false);
    expect(shouldEscalate(3, 3, null)).toBe(true);
    expect(shouldEscalate(4, 3, '2026-11-01T00:00:00Z')).toBe(false);
    expect(shouldEscalate(9, null, null)).toBe(false);
  });

  it('describes cadences in plain English', () => {
    expect(describeCadence(c, 'created')).toBe('Day 0, 3, 7, then weekly');
    expect(describeCadence({ offsetsMinutes: [-30 * DAY, -15 * DAY, 0], repeatEveryMinutes: 7 * DAY }, 'due')).toBe('T-30, T-15, T-0, then weekly');
    expect(describeCadence({ offsetsMinutes: [30], repeatEveryMinutes: 120 }, 'created')).toBe('After 30 minutes, then every 2 hours');
    expect(parseDayList('0, 3 7')).toEqual([0, 3 * DAY, 7 * DAY]);
    expect(parseDayList('-30,-15,0')).toEqual([-30 * DAY, -15 * DAY, 0]);
    expect(parseDayList('a, 3')).toBeNull();
    expect(parseDayList('')).toBeNull();
  });
});

describe('quiet hours across time zones and DST', () => {
  const q = { start: '20:00', end: '07:00' };

  it('22:00 Chicago (CDT, before DST ends) waits until 07:00 CDT', () => {
    const d = new Date('2026-10-20T03:00:00Z'); // 22:00 CDT Oct 19
    expect(inQuietHours(d, q, 'America/Chicago')).toBe(true);
    expect(iso(deferForQuietHours(d, q, 'America/Chicago'))).toBe('2026-10-20T12:00:00.000Z');
  });

  it('the night DST ends (Nov 1) the 07:00 release is CST (13:00Z), not CDT', () => {
    const d = new Date('2026-11-01T04:00:00Z'); // 23:00 CDT Oct 31
    expect(iso(deferForQuietHours(d, q, 'America/Chicago'))).toBe('2026-11-01T13:00:00.000Z');
  });

  it('the same instant is quiet in Los Angeles but not in New York', () => {
    const d = new Date('2026-11-03T03:30:00Z'); // 22:30 EST · 19:30 PST
    expect(inQuietHours(d, q, 'America/New_York')).toBe(true);
    expect(inQuietHours(d, q, 'America/Los_Angeles')).toBe(false);
    expect(iso(deferForQuietHours(d, q, 'America/New_York'))).toBe('2026-11-03T12:00:00.000Z');
  });

  it('just after midnight releases the same morning; outside the window is unchanged', () => {
    const d = new Date('2026-11-03T07:15:00Z'); // 01:15 CST
    expect(iso(deferForQuietHours(d, q, 'America/Chicago'))).toBe('2026-11-03T13:00:00.000Z');
    const day = new Date('2026-11-03T18:00:00Z');
    expect(deferForQuietHours(day, q, 'America/Chicago')).toBe(day);
  });

  it('a same-day window (12:00–13:00) and malformed input', () => {
    const lunch = { start: '12:00', end: '13:00' };
    expect(iso(deferForQuietHours(new Date('2026-11-03T18:30:00Z'), lunch, 'America/Chicago'))).toBe('2026-11-03T19:00:00.000Z');
    expect(quietHoursOf('21:00:00', '06:00:00')).toEqual({ start: '21:00', end: '06:00' });
    expect(quietHoursOf('25:00', '06:00')).toBeNull();
    expect(quietHoursOf('06:00', '06:00')).toBeNull();
    expect(resolveTimeZone('Not/AZone', null, 'America/Denver')).toBe('America/Denver');
    expect(resolveTimeZone(undefined)).toBe('UTC');
  });

  it('localToUtc is DST-correct both sides of the change', () => {
    expect(iso(localToUtc(2026, 3, 9, 7, 0, 'America/Chicago'))).toBe('2026-03-09T12:00:00.000Z'); // CDT
    expect(iso(localToUtc(2026, 3, 6, 7, 0, 'America/Chicago'))).toBe('2026-03-06T13:00:00.000Z'); // CST
  });
});

describe('policies', () => {
  const org: OrgChaseSettings = {
    timezone: 'America/Chicago',
    chase_first_reminder_minutes: 30,
    chase_followup_minutes: 120,
    chase_escalation_threshold: 4,
    chase_quiet_start: '21:00:00',
    chase_quiet_end: '06:00:00',
    chase_channel: 'PUSH_SMS_EMAIL',
  };

  it('receipt chase reads the existing Settings → Receipt chase values', () => {
    const p = receiptPolicy(org);
    expect(p.cadence).toEqual({ anchor: 'created', offsetsMinutes: [30], repeatEveryMinutes: 120, maxSends: 10 });
    expect(p.escalateAfter).toBe(4);
    expect(p.quiet).toEqual({ start: '21:00', end: '06:00' });
    expect(p.channels).toEqual(['push', 'sms', 'email', 'in_app']);
    expect(p.source).toBe('receipt_settings');
    expect(receiptChannels('PUSH_SMS')).toEqual(['push', 'sms', 'in_app']);
    expect(resolvePolicy({ org, rows: [] }, 'receipt').key).toBe('receipt');
  });

  it('code defaults ← tenant default quiet hours ← tenant row (null = inherit)', () => {
    const rows: PolicyRow[] = [
      { policy_key: 'default', location_id: null, auto_create: false, cadence_anchor: null, cadence_offsets_minutes: null, repeat_every_minutes: null, max_sends: null, escalate_after: null, channels: null, quiet_start: '19:00', quiet_end: '08:00', timezone: 'America/Denver' },
      { policy_key: 'w9', location_id: null, auto_create: true, cadence_anchor: null, cadence_offsets_minutes: [7 * DAY, 0], repeat_every_minutes: 14 * DAY, max_sends: 4, escalate_after: null, channels: ['email'], quiet_start: null, quiet_end: null, timezone: null },
    ];
    const w9 = mergePolicy('w9', org, rows);
    expect(w9.cadence.offsetsMinutes).toEqual([0, 7 * DAY]); // sorted
    expect(w9.cadence.repeatEveryMinutes).toBe(14 * DAY);
    expect(w9.cadence.maxSends).toBe(4);
    expect(w9.escalateAfter).toBe(3); // null inherits the default
    expect(w9.autoCreate).toBe(true);
    expect(w9.quiet).toEqual({ start: '19:00', end: '08:00' });
    expect(w9.timezone).toBe('America/Denver');
    const coi = mergePolicy('coi_renewal', org, rows);
    expect(coi.anchor).toBe('due');
    expect(coi.cadence.offsetsMinutes).toEqual([-30 * DAY, -15 * DAY, 0]);
    expect(coi.autoCreate).toBe(false);
    expect(resolvePolicy({ org, rows }, 'coi', { renewal: true }).key).toBe('coi_renewal');
  });
});

describe('W-9 / COI decisions', () => {
  const req = { kind: 'w9' as const, meta: { doc_types: ['W9'] }, due_date: null, created_at: '2026-11-02T15:00:00Z', recipient_vendor_id: 'v1' };

  it('fulfilled when VALID on file, or uploaded through the portal after the ask', () => {
    expect(decideVendorDoc(req, [{ vendor_id: 'v1', doc_type: 'W9', status: 'MISSING', expiration_date: null }], [], '2026-11-05')).toEqual({ satisfied: false });
    expect(decideVendorDoc(req, [{ vendor_id: 'v1', doc_type: 'W9', status: 'VALID', expiration_date: null }], [], '2026-11-05')).toMatchObject({ satisfied: true, via: 'resolver' });
    expect(decideVendorDoc(req, [], [{ entity_id: 'v1', doc_type: 'W9', created_at: '2026-11-03T00:00:00Z' }], '2026-11-05')).toMatchObject({ satisfied: true, via: 'magic_link' });
    // an OLD upload (before the ask) doesn't count; another vendor's doc doesn't count
    expect(decideVendorDoc(req, [], [{ entity_id: 'v1', doc_type: 'W9', created_at: '2026-10-01T00:00:00Z' }], '2026-11-05')).toEqual({ satisfied: false });
    expect(decideVendorDoc(req, [{ vendor_id: 'v2', doc_type: 'W9', status: 'VALID', expiration_date: null }], [], '2026-11-05')).toEqual({ satisfied: false });
  });

  it('a renewal is met only by a certificate valid beyond the old expiry', () => {
    const renew = { kind: 'coi' as const, meta: { doc_types: ['GL_COI'] }, due_date: '2026-11-19', created_at: '2026-10-20T15:00:00Z', recipient_vendor_id: 'v1' };
    expect(decideVendorDoc(renew, [{ vendor_id: 'v1', doc_type: 'GL_COI', status: 'VALID', expiration_date: '2026-11-19' }], [], '2026-11-01')).toEqual({ satisfied: false });
    expect(decideVendorDoc(renew, [{ vendor_id: 'v1', doc_type: 'GL_COI', status: 'VALID', expiration_date: '2027-11-19' }], [], '2026-11-01')).toMatchObject({ satisfied: true });
    expect(requiredDocTypes({ kind: 'coi', meta: {} })).toEqual(['GL_COI']);
  });

  it('vendorNeeds: missing W-9, lapsed COI, and the 30-day renewal window', () => {
    const today = '2026-11-01';
    expect(vendorNeeds([{ vendor_id: 'v', doc_type: 'W9', status: 'MISSING', expiration_date: null }], today)).toEqual([{ kind: 'w9', docTypes: ['W9'], renewal: false, dueDate: null }]);
    expect(vendorNeeds([{ vendor_id: 'v', doc_type: 'W9', status: 'VALID', expiration_date: null }], today)).toEqual([]);
    expect(vendorNeeds([{ vendor_id: 'v', doc_type: 'GL_COI', status: 'VALID', expiration_date: '2026-10-15' }], today)).toEqual([{ kind: 'coi', docTypes: ['GL_COI'], renewal: false, dueDate: null }]);
    expect(vendorNeeds([{ vendor_id: 'v', doc_type: 'GL_COI', status: 'VALID', expiration_date: '2026-11-19' }, { vendor_id: 'v', doc_type: 'WC_COI', status: 'VALID', expiration_date: '2026-11-25' }], today)).toEqual([
      { kind: 'coi', docTypes: ['GL_COI', 'WC_COI'], renewal: true, dueDate: '2026-11-19' },
    ]);
    expect(vendorNeeds([{ vendor_id: 'v', doc_type: 'GL_COI', status: 'VALID', expiration_date: '2027-03-01' }], today)).toEqual([]);
  });
});

describe('tokens, email, webhook signature, deep links', () => {
  it('tokens are url-safe and only their sha256 is kept', () => {
    const t = generateRequestToken();
    expect(looksLikeRequestToken(t)).toBe(true);
    expect(hashRequestToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRequestToken(t)).not.toContain(t);
    expect(looksLikeRequestToken(hashRequestToken(t))).toBe(false); // a pasted hash is not a link
    expect(looksLikeRequestToken('short')).toBe(false);
    expect(looksLikeRequestToken('../../etc/passwd'.padEnd(44, 'a'))).toBe(false);
  });

  it('the email is white-labelled, escaped, has one button, a text twin and an unsubscribe', () => {
    const m = buildRequestEmail({
      senderName: 'Artistry <Homes>',
      recipientName: 'Dana Lee',
      kind: 'w9',
      title: 'Please send your W-9',
      message: 'Upload a PDF.',
      step: 2,
      dueDate: '2026-11-19',
      ctaUrl: 'https://books.example.test/r/abc',
      unsubscribeUrl: 'https://books.example.test/r/abc/unsubscribe',
    });
    expect(m.subject).toBe('Reminder: Please send your W-9');
    expect(m.html).toContain('Artistry &lt;Homes&gt;');
    expect(m.html).not.toContain('<Homes>');
    expect(m.html).toContain('Upload your W-9');
    expect(m.html).toContain('#2563EB');
    expect(m.html).toContain('#0A1628');
    expect(m.html).not.toMatch(/Merit Management/);
    expect(m.text).toContain('Hi Dana,');
    expect(m.text).toContain('Needed by Nov 19, 2026');
    expect(m.text).toContain('Stop these emails: https://books.example.test/r/abc/unsubscribe');
  });

  it('Svix signatures: valid passes; wrong, stale, missing or unconfigured fail closed', () => {
    const key = Buffer.from('a-very-secret-key-for-tests');
    const secret = `whsec_${key.toString('base64')}`;
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_1' } });
    const ts = '1793000000';
    const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
    const h = { id: 'msg_1', timestamp: ts, signature: `v1,bogus v1,${sig}` };
    expect(verifySvixSignature(secret, h, body, 1793000010)).toEqual({ ok: true });
    expect(verifySvixSignature(secret, h, body + ' ', 1793000010)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySvixSignature(secret, h, body, 1793000000 + 3600)).toEqual({ ok: false, reason: 'stale' });
    expect(verifySvixSignature(secret, { ...h, signature: null }, body, 1793000010)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifySvixSignature(undefined, h, body, 1793000010)).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('deep links are internal only', () => {
    expect(safeDeepLink('/requests?id=1')).toBe('/requests?id=1');
    expect(safeDeepLink('//evil.test')).toBeNull();
    expect(safeDeepLink('https://evil.test')).toBeNull();
    expect(safeDeepLink('/\\evil.test')).toBeNull();
  });
});
