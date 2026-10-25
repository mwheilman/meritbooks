import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HttpError, PmQueryError } from '@/lib/api-errors';
import { challengeRuntime, verifyChallenge } from '@/lib/fieldservice/widget-guard';
import { applyFsCommand, type FsRpc } from '@/lib/fieldservice/field-commands';
import { extractReadings, structureNote, tagPhoto } from '@/lib/fieldservice/notes';
import { METRICS, parsePeriod, parseQuestion } from '@/lib/fieldservice/qa';
import { decodeSerialYear, lineTax, replyIntent, taxableByDefault, validateForm, type FormField } from '@/lib/fieldservice/rules';
import {
  normalizeDialpad, normalizeRingCentral, normalizeTwilio, providerFromSlug, ringCentralSetupOpen, verifyDialpadJwt, verifyRingCentral, voiceConfig,
} from '@/lib/fieldservice/telephony';

/** Migration 1123 client mirrors: telephony adapters, reply intents, form rules, tax, notes, Q&A, phone commands. */

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function jwt(payload: object, secret: string, alg = 'HS256'): string {
  const h = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  return `${h}.${p}.${b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest())}`;
}

describe('telephony adapters (FS-05)', () => {
  it('stays off until every credential is present', () => {
    expect(voiceConfig('DIALPAD', {})).toEqual({ configured: false, missing: ['DIALPAD_API_KEY', 'DIALPAD_WEBHOOK_SECRET'] });
    expect(voiceConfig('DIALPAD', { DIALPAD_API_KEY: 'k', DIALPAD_WEBHOOK_SECRET: 's' }).configured).toBe(true);
    expect(voiceConfig('RINGCENTRAL', { RINGCENTRAL_CLIENT_ID: 'a' }).missing).toHaveLength(3);
    expect(providerFromSlug('twilio')).toBe('TWILIO_VOICE');
    expect(providerFromSlug('Dialpad')).toBe('DIALPAD');
    expect(providerFromSlug('vonage')).toBeNull();
  });

  it('verifies the Dialpad HS256 signature and refuses tampering, other algorithms and no secret', () => {
    const now = new Date('2026-10-25T14:00:00Z');
    const iat = Math.floor(now.getTime() / 1000);
    const t = jwt({ call_id: 42, state: 'missed', iat }, 'sec');
    expect(verifyDialpadJwt(t, 'sec', now)).toMatchObject({ call_id: 42 });
    expect(verifyDialpadJwt(t, 'other', now)).toBeNull();
    expect(verifyDialpadJwt(t, undefined, now)).toBeNull();
    const [h, , s] = t.split('.');
    expect(verifyDialpadJwt(`${h}.${b64url(JSON.stringify({ call_id: 43, iat }))}.${s}`, 'sec', now)).toBeNull();
    expect(verifyDialpadJwt(jwt({ call_id: 1, iat }, 'sec', 'none'), 'sec', now)).toBeNull();
    expect(verifyDialpadJwt('garbage', 'sec', now)).toBeNull();
  });

  it('refuses a replayed Dialpad token: no iat / exp, older than 5 minutes, expired, or exp far ahead', () => {
    const now = new Date('2026-10-25T14:00:00Z');
    const t0 = Math.floor(now.getTime() / 1000);
    expect(verifyDialpadJwt(jwt({ call_id: 1 }, 'sec'), 'sec', now)).toBeNull();
    expect(verifyDialpadJwt(jwt({ call_id: 1, iat: t0 - 301 }, 'sec'), 'sec', now)).toBeNull();
    expect(verifyDialpadJwt(jwt({ call_id: 1, iat: t0 - 299 }, 'sec'), 'sec', now)).not.toBeNull();
    expect(verifyDialpadJwt(jwt({ call_id: 1, exp: t0 - 1 }, 'sec'), 'sec', now)).toBeNull();
    expect(verifyDialpadJwt(jwt({ call_id: 1, exp: t0 + 3600 }, 'sec'), 'sec', now)).toBeNull();
    expect(verifyDialpadJwt(jwt({ call_id: 1, exp: t0 + 120 }, 'sec'), 'sec', now)).not.toBeNull();
  });

  it('answers the RingCentral subscription handshake only inside a short setup window', () => {
    const now = new Date('2026-10-25T14:00:00Z');
    expect(ringCentralSetupOpen({}, now)).toBe(false);
    expect(ringCentralSetupOpen({ RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL: '2026-10-25T14:10:00Z' }, now)).toBe(true);
    expect(ringCentralSetupOpen({ RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL: '2026-10-25T13:59:00Z' }, now)).toBe(false);
    expect(ringCentralSetupOpen({ RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL: '2026-10-26T14:00:00Z' }, now)).toBe(false);
    expect(ringCentralSetupOpen({ RINGCENTRAL_SUBSCRIPTION_SETUP_UNTIL: 'soon' }, now)).toBe(false);
  });

  it('checks the RingCentral verification token', () => {
    expect(verifyRingCentral('tok', { RINGCENTRAL_WEBHOOK_TOKEN: 'tok' })).toBe(true);
    expect(verifyRingCentral('tok2', { RINGCENTRAL_WEBHOOK_TOKEN: 'tok' })).toBe(false);
    expect(verifyRingCentral(null, { RINGCENTRAL_WEBHOOK_TOKEN: 'tok' })).toBe(false);
    expect(verifyRingCentral('tok', {})).toBe(false);
  });

  it('normalizes a RingCentral missed call', () => {
    const e = normalizeRingCentral({ timestamp: '2026-10-20T15:00:00Z', body: { telephonySessionId: 's-1', parties: [
      { direction: 'Inbound', from: { phoneNumber: '+15155551234' }, to: { phoneNumber: '+15155550100' }, status: { code: 'Disconnected' }, missedCall: true }] } });
    expect(e).toMatchObject({ call_id: 's-1', direction: 'INBOUND', from: '+15155551234', outcome: 'MISSED', ended_at: '2026-10-20T15:00:00.000Z',
                              event_at: '2026-10-20T15:00:00.000Z' });
    expect(normalizeRingCentral({ body: {} })).toBeNull();
  });

  it('normalizes Dialpad: hangup without connect is missed, duration ms → s, outbound swaps numbers', () => {
    expect(normalizeDialpad({ call_id: 9, direction: 'inbound', state: 'hangup', external_number: '+1515', internal_number: '+1600' }))
      .toMatchObject({ call_id: '9', outcome: 'MISSED', from: '+1515', to: '+1600' });
    expect(normalizeDialpad({ call_id: 10, direction: 'outbound', state: 'hangup', date_connected: 1_760_000_000_000, duration: 61_400, external_number: '+1515', internal_number: '+1600' }))
      .toMatchObject({ outcome: 'ANSWERED', from: '+1600', to: '+1515', duration_seconds: 61 });
    expect(normalizeDialpad({ state: 'missed' })).toBeNull();
  });

  it('normalizes Twilio status callbacks', () => {
    expect(normalizeTwilio({ CallSid: 'CA1', CallStatus: 'completed', CallDuration: '0', Direction: 'inbound', From: '+1515', To: '+1600' })?.outcome).toBe('MISSED');
    expect(normalizeTwilio({ CallSid: 'CA2', CallStatus: 'completed', CallDuration: '95', Direction: 'outbound-api' })).toMatchObject({ outcome: 'ANSWERED', direction: 'OUTBOUND', duration_seconds: 95 });
    expect(normalizeTwilio({ CallSid: 'CA3', CallStatus: 'busy' })?.outcome).toBe('BUSY');
    expect(normalizeTwilio({ CallSid: 'CA4', CallStatus: 'busy', Timestamp: 'Sun, 25 Oct 2026 14:00:00 +0000' })?.event_at).toBe('2026-10-25T14:00:00.000Z');
    expect(normalizeDialpad({ call_id: 5, state: 'missed', iat: 1_761_400_800 })?.event_at).toBe(new Date(1_761_400_800_000).toISOString());
    expect(normalizeTwilio({ CallStatus: 'busy' })).toBeNull();
  });
});

