import { Suspense } from 'react';
import { VendorComplianceScreen } from './compliance-screen';

/**
 * VENDOR COMPLIANCE — the W-9 / COI closed loop (FPB-vendor-compliance-chase §19):
 * requirement sets per company, the compliance dashboard, the review queue, bank-change
 * call-backs and the automatic chase. Page-level RBAC (compliance:view) is in layout.tsx.
 */
export default function VendorCompliancePage() {
  return (
    <Suspense fallback={<p className="t-cap">Loading vendor compliance…</p>}>
      <VendorComplianceScreen />
    </Suspense>
  );
}
