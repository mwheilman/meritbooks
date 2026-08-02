import { PageHeader } from '@/components/ui';
import { DebtRegister } from './debt-register';

export const metadata = {
  title: 'Debt & Loans',
};

export default function DebtPage() {
  return (
    <>
      <PageHeader
        title="Debt & Loans"
        description="Drop a loan document — AI extracts the terms, you confirm, and MeritBooks builds the amortization schedule and posts the interest accrual to the ledger"
      />
      <DebtRegister />
    </>
  );
}
