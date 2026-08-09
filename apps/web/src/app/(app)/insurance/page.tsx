import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { HubTabs } from '../_components/hub-tabs';
import { InsuranceDashboard } from './insurance-dashboard';

export const metadata = {
  title: 'Insurance',
};

export default function InsurancePage() {
  return (
    <>
      <PageHeader
        title="Insurance"
        description="Drop your own insurance policies — AI extracts carrier, coverage, limits, deductible, and premium for you to confirm. MeritBooks tracks coverage, flags renewals before they lapse, and amortizes each prepaid premium to insurance expense over its coverage term with a balanced journal entry."
      />
      <HubTabs section="assets" />
      <CompanyScopeGuard>
        <InsuranceDashboard />
      </CompanyScopeGuard>
    </>
  );
}
