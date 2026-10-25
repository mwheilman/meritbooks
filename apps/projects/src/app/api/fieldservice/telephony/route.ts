import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { fsCall } from '@/lib/fieldservice/rpc';
import { loadCallLog, loadPhoneProviders, rpcLoad } from '@/lib/fieldservice/completion';
import type { CallReportRow } from '@/lib/fieldservice/completion-types';
import { VOICE_PROVIDERS, voiceConfig, type VoiceProvider } from '@/lib/fieldservice/telephony';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Telephony and call tracking (FS-05). GET: the company's call log, its phone providers with
 * whether the server holds their credentials (never the credentials), and calls by campaign.
 * POST: switch a provider on / off (settings:configure; activation refused without credentials),
 * link a recorded call to the call / visit it booked. No money.
 */
const Q = z.object({ companyId: Uuid, from: Day.optional(), to: Day.optional() });

export const GET = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, query: Q }, async ({ db, tenant, query }) => {
  assertCompany(tenant, query.companyId);
  const [log, providers, report] = await Promise.all([
    loadCallLog(db, query.companyId),
    loadPhoneProviders(db, query.companyId),
    rpcLoad<{ rows: CallReportRow[] }>(db, 'fs_call_report', { p_location: query.companyId, p_from: query.from ?? null, p_to: query.to ?? null }, { rows: [] }),
  ]);
  return {
    calls: log.data, callsError: log.error,
    providers: VOICE_PROVIDERS.map((p: VoiceProvider) => ({ provider: p, connected: voiceConfig(p).configured, missing: voiceConfig(p).missing,
                                                          row: providers.data.find((r) => r.provider === p) ?? null })),
    report: report.data.rows, reportError: report.error,
  };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('provider'), companyId: Uuid, provider: z.enum(['RINGCENTRAL', 'DIALPAD', 'TWILIO_VOICE']), active: z.boolean(),
             mainNumbers: z.array(z.string().trim().min(7).max(20)).max(10).nullish(), label: Text(120).nullish(), recordCalls: z.boolean().nullish(),
             disclosure: Text(500).nullish() }),
  z.object({ op: z.literal('link'), callId: Uuid, serviceCallId: Uuid.nullish(), workOrderId: Uuid.nullish() }),
]);

export const POST = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, body: Body,
  ops: { provider: { cap: 'projects.settings', action: 'configure' } } }, async ({ db, body }) => {
  if (body.op === 'provider') {
    // UI-side gate only: the database turns a provider on only for numbers the platform verified (pm.fs_voice_numbers)
    if (body.active && !voiceConfig(body.provider).configured) {
      throw new HttpError(422, 'This phone provider is not connected yet — its credentials must be added to the server first.', 'PM_FS_PROVIDER_CREDENTIALS');
    }
    return fsCall(db, 'fs_set_phone_provider', {
      p_location: body.companyId, p_provider: body.provider, p_active: body.active,
      p_main_numbers: body.mainNumbers ?? null, p_label: body.label ?? null, p_record_calls: body.recordCalls ?? null, p_disclosure: body.disclosure ?? null,
    });
  }
  return { id: await fsCall<string>(db, 'fs_link_call', { p_call: body.callId, p_service_call: body.serviceCallId ?? null, p_work_order: body.workOrderId ?? null }) };
});
