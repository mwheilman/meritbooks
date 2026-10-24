/**
 * Apply one field command, at most once. Every handler: check age → load the job the caller's
 * RLS can see → check the grant AT the job's company → dedupe by the command id → write →
 * one CommandResult. Failures never throw out of here: a refusal becomes `rejected` with a plain
 * reason the phone shows; a passing failure becomes `retry` so the phone keeps the command.
 *
 * Pure apart from the injected FieldStore (unit-tested with an in-memory store).
 */
import { HttpError, PmQueryError, mapPgError } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import { forbiddenBody } from '@/lib/access/guard';
import type { Access, AccessAction, ProjectCapability } from '@/lib/access/types';
import {
  CLOSING_EVENTS, ChecklistSubmitZ, ClockZ, CrewApproveZ, LogSubmitZ, PunchCreateZ, TimeSubmitZ, TimeUpdateZ,
  type ChecklistSubmitCommand, type ClockCommand, type CommandResult, type CrewApproveCommand, type LogSubmitCommand,
  type PhotoMeta, type PunchCreateCommand, type TimeSubmitCommand, type TimeUpdateCommand,
} from './contract';
import {
  assignmentMove, checkAge, checkChecklist, decideTimeChange, geoStatus, geoText, isTimeZone, localDay, planApprove, planSubmit,
  segmentHours, segmentNote, type Rejection,
} from './rules';
import { checklistSummary, templateByKey } from './checklists';
import { DuplicateRowError, type DocSubject, type FieldJob, type FieldStore } from './store-types';
import { PHOTO_MAX_BYTES, sniffPhoto } from './sniff';

export interface FieldCtx {
  store: FieldStore;
  access: Access;
  userId: string;
  orgId: string;
  /** Company names for refusals ("…at Heartland"). */
  companyName: (id: string) => string | null;
  now: Date;
  /** Fallback time zone for the work date when the phone sends none. */
  defaultTz: string;
}

const SOURCE = 'merit_workforce';

function rejected(id: string, kind: string, r: Rejection): CommandResult {
  return { id, kind, outcome: 'rejected', code: r.code, reason: r.reason };
}

/** Map a thrown error to a result: 4xx refusals are final, the rest is retried. */
export function failure(id: string, kind: string, e: unknown): CommandResult {
  if (e instanceof DuplicateRowError) return { id, kind, outcome: 'duplicate' };
  if (e instanceof HttpError) {
    return e.status >= 400 && e.status < 500 && e.status !== 429
      ? { id, kind, outcome: 'rejected', code: e.code, reason: e.message }
      : { id, kind, outcome: 'retry', code: e.code, reason: e.message };
  }
  if (e instanceof PmQueryError) {
    const m = mapPgError(e.pg);
    return m.status < 500
      ? { id, kind, outcome: 'rejected', code: m.body.code, reason: m.body.error }
      : { id, kind, outcome: 'retry', code: m.body.code, reason: 'The server could not save this yet. It will be sent again.' };
  }
  return { id, kind, outcome: 'retry', code: 'NETWORK', reason: 'The server could not save this yet. It will be sent again.' };
}

function grantRefusal(ctx: FieldCtx, cap: ProjectCapability, action: AccessAction, companyId: string, code: string): Rejection | null {
  if (can(ctx.access, cap, action, companyId)) return null;
  return { code, reason: forbiddenBody(cap, action, ctx.companyName(companyId)).error };
}

const NO_JOB: Rejection = { code: 'JOB_NOT_FOUND', reason: 'That job is not on your list any more. Ask the office if you still work on it.' };

async function jobFor(ctx: FieldCtx, jobId: string): Promise<FieldJob | Rejection> {
  const j = await ctx.store.job(jobId);
  return j ?? NO_JOB;
}

const isRejection = (v: unknown): v is Rejection => typeof v === 'object' && v !== null && 'reason' in v && 'code' in v && !('jobId' in v);

function tzOf(ctx: FieldCtx, tz: string | null | undefined): string {
  return isTimeZone(tz) ? tz : ctx.defaultTz;
}

// ------------------------------------------------------------------------------------- clock

