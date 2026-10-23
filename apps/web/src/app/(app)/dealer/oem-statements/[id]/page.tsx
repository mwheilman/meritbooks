export const dynamic = 'force-dynamic';

import { MatchingWorkspace } from './_components/matching-workspace';

export const metadata = { title: 'Manufacturer statement' };

/**
 * /dealer/oem-statements/[id] — the manufacturer credit-matching workspace
 * (FPB-dealer-pack §5 A3: propose; auto-settle only exact matches).
 */
export default function OemStatementPage({ params }: { params: { id: string } }) {
  return <MatchingWorkspace statementId={params.id} />;
}
