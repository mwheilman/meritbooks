import { Suspense } from 'react';
import { SalesTaxTabs } from './sales-tax-tabs';

// Sales Tax sub of the Tax hub. Reads `?tab=` (the /sales-tax-return and
// /sales-tax-calendar routes redirect here), so render inside a Suspense boundary.
export default function SalesTaxPage() {
  return (
    <Suspense fallback={null}>
      <SalesTaxTabs />
    </Suspense>
  );
}
