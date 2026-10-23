import { WorkforceReceipts } from './workforce-receipts';

export const dynamic = 'force-dynamic';

/**
 * /w — Merit Workforce, signed in (Clerk; the middleware protects this path). Shows the
 * caller's own cards: charges that still need a receipt, recent receipts, capture.
 */
export default function WorkforceHome() {
  return <WorkforceReceipts mode={{ kind: 'me' }} />;
}
