import { describe, expect, it } from 'vitest';
import { formatClock, formatQuietHours, quietHoursSummary } from './quiet-display';
import type { PolicyContext } from './policy';

const org = {
  timezone: 'America/Chicago',
  chase_first_reminder_minutes: 30,
  chase_followup_minutes: 120,
  chase_escalation_threshold: 3,
  chase_quiet_start: '21:00:00',
  chase_quiet_end: '06:00:00',
  chase_channel: null,
};

describe('formatClock / formatQuietHours', () => {
  it('renders one 12-hour format everywhere', () => {
    expect(formatClock('20:00')).toBe('8 pm');
    expect(formatClock('07:00')).toBe('7 am');
    expect(formatClock('21:00:00')).toBe('9 pm');
    expect(formatClock('00:00')).toBe('12 am');
    expect(formatClock('12:00')).toBe('12 pm');
    expect(formatClock('07:30')).toBe('7:30 am');
    expect(formatQuietHours({ start: '20:00', end: '07:00' })).toBe('8 pm–7 am');
    expect(formatQuietHours(null)).toBe('none');
  });
});

describe('quietHoursSummary', () => {
  it('reads the vendor chase from the request default and the receipt chase from Settings → Receipt chase', () => {
    const ctx: PolicyContext = { org, rows: [] };
    const s = quietHoursSummary(ctx);
    expect(formatQuietHours(s.vendor)).toBe('8 pm–7 am'); // DEFAULT_QUIET
    expect(formatQuietHours(s.receipt)).toBe('9 pm–6 am'); // organizations.chase_quiet_*
    expect(s.receiptTimezone).toBe('America/Chicago');
  });

  it('a tenant default row changes the vendor quiet hours', () => {
    const ctx: PolicyContext = {
      org,
      rows: [{ policy_key: 'default', location_id: null, auto_create: false, cadence_anchor: null, cadence_offsets_minutes: null, repeat_every_minutes: null, max_sends: null, escalate_after: null, channels: null, quiet_start: '21:00', quiet_end: '06:00', timezone: null }],
    };
    expect(formatQuietHours(quietHoursSummary(ctx).vendor)).toBe('9 pm–6 am');
  });
});
