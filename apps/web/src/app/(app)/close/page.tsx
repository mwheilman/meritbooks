import { PageHeader } from '@/components/ui';
import { CloseGrid } from './close-grid';

export default function ClosePage() {
  return (
    <>
      <PageHeader
        title="Close Management"
        description="Month-end close across all entities — 3 phases per company"
      />
      <CloseGrid />
    </>
  );
}
