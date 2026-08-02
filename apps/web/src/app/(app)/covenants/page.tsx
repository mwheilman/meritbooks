import { PageHeader } from '@/components/ui';
import { CovenantsDashboard } from './covenants-dashboard';

export const metadata = {
  title: 'Covenant Monitor',
};

export default function CovenantsPage() {
  return (
    <>
      <PageHeader
        title="Covenant Monitor"
        description="Track loan covenants against the live ledger — current headroom, trend, and the projected breach date off your cash forecast"
      />
      <CovenantsDashboard />
    </>
  );
}