export async function applyClock(ctx: FieldCtx, c: ClockCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const job = await jobFor(ctx, c.jobId);
  if (isRejection(job)) return rejected(c.id, c.kind, job);
  const crew = (c.crewEmployeeIds ?? []).length > 0;
  const g = crew
    ? grantRefusal(ctx, 'projects.time', 'approve', job.companyId, 'CREW_CLOCK_NOT_ALLOWED')
    : grantRefusal(ctx, 'projects.time', 'create', job.companyId, 'FORBIDDEN');
  if (g) return rejected(c.id, c.kind, crew ? { code: g.code, reason: 'Only a supervisor can clock in a crew. Each person can clock in on their own phone.' } : g);

  const site = { lat: job.siteLat, lng: job.siteLng };
  const notes: string[] = [];
  let serverId: string | null = null;

  // "On my way" / clock in move the visit on the dispatch board. A refusal there never loses the punch.
  if (c.assignmentId && (c.event === 'EN_ROUTE' || c.event === 'IN')) {
    try {
      const a = await ctx.store.assignment(c.assignmentId);
      if (a && a.job_id === job.jobId) {
        const move = assignmentMove(a.status, c.event);
        if (move) await ctx.store.setAssignmentStatus(a.id, move);
        serverId = a.id;
      }
    } catch (e) {
      const f = failure(c.id, c.kind, e);
      if (f.outcome === 'retry') return f;
      notes.push(`The visit status did not change: ${f.reason ?? 'not allowed'}`);
    }
  }

  if (!CLOSING_EVENTS.has(c.event)) {
    if (c.event === 'IN') notes.unshift(`Clocked in ${geoText(geoStatus(site, c.geo))}.`);
    return { id: c.id, kind: c.kind, outcome: 'applied', serverId, note: notes.join(' ') || undefined };
  }

  // A closing punch (break, clock out, switch job) turns the open segment into a DRAFT time entry.
  const seg = c.segment!;
  const startAge = checkAge(seg.startAt, ctx.now);
  if (startAge) return rejected(c.id, c.kind, startAge);
  const h = segmentHours(seg.startAt, c.at);
  if (!h.ok) return rejected(c.id, c.kind, h);
  if (h.tooShort) return { id: c.id, kind: c.kind, outcome: 'applied', serverId: null, note: 'Less than a minute on the clock, so no time was recorded.' };

  const tz = tzOf(ctx, c.tz);
  const workDate = localDay(seg.startAt, tz);
  const me = await ctx.store.me();
  const startGeo = geoStatus(site, seg.startGeo);
  const endGeo = geoStatus(site, c.geo);
  const note = segmentNote({
    startAt: seg.startAt, endAt: c.at, tz, endEvent: c.event, startGeo, endGeo, offline: !!c.offline,
    crewBy: crew ? me?.name ?? null : null, extra: c.notes ?? null,
  });

  const people: Array<{ employeeId: string | null; userId: string | null; ref: string }> = crew
    ? [...new Set(c.crewEmployeeIds)].map((e) => ({ employeeId: e, userId: null, ref: `wf:seg:${seg.startId}:${e}` }))
    : [{ employeeId: me?.employeeId ?? null, userId: me?.employeeId ? null : ctx.userId, ref: `wf:seg:${seg.startId}` }];

  const ids: string[] = [];
  let changed = 0;
  for (const p of people) {
    const existing = await ctx.store.timeBySourceRef(p.ref);
    if (existing) {
      // Re-sent punch, or a corrected clock-out for the same clock-in: the field's times win until approved.
      const d = decideTimeChange(existing, { hours: h.hours, cost_code_id: c.costCodeId ?? null, work_date: workDate });
      if (d.action === 'reject') return rejected(c.id, c.kind, d);
      if (d.action === 'apply') {
        await ctx.store.updateTime(existing.id, { ...d.patch, notes: note });
        changed += 1;
      }
      ids.push(existing.id);
      continue;
    }
    try {
      ids.push(await ctx.store.insertTime({
        job_id: job.jobId, employee_id: p.employeeId, user_id: p.userId, work_date: workDate, hours: h.hours,
        cost_code_id: c.costCodeId ?? null, notes: note, source_ref: p.ref,
      }));
      changed += 1;
    } catch (e) {
      if (!(e instanceof DuplicateRowError)) throw e;
      const again = await ctx.store.timeBySourceRef(p.ref);
      if (again) ids.push(again.id);
    }
  }
  if (endGeo.kind === 'away') notes.push(`Clocked out ${geoText(endGeo)}; your supervisor will see it flagged.`);
  return {
    id: c.id, kind: c.kind, outcome: changed ? 'applied' : 'duplicate', serverId: ids[0] ?? null, serverIds: ids,
    note: notes.join(' ') || undefined,
  };
}

