import { PageHeader } from '@/components/ui';
import { AccountTree } from './account-tree';

export default function ChartOfAccountsPage() {
  return (
    <>
      <PageHeader
        title="Chart of Accounts"
        description="Unified COA across all portfolio companies · 4 dimensions · 7 account types"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-ghost btn-sm">Export</button>
            <button className="btn-primary btn-sm">Request Account</button>
          </div>
        }
      />
      <AccountTree />
    </>
  );
}
