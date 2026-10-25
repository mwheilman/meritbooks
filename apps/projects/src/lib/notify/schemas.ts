/**
 * Request bodies for /api/notifications/* (Zod). Pure.
 */
import { z } from 'zod';
import { INTERNAL_EVENTS, NOTIFY_CHANNELS } from './recipes';

const uuid = z.string().uuid();
const clock = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a time like 22:00');
const tz = z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/, 'Pick a time zone').max(64);

export const InboxQuery = z.object({
  filter: z.enum(['unread', 'all', 'done']).default('all'),
  before: z.string().datetime({ offset: true }).optional(),
  jobId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const MarkBody = z
  .object({
    ids: z.array(uuid).max(500).default([]),
    state: z.enum(['read', 'unread', 'done', 'undone', 'read_all', 'done_all']),
  })
  .refine((b) => b.state === 'read_all' || b.state === 'done_all' || b.ids.length > 0, { message: 'Pick at least one notification', path: ['ids'] });

export const PrefsBody = z
  .object({
    rules: z
      .array(z.object({
        event_type: z.enum(INTERNAL_EVENTS),
        channel: z.enum(NOTIFY_CHANNELS),
        mode: z.enum(['instant', 'digest', 'off']).nullable(),
      }))
      .max(200)
      .default([])
      .refine((rs) => rs.every((r) => r.mode !== 'digest' || r.channel === 'email'), { message: 'Only email can be a digest' }),
    digest: z.enum(['instant', 'daily', 'weekly', 'off']).nullable().default(null),
    quietStart: clock.nullable().default(null),
    quietEnd: clock.nullable().default(null),
    timezone: tz.nullable().default(null),
    smsPhone: z.string().max(40).nullable().default(null),
    smsConsent: z.boolean().default(false),
  })
  .refine((b) => (b.quietStart === null) === (b.quietEnd === null), { message: 'Quiet hours need a start and an end', path: ['quietEnd'] })
  .refine((b) => !b.smsPhone || b.smsConsent, { message: 'Agree to receive work texts to add a number', path: ['smsConsent'] });

export const DeviceBody = z.object({
  token: z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/, 'Not an Expo push token'),
  platform: z.enum(['ios', 'android', 'web']),
  deviceName: z.string().max(120).nullable().default(null),
  appVersion: z.string().max(40).nullable().default(null),
});

export const DeviceDeleteBody = z.object({ token: DeviceBody.shape.token });

export const SettingsQuery = z.object({ companyId: uuid.optional() });

export const SettingsBody = z.object({
  companyId: uuid,
  patch: z
    .object({
      customer_messages_live: z.boolean(),
      sms_enabled: z.boolean(),
      mandatory_events: z.array(z.enum(INTERNAL_EVENTS)).max(INTERNAL_EVENTS.length),
      push_per_hour: z.number().int().min(1).max(120),
      sms_per_day: z.number().int().min(1).max(50),
      email_per_hour: z.number().int().min(1).max(200),
      customer_sms_per_day: z.number().int().min(1).max(20),
      lead_sla_minutes: z.number().int().min(5).max(10080),
      quiet_start: clock.nullable(),
      quiet_end: clock.nullable(),
      timezone: tz.nullable(),
    })
    .partial()
    .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to change' }),
});

export const SenderBody = z.object({ companyId: uuid, phone: z.string().min(7).max(40) });

export const HeldBody = z.object({
  ids: z.array(uuid).min(1).max(200),
  action: z.enum(['release', 'discard']),
});

export type PrefsBodyT = z.infer<typeof PrefsBody>;
export type SettingsBodyT = z.infer<typeof SettingsBody>;
