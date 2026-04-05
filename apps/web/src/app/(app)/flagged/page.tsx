import { PageHeader } from '@/components/ui';
import { FlaggedQueue } from './flagged-queue';

export default function FlaggedPage() {
  return (
    <>
      <PageHeader
        title="Flagged Items"
        description="Transactions requiring manager judgment — AI or human flagged"
        actions={<button className="btn-primary btn-sm">Resolve All</button>}
      />
      <FlaggedQueue />
    </>
  );
}