describe('reply-to-confirm (FS-22)', () => {
  it.each([['C', 'CONFIRM'], ['yes!', 'CONFIRM'], ['1', 'CONFIRM'], ['R please', 'RESCHEDULE'], ['cancel', 'CANCEL'], ['STOP', 'STOP'], ['what time?', 'OTHER'], ['', 'OTHER']])(
    '%s → %s', (body, intent) => expect(replyIntent(body)).toBe(intent));
});

describe('forms with required readings (FS-29)', () => {
  const fields: FormField[] = [
    { key: 'superheat', label: 'Superheat', type: 'reading', unit: '°F', min: 5, max: 25, required: true },
    { key: 'co', label: 'CO ambient', type: 'reading', unit: 'ppm', red_tag_above: 35, required: true },
    { key: 'hx', label: 'Heat exchanger', type: 'pass_fail', red_tag_on_fail: true, required: true },
    { key: 'filter', label: 'Filter size', type: 'choice', options: ['16x25', '20x25'] },
    { key: 'note', label: 'Note', type: 'text' },
  ];
  it('lists missing required readings', () => {
    const r = validateForm(fields, { superheat: '', hx: 'PASS' });
    expect(r.missing).toEqual(['Superheat', 'CO ambient']);
    expect(r.red_tag).toBe(false);
  });
  it('flags out-of-range readings and red tags (failed heat exchanger, high CO)', () => {
    const r = validateForm(fields, { superheat: 31, co: '40', hx: 'fail', filter: '14x20' });
    expect(r.out_of_range).toEqual([{ key: 'superheat', label: 'Superheat', value: 31, min: 5, max: 25, unit: '°F' }]);
    expect(r.red_tag).toBe(true);
    expect(r.red_tag_reason).toBe('CO ambient reading 40 ppm');
    expect(r.failed).toEqual(['hx']);
    expect(r.missing).toEqual(['Filter size (pick one of the choices)']);
  });
  it('a clean form passes', () => {
    expect(validateForm(fields, { superheat: 12, co: 0, hx: 'PASS' })).toEqual({ missing: [], out_of_range: [], failed: [], red_tag: false, red_tag_reason: null });
  });
});

