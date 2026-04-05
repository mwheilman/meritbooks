import { PageHeader } from '@/components/ui';
import { TeamDashboard } from './team-dashboard';

export default function TeamPage() {
  return (
    <>
      <PageHeader title="Team" description="Staff performance, utilization, and workload" />
      <TeamDashboard />
    </>
  );
}
