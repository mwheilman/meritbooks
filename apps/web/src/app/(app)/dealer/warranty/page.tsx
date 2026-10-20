export const dynamic = 'force-dynamic';

import { Suspense } from 'react';
import { Spinner } from '../_components/ui';
import { WarrantyWorkspace } from './_components/warranty-workspace';

/**
 * /dealer/warranty — manufacturer warranty claims (FPB-dealer-pack §3.8, DL-5/DL-6).
 * The dealer layout already guards the page (journal_entries:view) and the client
 * scope; every write is re-authorized by the D1 routes.
 */
export default function WarrantyPage() {
  return (
    <Suspense fallback={<Spinner label="Loading warranty claims…" />}>
      <WarrantyWorkspace />
    </Suspense>
  );
}
