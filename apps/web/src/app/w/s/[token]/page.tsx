import { WorkforceReceipts } from '../../workforce-receipts';

export const dynamic = 'force-dynamic';

/**
 * /w/s/[token] — Merit Workforce from a receipt reminder (PUBLIC, no login). The token is
 * resolved server-side by its sha256 on every API call and narrows everything to ONE
 * cardholder (lib/receipts/links.ts). The page itself renders nothing tenant-specific until
 * the API answers.
 */
export default function WorkforceLinkPage({ params }: { params: { token: string } }) {
  return <WorkforceReceipts mode={{ kind: 'link', token: params.token }} />;
}