describe('sales tax by line (FS-95)', () => {
  it('rounds each line half-up in integer cents', () => {
    expect(lineTax(10_000, 7)).toBe(700);
    expect(lineTax(1_250, 7)).toBe(88); // 87.5 → 88
    expect(lineTax(333, 6.5)).toBe(22); // 21.645 → 22
    expect(lineTax(-1_250, 7)).toBe(-88);
    expect(lineTax(10_000, 0)).toBe(0);
    expect(lineTax(123_456_789, 7.1234)).toBe(8_794_321); // 8 794 321.31 → 8 794 321
    expect(lineTax(50, 7)).toBe(4); // 3.5 → 4
  });
  it('parts, equipment and freight are taxable by default; labor is not', () => {
    expect(taxableByDefault('PART')).toBe(true);
    expect(taxableByDefault('EQUIPMENT')).toBe(true);
    expect(taxableByDefault('LABOR')).toBe(false);
  });
});

describe('nameplate serial year', () => {
  const today = new Date('2026-10-25T00:00:00Z');
  it.each([
    ['Carrier', '1209E12345', 2009], ['Trane', '2312ABC123', 2023], ['Goodman', '1805123456', 2018], ['Lennox', '5819A12345', 2019],
    ['Rheem', 'W031912345', 2019], ['Carrier', '4598E12345', 1998], ['Unknown Co', '1209E12345', null], ['Trane', 'AB12', null],
  ])('%s %s → %s', (make, serial, year) => expect(decodeSerialYear(make, serial, today)).toBe(year));
});

