export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { DailyLogAction } from '@/lib/commercial/schemas';
import { cmError, cmRpc, cmWrote, loadDailyLog } from '@/lib/commercial/server';
import { parseTranscript, type DirectoryCompany } from '@/lib/commercial/voice';
import type { LogEntryRow } from '@/lib/commercial/types';

/** GET /api/commercial/daily-logs/:id — the log and its entries (amendments kept beside the original). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ db, params }) => {
  const r = await loadDailyLog(db, params.logId!);
  if (!r.log) throw new HttpError(404, 'That daily log was not found.', 'NOT_FOUND');
  return r;
});

function entryRow(e: Extract<ReturnType<typeof DailyLogAction.parse>, { op: 'entry' }>['entry']): Partial<LogEntryRow> {
  return {
    kind: e.kind, vendor_id: e.vendorId, company_name: e.companyName, trade: e.trade, headcount: e.headcount, hours: e.hours, equipment: e.equipment,
    equipment_hours: e.equipmentHours, supplier: e.supplier, description: e.description, cause: e.cause, duration_hours: e.durationHours,
    responsible_party: e.responsibleParty, notice_sent: e.noticeSent, inspector: e.inspector, result: e.result,
  };
}

/**
 * POST /api/commercial/daily-logs/:id — the super's day: header (weather, work performed),
 * entries (manpower by company, deliveries, delays with cause, inspections, equipment), sign
 * (locks it), amend after signing (kept with a reason), and the voice hook (transcript →
 * proposed entries → reviewed → applied).
 */
export const POST = route({
  access: { cap: 'projects.documents', action: 'edit' },
  ops: { entry: { cap: 'projects.documents', action: 'create' }, voice: { cap: 'projects.documents', action: 'create' }, apply_voice: { cap: 'projects.documents', action: 'create' } },
  mask: false,
  body: DailyLogAction,
}, async ({ db, body, params }) => {
  const id = params.logId!;
  const pm = db.schema('pm');
  switch (body.op) {
    case 'header':
      return cmWrote<{ id: string }>(await pm.from('cm_daily_logs').update({
        weather_summary: body.weatherSummary, temp_high_f: body.tempHighF, temp_low_f: body.tempLowF, precipitation: body.precipitation, wind: body.wind,
        site_conditions: body.siteConditions, work_performed: body.workPerformed, safety_notes: body.safetyNotes,
      }).eq('id', id).select('id').single());
    case 'entry':
      return cmWrote<{ id: string }>(await pm.from('cm_log_entries').insert({ daily_log_id: id, ...entryRow(body.entry) }).select('id').single());
    case 'remove_entry': {
      const res = await pm.from('cm_log_entries').delete().eq('id', body.entryId).eq('daily_log_id', id);
      if (res.error) throw cmError(res.error);
      return { ok: true };
    }
    case 'sign':
      return { id: await cmRpc<string>(db, 'cm_daily_log_sign', { p_log: id, p_signer_name: body.signerName }) };
    case 'amend': {
      const e = entryRow(body.entry);
      const entry = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null && v !== undefined));
      return { id: await cmRpc<string>(db, 'cm_daily_log_amend', { p_log: id, p_reason: body.reason, p_entry: entry }) };
    }
    case 'voice': {
      const log = await pm.from('cm_daily_logs').select('job_id').eq('id', id).maybeSingle();
      if (log.error) throw cmError(log.error);
      const jobId = (log.data as { job_id: string } | null)?.job_id;
      if (!jobId) throw new HttpError(404, 'That daily log was not found.', 'NOT_FOUND');
      const dir = await pm.from('cm_v_project_directory').select('vendor_id, company_name, trade').eq('job_id', jobId).limit(200);
      const directory: DirectoryCompany[] = ((dir.data ?? []) as Array<{ vendor_id: string | null; company_name: string | null; trade: string | null }>)
        .filter((d) => d.company_name).map((d) => ({ vendorId: d.vendor_id, name: d.company_name!, trade: d.trade }));
      const proposed = parseTranscript(body.transcript, directory);
      const v = cmWrote<{ id: string }>(await pm.from('cm_daily_log_voice').insert({ daily_log_id: id, transcript: body.transcript, language: body.language, proposed }).select('id').single());
      return { voiceId: v.id, proposed };
    }
    case 'apply_voice':
      return { applied: await cmRpc<number>(db, 'cm_daily_log_apply_voice', { p_voice: body.voiceId, p_entries: body.entries }) };
  }
});
