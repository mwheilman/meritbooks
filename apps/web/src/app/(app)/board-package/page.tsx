import { PageHeader } from '@/components/ui';
import { BoardPackageViewer } from './board-package-viewer';

export const metadata = { title: 'Board package' };

export default function BoardPackagePage() {
  return (
    <>
      <PageHeader
        title="Board Package"
        description="Assemble a board-ready financial package — KPIs, statements, AI executive summary, and notes — and export it as a branded PDF"
      />
      <BoardPackageViewer />
    </>
  );
}
