export const dynamic = 'force-dynamic';

import { UnitDetail } from './unit-detail';

/**
 * One unit: header, cost build-up, floor-plan note history, sale / trade, documents
 * and every unit action (FPB §3.4–3.7). Guard + client scope: ../../layout.tsx.
 */
export default function UnitPage({ params }: { params: { id: string } }) {
  return <UnitDetail id={params.id} />;
}