// -------------------------------------------------------------------------------------- time

export async function applyTimeUpdate(ctx: FieldCtx, c: TimeUpdateCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const [row] = await ctx.store.timeByIds([c.entryId]);
  if (!row) return rejected(c.id, c.kind, { code: 'TIME_NOT_FOUND', reason: 'That time entry was not found. The office may have deleted it.' });
  const job = await jobFor(ctx, row.job_id);
  if (isRejection(job)) return rejected(c.id, c.kind, job);
  const g = grantRefusal(ctx, 'projects.time', 'edit', job.companyId, 'FORBIDDEN');
  if (g) return rejected(c.id, c.kind, g);
  const d = decideTimeChange(row, {
    ...(c.hours !== undefined ? { hours: Math.round(c.hours * 100) / 100 } : {}),
    ...(c.costCodeId !== undefined ? { cost_code_id: c.costCodeId ?? null } : {}),
    ...(c.workDate !== undefined ? { work_date: c.workDate } : {}),
    ...(c.notes !== undefined ? { notes: c.notes ?? null } : {}),
  });
  if (d.action === 'reject') return rejected(c.id, c.kind, d);
  if (d.action === 'duplicate') return { id: c.id, kind: c.kind, outcome: 'duplicate', serverId: row.id };
  await ctx.store.updateTime(row.id, d.patch);
  return { id: c.id, kind: c.kind, outcome: 'applied', serverId: row.id };
}

export async function applyTimeSubmit(ctx: FieldCtx, c: TimeSubmitCommand): Promise<CommandResult> {
  const me = await ctx.store.me();
  const rows = (await ctx.store.timeByIds(c.entryIds)).filter((r) => (me?.employeeId && r.employee_id === me.employeeId) || r.user_id === ctx.userId);
  const plan = planSubmit(c.entryIds, rows);
  if (!plan.submit.length) {
    if (plan.already.length && !plan.locked.length && !plan.missing.length) return { id: c.id, kind: c.kind, outcome: 'duplicate' };
    if (plan.already.length || plan.locked.length) return { id: c.id, kind: c.kind, outcome: 'duplicate', note: 'This time was already submitted or approved.' };
    return rejected(c.id, c.kind, { code: 'TIME_NOT_FOUND', reason: 'None of that time is yours to submit.' });
  }
  const n = await ctx.store.submitTime(plan.submit);
  const skipped = plan.locked.length + plan.missing.length;
  return {
    id: c.id, kind: c.kind, outcome: 'applied', serverIds: plan.submit,
    note: `Sent ${n} ${n === 1 ? 'entry' : 'entries'} to your supervisor.${skipped ? ` ${skipped} could not be sent (approved, voided or not yours).` : ''}`,
  };
}

export async function applyCrewApprove(ctx: FieldCtx, c: CrewApproveCommand): Promise<CommandResult> {
  if (!can(ctx.access, 'projects.time', 'approve')) return rejected(c.id, c.kind, { code: 'FORBIDDEN', reason: forbiddenBody('projects.time', 'approve').error });
  const rows = await ctx.store.timeByIds(c.entryIds);
  const plan = planApprove(c.entryIds, rows);
  if (!plan.approve.length) {
    if (plan.already.length) return { id: c.id, kind: c.kind, outcome: 'duplicate', note: 'Already approved.' };
    return rejected(c.id, c.kind, { code: 'NOTHING_TO_APPROVE', reason: 'None of this time is waiting for approval any more.' });
  }
  const n = await ctx.store.approveTime(plan.approve);
  const skipped = plan.notSubmitted.length + plan.missing.length;
  return {
    id: c.id, kind: c.kind, outcome: 'applied', serverIds: plan.approve,
    note: `Approved ${n} ${n === 1 ? 'entry' : 'entries'}.${skipped ? ` ${skipped} were not submitted or are gone.` : ''}`,
  };
}