describe('voice note → structured notes (FS-30/31)', () => {
  it('sorts sentences and pulls readings', () => {
    const n = structureNote('Found the capacitor weak at 30 percent of rating. Replaced the run capacitor and tested the system. Superheat was 12.5 and subcool 9. I recommend replacing the contactor next visit.');
    expect(n.diagnosis).toContain('Found the capacitor weak');
    expect(n.work_performed).toContain('Replaced the run capacitor');
    expect(n.recommendations).toContain('I recommend replacing the contactor');
    expect(n.readings).toMatchObject({ superheat: 12.5, subcool: 9 });
    expect(n.customer_summary).toMatch(/^What we found: .*What we did: .*What we recommend: /);
    expect(n.customer_summary).not.toMatch(/superheat/i);
  });
  it('extracts static pressure and tags photos', () => {
    expect(extractReadings('static pressure was 0.9 inches')).toEqual({ static_pressure: 0.9 });
    expect(tagPhoto('Nameplate on the condenser, before cleaning')).toEqual(['nameplate', 'before']);
    expect(tagPhoto(null)).toEqual([]);
  });
});

describe('plain-language questions (FS-110)', () => {
  const today = '2026-10-25'; // a Sunday
  it('reads periods', () => {
    expect(parsePeriod('last month', today)).toEqual({ from: '2026-09-01', to: '2026-09-30', label: 'last month' });
    expect(parsePeriod('this week', today)).toEqual({ from: '2026-10-19', to: today, label: 'this week' });
    expect(parsePeriod('last 7 days', today)).toEqual({ from: '2026-10-19', to: today, label: 'last 7 days' });
    expect(parsePeriod('in december', today)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(parsePeriod('ever', today)).toBeNull();
  });
  it('maps a question to a metric with its threshold', () => {
    const q = parseQuestion('Which sold jobs ran under 40% margin last month?', today);
    expect(q).toMatchObject({ metric: 'low_margin_jobs', threshold: 0.4, from: '2026-09-01', to: '2026-09-30' });
    expect(parseQuestion('Which open estimates are older than 3 days?', today)).toMatchObject({ metric: 'open_estimates', threshold: 3 });
    expect(parseQuestion('How many calls did we miss today?', today).metric).toBe('missed_calls');
  });
  it('every catalog example answers its own metric', () => {
    for (const m of METRICS) expect(parseQuestion(m.example, today).metric, m.example).toBe(m.key);
  });
  it('an unknown question returns suggestions, not a guess', () => {
    const q = parseQuestion('what is the weather', today);
    expect(q.metric).toBeNull();
  });
});

describe('phone commands (FS-26)', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const wo = '22222222-2222-4222-8222-222222222222';
  const at = '2026-10-25T14:00:00Z';
  const now = new Date('2026-10-25T14:05:00Z');
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const port = (result: unknown | ((fn: string) => unknown)): FsRpc => (async <T,>(fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    const r = typeof result === 'function' ? (result as (fn: string) => unknown)(fn) : result;
    if (r instanceof Error) throw r;
    return r as T;
  }) as FsRpc;

  it('applies a voice note with the rules structuring and passes the command id', async () => {
    calls.length = 0;
    const r = await applyFsCommand(port({ id: 'n1' }), { id, at, kind: 'fs.note.save', workOrderId: wo, source: 'VOICE', transcript: 'Replaced the filter. Recommend a new thermostat.' }, now);
    expect(r).toMatchObject({ outcome: 'applied', serverId: 'n1' });
    expect(calls[0]!.fn).toBe('fs_save_visit_note');
    expect(calls[0]!.args).toMatchObject({ p_command: id, p_structured_by: 'RULES' });
    expect((calls[0]!.args.p_fields as Record<string, unknown>).work_performed).toBe('Replaced the filter.');
  });

  it('reports a replay as duplicate', async () => {
    const r = await applyFsCommand(port({ id: 'f1', duplicate: true, out_of_range: [], red_tag: false }),
      { id, at, kind: 'fs.form.submit', workOrderId: wo, templateId: wo, answers: { superheat: 12 } }, now);
    expect(r.outcome).toBe('duplicate');
  });

  it('decodes the serial year when no date was typed', async () => {
    calls.length = 0;
    const r = await applyFsCommand(port({ asset_id: 'a1', age_years: 7, parts_covered: false, labor_covered: false }),
      { id, at, kind: 'fs.equipment.upsert', workOrderId: wo, make: 'Goodman', serial: '1905123456' }, now);
    expect((calls[0]!.args.p_fields as Record<string, unknown>).manufactured_on).toBe('2019-01-01');
    expect(r).toMatchObject({ outcome: 'applied', serverId: 'a1', note: '7 years old · parts warranty expired' });
  });

  it('sells at the signing time: maps the deposit method, the add-ons and the signature photo; returns both times', async () => {
    calls.length = 0;
    const est = '77777777-7777-4777-8777-777777777777';
    const opt = '88888888-8888-4888-8888-888888888888';
    const r = await applyFsCommand(port({ estimate_id: est, lines: 3, agreement_id: null, deposit_request_id: 'd1', member_pricing: false,
      signed_at: '2026-10-25T13:58:00Z', received_at: '2026-10-25T14:05:00Z', signature: 'PENDING' }),
      { id, at, kind: 'fs.sell', estimateId: est, optionIds: [opt, opt], toggles: [{ itemId: wo, selected: true }], signedName: 'Pat',
        signedAt: '2026-10-25T13:58:00Z', signaturePhotoId: wo, depositCents: 50_000, depositMethod: 'link' }, now);
    expect(calls[0]!.fn).toBe('fs_field_sell');
    expect(calls[0]!.args).toMatchObject({ p_estimate: est, p_command: id, p_option_ids: [opt], p_signed_at: '2026-10-25T13:58:00Z',
      p_toggles: [{ item_id: wo, selected: true }], p_signature_photo: wo, p_deposit_cents: 50_000, p_request_deposit: true });
    expect(r).toMatchObject({ outcome: 'applied', serverId: est, data: { signedAt: '2026-10-25T13:58:00Z', receivedAt: '2026-10-25T14:05:00Z', depositRequestId: 'd1', signature: 'PENDING' } });
    expect(r.note).toMatch(/signature did not reach/);
    calls.length = 0;
    await applyFsCommand(port({ estimate_id: est, signed_at: at, received_at: at }), { id, at, kind: 'fs.sell', estimateId: est, optionIds: [opt], signedName: 'Pat', signedAt: at,
      depositCents: 20_000, depositMethod: 'check', depositRef: '1042' }, now);
    expect(calls[0]!.args).toMatchObject({ p_deposit_cents: 20_000, p_request_deposit: false, p_deposit_ref: 'Check 1042' });
    const noDeposit = await applyFsCommand(port({ estimate_id: est, signed_at: at, received_at: at }), { id, at, kind: 'fs.sell', estimateId: est, optionIds: [opt], signedName: 'Pat', signedAt: at, depositCents: 9 }, now);
    expect(noDeposit.outcome).toBe('applied');
    expect(calls[1]!.args).toMatchObject({ p_deposit_cents: 0, p_request_deposit: false });
  });

  it('refuses a sale signed in the future or more than 35 days ago, or without a signing time, before calling the server', async () => {
    calls.length = 0;
    const base = { id, at, kind: 'fs.sell', estimateId: wo, optionIds: [wo], signedName: 'Pat' };
    expect((await applyFsCommand(port({}), { ...base, signedAt: '2026-10-25T15:00:00Z' }, now)).code).toBe('CLOCK');
    expect((await applyFsCommand(port({}), { ...base, signedAt: '2026-09-01T15:00:00Z' }, now)).code).toBe('STALE');
    expect((await applyFsCommand(port({}), base, now)).code).toBe('INVALID');
    expect((await applyFsCommand(port({}), { id, at: '2026-09-01T10:00:00Z', kind: 'fs.note.save', workOrderId: wo }, now)).code).toBe('STALE');
    expect(calls).toHaveLength(0);
  });

  it('the pay link never carries a caller-chosen base URL (M1)', async () => {
    calls.length = 0;
    await applyFsCommand(port({ status: 'QUEUED', reason: null, message_id: 'm1' }), { id, at, kind: 'fs.paylink.send', reviewId: wo }, now);
    expect(calls[0]!.fn).toBe('fs_text_to_pay');
    expect(Object.keys(calls[0]!.args)).not.toContain('p_pay_base');
  });

  it('passes the nameplate photo command id and says when the upload has not arrived', async () => {
    calls.length = 0;
    const r = await applyFsCommand(port({ asset_id: 'a2', age_years: null, parts_covered: null, labor_covered: null, nameplate: 'PENDING' }),
      { id, at, kind: 'fs.equipment.upsert', workOrderId: wo, make: 'Trane', nameplatePhotoId: id }, now);
    expect(calls[0]!.args).toMatchObject({ p_nameplate_photo: id, p_nameplate_document: null });
    expect(r.note).toMatch(/nameplate photo not received yet/);
  });

  it('rejects bad input, unknown kinds and a phone clock that is ahead without calling the server', async () => {
    calls.length = 0;
    expect((await applyFsCommand(port({}), { id, at, kind: 'fs.willcall.pickup', commitmentId: wo, pickupCode: '12', lines: [] }, now)).outcome).toBe('rejected');
    expect((await applyFsCommand(port({}), { id, at, kind: 'fs.teleport' }, now)).code).toBe('UNKNOWN_KIND');
    expect((await applyFsCommand(port({}), { id, at: '2026-10-25T16:00:00Z', kind: 'fs.note.save', workOrderId: wo }, now)).code).toBe('CLOCK');
    expect((await applyFsCommand(port({}), { kind: 'fs.note.save' }, now)).code).toBe('INVALID');
    expect(calls).toHaveLength(0);
  });

  it('maps a database refusal to rejected and an outage to retry', async () => {
    const refused = await applyFsCommand(port(new PmQueryError('submit', { code: 'P0001', message: 'PM_FS_FORM_INCOMPLETE: Superheat' })),
      { id, at, kind: 'fs.form.submit', workOrderId: wo, templateId: wo, answers: {} }, now);
    expect(refused).toMatchObject({ outcome: 'rejected', code: 'PM_FS_FORM_INCOMPLETE' });
    const denied = await applyFsCommand(port(new HttpError(403, 'No access', 'FORBIDDEN')), { id, at, kind: 'fs.note.save', workOrderId: wo }, now);
    expect(denied.outcome).toBe('rejected');
    const down = await applyFsCommand(port(new Error('fetch failed')), { id, at, kind: 'fs.note.save', workOrderId: wo }, now);
    expect(down).toMatchObject({ outcome: 'retry', code: 'NETWORK' });
    const pg500 = await applyFsCommand(port(new PmQueryError('x', { code: '57014', message: 'canceling statement' })), { id, at, kind: 'fs.note.save', workOrderId: wo }, now);
    expect(pg500.outcome).toBe('retry');
  });
});

describe('widget challenge without a secret (security review round 2)', () => {
  const never = async () => { throw new Error('no network expected'); };
  it('passes in development and tests', async () => {
    expect(await verifyChallenge(undefined, null, {}, never, { production: false, explicitlyDisabled: false })).toEqual({ ok: true, mode: 'disabled' });
    expect(challengeRuntime({ NODE_ENV: 'test' })).toEqual({ production: false, explicitlyDisabled: false });
  });
  it('fails closed in production unless explicitly disabled', async () => {
    expect(challengeRuntime({ VERCEL_ENV: 'production' }).production).toBe(true);
    expect(challengeRuntime({ NODE_ENV: 'production', FS_TURNSTILE_DISABLED: '1' })).toEqual({ production: true, explicitlyDisabled: true });
    expect(await verifyChallenge('tok-1234567890', null, { secret: null }, never, { production: true, explicitlyDisabled: false })).toEqual({ ok: false, mode: 'failed' });
    expect(await verifyChallenge(undefined, null, {}, never, { production: true, explicitlyDisabled: true })).toEqual({ ok: true, mode: 'disabled' });
  });
});
