import { Suspense } from 'react';
import { DealerReportsClient } from './dealer-reports-client';

/** /dealer/reports — Dealer Pack reports R1–R8 (FPB-dealer-pack §7). */
export default function DealerReportsPage() {
  return (
    <Suspense fallback={null}>
      <DealerReportsClient />
    </Suspense>
  );
}
