/**
 * The Merit Workforce ↔ Merit Projects field contract (apps/workforce/mobile/src/core/contract.ts
 * mirrors these shapes). Pure: Zod only, no server imports, so tests and the phone agree.
 *
 * Every write the phone makes is a COMMAND with a client-generated id (the idempotency key), the
 * ORIGINAL device timestamp, and the GPS fix at the moment it happened. The server applies each
 * command at most once (dedupe by command id) and answers one result per command.
 *
 * No money anywhere: no command or response carries a rate, cost, price or amount.
 */
import { z } from 'zod';

export const Uuid = z.string().uuid();
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-20');
export const Instant = z.string().datetime({ offset: true });
const Text = (max: number) => z.string().trim().max(max);

export const GeoZ = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).nullish(),
});
export type Geo = z.infer<typeof GeoZ>;

/** Fields every command carries. */
const Envelope = {
  /** Client command id: the idempotency key. */
  id: Uuid,
  /** When it happened on the phone (not when it synced). */
  at: Instant,
  /** IANA zone of the phone, for the work date of a shift. */
  tz: z.string().max(64).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/).nullish(),
  geo: GeoZ.nullish(),
  /** True when the phone had no connection when the command was made. */
  offline: z.boolean().optional(),
};

export const CLOCK_EVENTS = ['EN_ROUTE', 'IN', 'BREAK_START', 'BREAK_END', 'OUT', 'SWITCH'] as const;
export type ClockEvent = (typeof CLOCK_EVENTS)[number];
/** Events that close a working segment (and so produce a time entry). */
export const CLOSING_EVENTS: ReadonlySet<ClockEvent> = new Set(['BREAK_START', 'OUT', 'SWITCH']);

export const SegmentZ = z.object({
  /** The command that opened the segment (IN, BREAK_END or SWITCH). */
  startId: Uuid,
  startAt: Instant,
  startGeo: GeoZ.nullish(),
});

export const ClockZ = z.object({
  ...Envelope,
  kind: z.literal('clock'),
  event: z.enum(CLOCK_EVENTS),
  jobId: Uuid,
  costCodeId: Uuid.nullish(),
  assignmentId: Uuid.nullish(),
  /** Foreman crew clock: the crew members this punch is for (the foreman's own time is separate). */
  crewEmployeeIds: z.array(Uuid).max(50).optional(),
  segment: SegmentZ.nullish(),
  notes: Text(500).nullish(),
}).superRefine((c, ctx) => {
  if (CLOSING_EVENTS.has(c.event) && !c.segment) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['segment'], message: 'A clock-out or break needs the clock-in it closes.' });
  }
});

export const TimeUpdateZ = z.object({
  ...Envelope,
  kind: z.literal('time.update'),
  entryId: Uuid,
  hours: z.number().gt(0).max(24).optional(),
  costCodeId: Uuid.nullish(),
  workDate: Day.optional(),
  notes: Text(1000).nullish(),
});

export const TimeSubmitZ = z.object({
  ...Envelope,
  kind: z.literal('time.submit'),
  entryIds: z.array(Uuid).min(1).max(200),
});

export const SignatureZ = z.object({
  name: z.string().trim().min(1, 'Type your name to sign').max(120),
  /** SVG path data of the drawn signature (optional: a typed name is a signature too). */
  path: z.string().max(20_000).regex(/^[MLQCZmlqcz0-9.,\s-]*$/, 'Not a signature drawing').nullish(),
  signedAt: Instant,
});

export const WeatherZ = z.object({
  conditions: Text(80).nullish(),
  highF: z.number().int().min(-80).max(140).nullish(),
  lowF: z.number().int().min(-80).max(140).nullish(),
  precipitation: Text(40).nullish(),
  delay: z.boolean().optional(),
  source: z.enum(['auto', 'typed']).optional(),
});

export const LogSubmitZ = z.object({
  ...Envelope,
  kind: z.literal('log.submit'),
  jobId: Uuid,
  logDate: Day,
  logKind: z.enum(['DAILY', 'SAFETY', 'DELIVERY', 'VISIT']).default('DAILY'),
  body: Text(8000).nullish(),
  weather: WeatherZ.nullish(),
  crewCount: z.number().int().min(0).max(10_000).nullish(),
  hours: z.number().min(0).max(100_000).nullish(),
  signature: SignatureZ.nullish(),
});

