import { PageHeader } from '@/components/ui';
import { CloseGrid } from './close-grid';

export default function CloseManagementPage() {
  return (
    <>
      <PageHeader
        title="Close Management"
        description="Month-end close across all 17 entities — 3 phases per company"
        actions={
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">March 2026</span>
            <button className="btn-primary btn-sm">Start Close</button>
          </div>
        }
      />
      <CloseGrid />
    </>
  );
}
