import { PageHeader } from '@/components/ui';
import { InsuranceDashboard } from './insurance-dashboard';

export const metadata = {
  title: 'Insurance',
};

export default function InsurancePage() {
  return (
    <>
      <PageHeader
        title="Insurance Register"
        description="Drop your own insurance policies — AI extracts carrier, coverage, limits, deductible, and premium for you to confirm. MeritBooks then tracks coverage and flags renewals before they lapse."
      />
      <InsuranceDashboard />
    </>
  );
}
