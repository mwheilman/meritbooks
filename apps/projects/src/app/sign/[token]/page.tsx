import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { openSigning, requestMeta } from '@/lib/esign/public';
import { SignPage } from '@/components/esign/SignPage';
import '@/components/documents/documents.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign a document', robots: { index: false, follow: false }, referrer: 'no-referrer' };

/**
 * PUBLIC signing page (no account; middleware lets /sign/* through). The token is the only
 * credential: esign.open (anon key, token-scoped definer function) returns this signer's view,
 * records the first open with IP and browser, and grants 10 minutes of read on the one document
 * (turned into a 10-minute signed URL here). A link that cannot act learns only why.
 */
export default async function SignTokenPage({ params }: { params: { token: string } }) {
  const { state, viewUrl } = await openSigning(params.token, requestMeta(headers()));
  return <SignPage token={params.token} initial={state} viewUrl={viewUrl} />;
}
