export const dynamic = 'force-dynamic';

import { DealView } from './deal-view';

export const metadata = { title: 'Deal detail' };

/**
 * Deal recap (FPB §3.4–3.5, DL-11; D2 slice A): what the customer owes, trade
 * valuation, estimated gross, and the approve / post / void / lien-payoff steps.
 * Guard + client scope: ../../layout.tsx.
 */
export default function DealPage({ params }: { params: { saleId: string } }) {
  return <DealView saleId={params.saleId} />;
}