// --------------------------------------------------------------------------------- daily log

function weatherJson(w: LogSubmitCommand['weather']): Record<string, unknown> | null {
  if (!w) return null;
  const out: Record<string, unknown> = {};
  if (w.conditions) out.conditions = w.conditions;
  if (w.highF != null) out.high_f = w.highF;
  if (w.lowF != null) out.low_f = w.lowF;
  if (w.precipitation) out.precipitation = w.precipitation;
  if (w.delay) out.delay = true;
  if (w.source) out.source = w.source;
  return Object.keys(out).length ? out : null;
}

/**
 * The system keys a field write puts in `ext`. pm.validate_ext (1100) refuses any top-level ext
 * key that is not a company-defined field unless it starts with "_" — so every key here does.
 */
export function captured(c: { id: string; at: string; geo?: { lat: number; lng: number; accuracyM?: number | null } | null; offline?: boolean }): Record<string, unknown> {
  return {
    _client_command_id: c.id,
    _source: SOURCE,
    _captured_at: c.at,
    ...(c.geo ? { _geo: { lat: c.geo.lat, lng: c.geo.lng, accuracy_m: c.geo.accuracyM ?? null } } : {}),
    ...(c.offline ? { _offline: true } : {}),
  };
}

export async function applyLog(ctx: FieldCtx, c: LogSubmitCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const job = await jobFor(ctx, c.jobId);
  if (isRejection(job)) return rejected(c.id, c.kind, job);
  const g = grantRefusal(ctx, 'projects.documents', 'create', job.companyId, 'FORBIDDEN');
  if (g) return rejected(c.id, c.kind, g);
  const dup = await ctx.store.logByCommand(c.id);
  if (dup) return { id: c.id, kind: c.kind, outcome: 'duplicate', serverId: dup.id };
  const weather = weatherJson(c.weather);
  if (!c.body && c.crewCount == null && c.hours == null && !weather && !c.signature) {
    return rejected(c.id, c.kind, { code: 'VALIDATION', reason: 'Say what happened today, or record the crew, hours or weather.' });
  }
  const id = await ctx.store.insertLog({
    job_id: job.jobId, log_date: c.logDate, kind: c.logKind, body: c.body || null, weather,
    crew_count: c.crewCount ?? null, hours: c.hours ?? null,
    ext: { ...captured(c), ...(c.signature ? { _signature: { name: c.signature.name, path: c.signature.path ?? null, signed_at: c.signature.signedAt } } : {}) },
  });
  return { id: c.id, kind: c.kind, outcome: 'applied', serverId: id };
}

// --------------------------------------------------------------------------------- checklist

export async function applyChecklist(ctx: FieldCtx, c: ChecklistSubmitCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const t = templateByKey(c.templateKey);
  if (!t) return rejected(c.id, c.kind, { code: 'CHECKLIST_UNKNOWN', reason: 'This checklist is no longer offered. Open the list again.' });
  const job = await jobFor(ctx, c.jobId);
  if (isRejection(job)) return rejected(c.id, c.kind, job);
  const g = grantRefusal(ctx, 'projects.documents', 'create', job.companyId, 'FORBIDDEN');
  if (g) return rejected(c.id, c.kind, g);
  const dup = await ctx.store.logByCommand(c.id);
  if (dup) return { id: c.id, kind: c.kind, outcome: 'duplicate', serverId: dup.id };
  const check = checkChecklist(t.items, c.items.map((i) => ({ key: i.key, result: i.result, note: i.note, photoIds: i.photoIds })), (k) => t.items.find((i) => i.key === k)?.text.en ?? k);
  if (!check.ok) return rejected(c.id, c.kind, check);
  const id = await ctx.store.insertLog({
    job_id: job.jobId, log_date: localDay(c.at, tzOf(ctx, c.tz)), kind: t.logKind,
    body: checklistSummary(t, check, check.failed), weather: null, crew_count: null, hours: null,
    ext: {
      ...captured(c),
      _checklist: {
        template_key: t.key, title: t.title.en,
        counts: { pass: check.pass, fail: check.fail, na: check.na },
        items: c.items.map((i) => ({ key: i.key, result: i.result, note: i.note ?? null, photo_command_ids: i.photoIds })),
      },
      ...(c.signature ? { _signature: { name: c.signature.name, path: c.signature.path ?? null, signed_at: c.signature.signedAt } } : {}),
    },
  });
  return {
    id: c.id, kind: c.kind, outcome: 'applied', serverId: id,
    note: check.fail ? `${check.fail} failed ${check.fail === 1 ? 'item' : 'items'} will be added to the punch list.` : undefined,
  };
}

