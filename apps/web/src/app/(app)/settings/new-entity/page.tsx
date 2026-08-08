import { PageHeader } from '@/components/ui';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { NewEntityWizard } from './new-entity-wizard';

export const dynamic = 'force-dynamic';

export default async function NewEntityPage() {
  // Creating a book-of-record entity is an accounting-settings action.
  await requirePagePermission('settings_acct', 'edit');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Add Company"
        description="Set up a new entity — fiscal calendar, base currency, and a seeded chart of accounts"
      />
      <NewEntityWizard />
    </div>
  );
}
