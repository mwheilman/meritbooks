import { PageHeader } from '@/components/ui';
import { IntangiblesView } from './intangibles-view';

export const metadata = {
  title: 'Intangible Assets',
};

export default function IntangiblesPage() {
  return (
    <>
      <PageHeader
        title="Intangible Assets"
        description="Software, patents, customer lists and goodwill — MeritBooks amortizes finite-lived intangibles straight-line to the ledger and holds goodwill for impairment (ASC 350)"
      />
      <IntangiblesView />
    </>
  );
}
