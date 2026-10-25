import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import { CallLog } from '@/components/fieldservice/calls/CallLog';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadCallLog, loadPhoneProviders, nameMap, rpcLoad } from '@/lib/fieldservice/completion';
import type { CallReportRow } from '@/lib/fieldservice/completion-types';
import { VOICE_PROVIDERS, voiceConfig } from '@/lib/fieldservice/telephony';

export const metadata: Metadata = { title: 'Call log' };
export const dynamic = 'force-dynamic';

/** Telephony and call tracking (FS-05). */
export default async function CallLogPage() {
  const g = await fsPage([['projects.dispatch', 'view'], ['projects.leads', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Call log" /><OneCompany what="Calls and tracking numbers" /></Page></>);
  const pm = o.db.schema('pm');
  const [calls, providers, report, campaigns, serviceCalls] = await Promise.all([
    loadCallLog(o.db, companyId),
    loadPhoneProviders(o.db, companyId),
    rpcLoad<{ rows: CallReportRow[] }>(o.db, 'fs_call_report', { p_location: companyId, p_from: null, p_to: null }, { rows: [] }),
    pm.from('campaigns').select('id, name').eq('location_id', companyId),
    pm.from('service_calls').select('id, number, caller_name, caller_phone, created_at').eq('location_id', companyId).order('created_at', { ascending: false }).limit(60),
  ]);
  const customers = await nameMap(o.db, 'customers', calls.data.map((c) => c.customer_id));
  const company = o.companyName(companyId) ?? o.where;
  const missed = calls.data.filter((c) => ['MISSED', 'ABANDONED', 'VOICEMAIL'].includes(c.outcome)).length;
  return (
    <>
      <PageLine facts={[company, { label: `${count(calls.data.length)} calls`, strong: true }, ...(missed ? [`${count(missed)} missed`] : [])]} />
      <Page>
        <PageHead eyebrow={company} title="Call log" />
        <CallLog
          companyId={companyId}
          calls={calls.data}
          callsError={calls.error}
          providers={VOICE_PROVIDERS.map((p) => ({ provider: p, connected: voiceConfig(p).configured, missing: voiceConfig(p).missing, row: providers.data.find((r) => r.provider === p) ?? null }))}
          report={report.data.rows}
          customers={customers}
          campaigns={Object.fromEntries(((campaigns.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]))}
          serviceCalls={((serviceCalls.data ?? []) as Array<{ id: string; number: string | null; caller_name: string | null; caller_phone: string | null; created_at: string }>)
            .map((s) => ({ id: s.id, label: [s.number, s.caller_name ?? s.caller_phone, new Date(s.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · ') }))}
          canConfigure={g.can('projects.settings', 'configure')}
          canLink={g.can('projects.dispatch', 'edit') || g.can('projects.leads', 'create')}
        />
      </Page>
    </>
  );
}
