export const dynamic = "force-dynamic";
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { InvoiceManager } from './invoice-manager';

export default function InvoicesPage() {
  // COMPANY-SCOPE CONTROL: AR invoices are issued from one company's books.
  return (
    <CompanyScopeGuard>
      <InvoiceManager />
    </CompanyScopeGuard>
  );
}
