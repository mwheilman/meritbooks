import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { CapacitySetup } from '@/components/fieldservice/capacity/CapacitySetup';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadBookingSetup, loadCapacityLimits, loadDispatchExtras } from '@/lib/fieldservice/queries';
import { listEmployees } from '@/lib/pm/ops/field-queries';
import { addDays, todayIso } from '@/lib/time';

export const metadata: Metadata = { title: 'Capacity' };
export const dynamic = 'force-dynamic';

/** Dispatch setup: capacity by BU × zone × window, zones, windows, technicians, on call and time off, online booking. */
export default async function CapacityPage() {
  const g = await fsPage([['projects.dispatch', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Capacity" /><OneCompany what="Capacity, zones and arrival windows" /></Page></>);
  const today = todayIso();
  const [setup, limits, employees, extras, profiles] = await Promise.all([
    loadBookingSetup(o.db, [companyId]),
    loadCapacityLimits(o.db, companyId),
    listEmployees(o.db),
    loadDispatchExtras(o.db, [companyId], `${today}T00:00:00Z`, `${addDays(today, 14)}T23:59:59Z`),
    o.db.schema('pm').from('tech_profiles').select('employee_id, display_name, zone_ids, business_unit_ids, is_dispatchable, is_comfort_advisor').eq('location_id', companyId),
  ]);
  const company = o.companyName(companyId) ?? o.where;
  return (
    <>
      <PageLine facts={[company, { label: `${count(limits.length)} capacity limit(s)`, strong: true }, `${count(setup.zones.length)} zone(s)`]} />
      <Page>
        <PageHead eyebrow={company} title="Capacity" />
        <CapacitySetup
          companyId={companyId}
          today={today}
          setup={setup}
          limits={limits}
          employees={employees}
          profiles={(profiles.data ?? []) as Parameters<typeof CapacitySetup>[0]['profiles']}
          events={extras.events}
          onCall={extras.onCall}
          canEdit={g.can('projects.dispatch', 'edit')}
          canWidgets={g.can('projects.settings', 'configure')}
        />
      </Page>
    </>
  );
}