export const CHECK_RESULTS = ['PASS', 'FAIL', 'NA'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const ChecklistSubmitZ = z.object({
  ...Envelope,
  kind: z.literal('checklist.submit'),
  jobId: Uuid,
  templateKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
  items: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
    result: z.enum(CHECK_RESULTS),
    note: Text(1000).nullish(),
    /** Photo command ids taken for this item (uploaded separately). */
    photoIds: z.array(Uuid).max(10).default([]),
  })).min(1).max(100),
  signature: SignatureZ.nullish(),
});

export const PunchCreateZ = z.object({
  ...Envelope,
  kind: z.literal('punch.create'),
  jobId: Uuid,
  title: z.string().trim().min(1, 'Say what needs fixing').max(200),
  description: Text(4000).nullish(),
  area: Text(120).nullish(),
  dueOn: Day.nullish(),
  /** Set when a failed checklist item created this punch. */
  fromChecklist: z.object({ commandId: Uuid, itemKey: z.string().max(48) }).nullish(),
});

export const CrewApproveZ = z.object({
  ...Envelope,
  kind: z.literal('crew.approve'),
  entryIds: z.array(Uuid).min(1).max(200),
});

/** Photo metadata (the bytes travel as multipart on /api/field/photos). */
export const PhotoMetaZ = z.object({
  ...Envelope,
  kind: z.literal('photo.upload'),
  jobId: Uuid,
  caption: Text(300).nullish(),
  /** Attach to a log, checklist or punch made on the phone (by ITS command id). */
  attachTo: z.object({ kind: z.enum(['log', 'checklist', 'punch']), commandId: Uuid }).nullish(),
});

/** Every JSON command (photos are multipart). */
export const CommandZ = z.union([ClockZ, TimeUpdateZ, TimeSubmitZ, LogSubmitZ, ChecklistSubmitZ, PunchCreateZ, CrewApproveZ]);
export type Command = z.infer<typeof CommandZ>;
export type ClockCommand = z.infer<typeof ClockZ>;
export type TimeUpdateCommand = z.infer<typeof TimeUpdateZ>;
export type TimeSubmitCommand = z.infer<typeof TimeSubmitZ>;
export type LogSubmitCommand = z.infer<typeof LogSubmitZ>;
export type ChecklistSubmitCommand = z.infer<typeof ChecklistSubmitZ>;
export type PunchCreateCommand = z.infer<typeof PunchCreateZ>;
export type CrewApproveCommand = z.infer<typeof CrewApproveZ>;
export type PhotoMeta = z.infer<typeof PhotoMetaZ>;
export type CommandKind = Command['kind'] | PhotoMeta['kind'];

export const MAX_BATCH = 50;

/** The envelope fields, for the v2 phone commands in phone-contract.ts. */
export const EnvelopeShape = Envelope;

/** POST /api/field/sync body. Commands are validated one by one so one bad command never sinks the batch. */
export const SyncBodyZ = z.object({
  deviceId: z.string().max(80).nullish(),
  commands: z.array(z.unknown()).min(1).max(MAX_BATCH),
});

/**
 * applied   — done now (serverId = the row it made or changed)
 * duplicate — this command id was already applied; nothing changed (safe re-send)
 * rejected  — will never apply as sent; `reason` says why in plain words (shown on the phone)
 * retry     — a passing failure (database busy, network); the phone keeps it and tries again
 */
export type CommandOutcome = 'applied' | 'duplicate' | 'rejected' | 'retry';

export interface CommandResult {
  id: string;
  kind: string;
  outcome: CommandOutcome;
  serverId?: string | null;
  /** Extra rows (crew clock makes one entry per person). */
  serverIds?: string[];
  code?: string;
  reason?: string;
  /** Something the person should know even though it worked ("recorded 0.3 mi from the site"). */
  note?: string;
}

export interface SyncResponse {
  results: CommandResult[];
  serverTime: string;
}