// ------------------------------------------------------------------------------------- punch

export async function applyPunch(ctx: FieldCtx, c: PunchCreateCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const job = await jobFor(ctx, c.jobId);
  if (isRejection(job)) return rejected(c.id, c.kind, job);
  // RLS on pm.punch_items requires projects.jobs:create on the job (1110 class J, write cap projects.jobs).
  // Supervisors hold it (1111); crew members do not, so their checklist failures stay on the checklist.
  if (!can(ctx.access, 'projects.jobs', 'create', job.companyId)) {
    return rejected(c.id, c.kind, {
      code: 'PUNCH_NOT_ALLOWED',
      reason: c.fromChecklist
        ? 'Your role can’t add punch items. The failed item is saved on the checklist, so your supervisor can see it.'
        : 'Your role can’t add punch items. Tell your supervisor, or add it to today’s log.',
    });
  }
  const dup = await ctx.store.punchByCommand(c.id);
  if (dup) return { id: c.id, kind: c.kind, outcome: 'duplicate', serverId: dup.id };
  const id = await ctx.store.insertPunch({
    job_id: job.jobId, title: c.title, description: c.description || null, area: c.area || null, due_on: c.dueOn ?? null,
    ext: { ...captured(c), ...(c.fromChecklist ? { _from_checklist: { command_id: c.fromChecklist.commandId, item_key: c.fromChecklist.itemKey } } : {}) },
  });
  return { id: c.id, kind: c.kind, outcome: 'applied', serverId: id };
}

// ------------------------------------------------------------------------------------- photo

export { PHOTO_MAX_BYTES } from './sniff';

/**
 * One photo. The type comes from the file's own bytes (sniffPhoto), never the client's MIME; the
 * route has already refused bodies over the cap before parsing. A photo can attach only to a
 * log, checklist or punch item ON THE SAME JOB as the photo command.
 */
export async function applyPhoto(ctx: FieldCtx, m: PhotoMeta, file: { bytes: ArrayBuffer; name: string }): Promise<CommandResult> {
  const age = checkAge(m.at, ctx.now);
  if (age) return rejected(m.id, m.kind, age);
  if (file.bytes.byteLength === 0) return rejected(m.id, m.kind, { code: 'VALIDATION', reason: 'The photo file is empty. Take it again.' });
  if (file.bytes.byteLength > PHOTO_MAX_BYTES) return rejected(m.id, m.kind, { code: 'PHOTO_TOO_LARGE', reason: 'That photo is over 12 MB. Take it at a lower resolution.' });
  const kind = sniffPhoto(file.bytes);
  if (!kind) return rejected(m.id, m.kind, { code: 'PHOTO_TYPE', reason: 'That file is not a photo. Photos must be JPEG, PNG, WebP or HEIC.' });
  const job = await jobFor(ctx, m.jobId);
  if (isRejection(job)) return rejected(m.id, m.kind, job);
  const g = grantRefusal(ctx, 'projects.documents', 'create', job.companyId, 'FORBIDDEN');
  if (g) return rejected(m.id, m.kind, g);

  // Attach to the log, checklist or punch it was taken for — when that has reached the server,
  // and only when it belongs to this same job.
  let subject: DocSubject = { table: 'projects', id: job.jobId };
  let note: string | undefined;
  if (m.attachTo) {
    const target = m.attachTo.kind === 'punch' ? await ctx.store.punchByCommand(m.attachTo.commandId) : await ctx.store.logByCommand(m.attachTo.commandId);
    if (target && target.jobId !== job.jobId) {
      return rejected(m.id, m.kind, { code: 'ATTACH_JOB_MISMATCH', reason: 'This photo was taken for a different job than the one it was sent with. Take it again from that job.' });
    }
    if (target) subject = { table: m.attachTo.kind === 'punch' ? 'punch_items' : 'field_logs', id: target.id };
    else note = 'Saved to the job’s photos (what it was taken for did not reach the office).';
  }

  const path = `${ctx.orgId}/projects/field/${job.jobId}/${m.id}.${kind.ext}`;
  const existing = await ctx.store.documentByPath(path);
  if (existing) return { id: m.id, kind: m.kind, outcome: 'duplicate', serverId: existing };
  await ctx.store.uploadObject(path, file.bytes, kind.mime); // 'exists' = an earlier try uploaded the bytes; record it now
  const base = (file.name || 'photo').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\w .-]/g, '_').slice(0, 180) || 'photo';
  const docId = await ctx.store.insertDocument({
    storage_path: path, file_name: `${base}.${kind.ext}`, mime_type: kind.mime, size_bytes: file.bytes.byteLength,
    entity_type: `pm.${subject.table}`, entity_id: subject.id, notes: m.caption || null,
  });
  await ctx.store.linkDocument(docId, job.jobId, subject, 'photo');
  return { id: m.id, kind: m.kind, outcome: 'applied', serverId: docId, note };
}

