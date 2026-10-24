import { requirePagePermission } from '@/lib/rbac/page-guard';
import { ReportingCalendar } from './reporting-calendar';

export const dynamic = 'force-dynamic';

/**
 * /reporting-calendar — number governance (Wave 3D, FPB-tenant-model-consolidation-analytics
 * §18): which months partners, lenders and department heads can see, per company; release and
 * take back; the auto-release rule; restatements; freshness and reporting deadlines.
 *
 * PAGE-LEVEL RBAC: close-management view. Every write route re-checks close_mgmt:manage.
 */
export default async function ReportingCalendarPage() {
  await requirePagePermission('close_mgmt', 'view');
  return <ReportingCalendar />;
}
