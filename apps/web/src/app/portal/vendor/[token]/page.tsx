export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { createAdminSupabase } from '@/lib/supabase/server';
import { validatePortalToken, PORTAL_DOC_LABEL, type PortalDocKind } from '@/lib/portal/vendor/tokens';
import { VendorPortalClient } from './upload-portal';

/**
 * Vendor self-service upload portal — PUBLIC, tokenized, no login. A branded page
 * where a vendor uploads the W-9 / COI / banking details a company requested. The
 * token is validated server-side (service role); an invalid/expired/revoked link
 * renders a clean, non-leaky message. On success the file lands for human review —
 * nothing about the vendor's status changes automatically.
 */
export default async function VendorPortalPage({ params }: { params: { token: string } }) {
  const admin = createAdminSupabase();
  const result = await validatePortalToken(admin, params.token);

  if (!result.ok) {
    const heading =
      result.state === 'expired'
        ? 'This link has expired'
        : result.state === 'revoked'
          ? 'This link has been revoked'
          : 'Link not found';
    return (
      <Shell>
        <div style={S.card}>
          <div style={S.badgeMuted}>Secure document upload</div>
          <h1 style={S.title}>{heading}</h1>
          <p style={S.muted}>
            This upload link is no longer valid. Please contact the company that sent it to request a new one.
          </p>
        </div>
      </Shell>
    );
  }

  const { orgId, vendorId, requestedDocs } = result.token;

  // Resolve display context (never leaks anything the link-holder shouldn't see:
  // they ARE this vendor). Requesting company name + this vendor's own name.
  const [{ data: org }, { data: vendor }] = await Promise.all([
    admin.schema('core').from('organizations').select('name').eq('id', orgId).maybeSingle(),
    admin.schema('core').from('vendors').select('name, display_name').eq('id', vendorId).maybeSingle(),
  ]);

  const companyName = (org?.name as string) || 'Your requester';
  const vendorName = (vendor?.display_name as string) || (vendor?.name as string) || '';

  return (
    <Shell>
      <VendorPortalClient
        token={params.token}
        companyName={companyName}
        vendorName={vendorName}
        requestedDocs={requestedDocs as PortalDocKind[]}
        docLabels={PORTAL_DOC_LABEL}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={S.wrap}>
      <FontHead />
      <div style={S.inner}>{children}</div>
      <div style={S.poweredBy}>Secure upload · your documents are encrypted at rest</div>
    </main>
  );
}

function FontHead() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
      @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
      * { box-sizing: border-box; }
      body { margin: 0; }
    `,
      }}
    />
  );
}

const SANS = "'Plus Jakarta Sans', system-ui, -apple-system, Segoe UI, sans-serif";
const ACCENT = '#10b981';

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100vh', background: '#f1f5f9', padding: '40px 16px', fontFamily: SANS, color: '#0f172a' },
  inner: { maxWidth: 640, margin: '0 auto' },
  card: { background: '#fff', borderRadius: 16, padding: 40, boxShadow: '0 10px 40px rgba(15,23,42,0.10)', textAlign: 'center' },
  badgeMuted: {
    display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
    color: ACCENT, background: '#ecfdf5', borderRadius: 999, padding: '5px 12px', marginBottom: 16,
  },
  title: { fontSize: 22, fontWeight: 800, margin: '0 0 10px' },
  muted: { color: '#64748b', fontSize: 14, lineHeight: 1.6, margin: 0 },
  poweredBy: { textAlign: 'center', color: '#94a3b8', fontSize: 12, marginTop: 20 },
};