// ------------------------------------------------------------------------------------ dispatch

const SCHEMAS = {
  clock: ClockZ, 'time.update': TimeUpdateZ, 'time.submit': TimeSubmitZ, 'log.submit': LogSubmitZ,
  'checklist.submit': ChecklistSubmitZ, 'punch.create': PunchCreateZ, 'crew.approve': CrewApproveZ,
} as const;
type JsonKind = keyof typeof SCHEMAS;

function idOf(raw: unknown): string {
  const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id.slice(0, 64) : '';
}

/** Validate one raw command and apply it. Never throws. */
export async function applyRaw(ctx: FieldCtx, raw: unknown): Promise<CommandResult> {
  const id = idOf(raw);
  const kind = typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
  if (typeof kind !== 'string' || !(kind in SCHEMAS)) {
    return { id, kind: typeof kind === 'string' ? kind.slice(0, 40) : 'unknown', outcome: 'rejected', code: 'UNKNOWN_KIND', reason: 'This app version sent something the server does not understand. Update Merit Workforce.' };
  }
  const k = kind as JsonKind;
  const parsed = SCHEMAS[k].safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { id, kind: k, outcome: 'rejected', code: 'VALIDATION', reason: first ? `${first.message}${first.path.length ? ` (${first.path.join('.')})` : ''}` : 'Check the values and try again.' };
  }
  try {
    const c = parsed.data;
    switch (c.kind) {
      case 'clock': return await applyClock(ctx, c);
      case 'time.update': return await applyTimeUpdate(ctx, c);
      case 'time.submit': return await applyTimeSubmit(ctx, c);
      case 'log.submit': return await applyLog(ctx, c);
      case 'checklist.submit': return await applyChecklist(ctx, c);
      case 'punch.create': return await applyPunch(ctx, c);
      case 'crew.approve': return await applyCrewApprove(ctx, c);
    }
  } catch (e) {
    return failure(id, k, e);
  }
}

/** Apply a batch in order (later commands may depend on earlier ones). Duplicate ids in one batch apply once. */
export async function applyBatch(ctx: FieldCtx, raws: ReadonlyArray<unknown>): Promise<CommandResult[]> {
  const out: CommandResult[] = [];
  const seen = new Map<string, CommandResult>();
  for (const raw of raws) {
    const id = idOf(raw);
    const prior = id ? seen.get(id) : undefined;
    if (prior) {
      out.push(prior.outcome === 'applied' ? { ...prior, outcome: 'duplicate', note: undefined } : prior);
      continue;
    }
    const r = await applyRaw(ctx, raw);
    if (id) seen.set(id, r);
    out.push(r);
  }
  return out;
}
