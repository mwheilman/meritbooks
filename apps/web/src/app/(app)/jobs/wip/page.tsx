import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { WipScheduleClient } from './wip-schedule-client';

export default function JobsWipPage() {
  // COMPANY-SCOPE CONTROL: WIP over/under billing is a per-company schedule.
  return (
    <CompanyScopeGuard>
      <WipScheduleClient />
    </CompanyScopeGuard>
  );
}
