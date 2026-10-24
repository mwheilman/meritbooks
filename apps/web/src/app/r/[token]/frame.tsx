import type { ReactNode } from 'react';
import type { ResolvedBrand } from '@/lib/branding/types';

/**
 * The public request frame: Midnight band with the asking client's name, Warm White
 * sheet, kit type. Server component; no app shell (the visitor has no session).
 *
 * Brand (FPB-branding): when the asking company has a brand, its logo heads the frame (the
 * dark-background logo on the Midnight band; a light-background logo on a white band) and
 * the rule under it is the brand colour. With no brand, the Merit request look.
 */
export function PublicRequestFrame({
  eyebrow,
  sender,
  brand,
  children,
}: {
  eyebrow: string;
  sender: string | null;
  brand?: ResolvedBrand | null;
  children: ReactNode;
}) {
  const b = brand && brand.source !== 'MERIT_DEFAULT' ? brand : null;
  const whiteBand = !!b && !!b.logoUrl && !b.logoDarkUrl;
  const logo = b ? (whiteBand ? b.logoUrl : b.logoDarkUrl) : null;
  return (
    <main style={{ minHeight: '100vh', background: 'var(--canvas, #F5F3EF)', display: 'flex', justifyContent: 'center', padding: '32px 16px', fontFamily: b?.fontStack }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div
          className={whiteBand ? undefined : 'on-dark'}
          style={{ background: whiteBand ? '#FFFFFF' : 'var(--midnight, #0A1628)', color: whiteBand ? 'var(--ink, #0A1628)' : '#fff', padding: '16px 24px', border: whiteBand ? '1px solid var(--line, #E4E1DA)' : undefined, borderBottom: 0 }}
        >
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt={sender ?? ''} style={{ display: 'block', height: 36, maxWidth: 200, objectFit: 'contain' }} />
          ) : (
            sender && <div style={{ fontWeight: 700, fontSize: 16 }}>{sender}</div>
          )}
          <div className="eyebrow" style={{ color: whiteBand ? 'var(--steel, #3D4F65)' : 'var(--signal, #3B82F6)', marginTop: logo ? 8 : 4 }}>
            {eyebrow}
          </div>
        </div>
        <div style={{ height: 2, background: b ? b.palette.primary : 'var(--electric, #2563EB)' }} />
        <section style={{ background: 'var(--warm, #FDFCFA)', border: '1px solid var(--line, #E4E1DA)', borderTop: 0, padding: '24px' }}>{children}</section>
        <p className="t-cap" style={{ textAlign: 'center', marginTop: 16 }}>
          Secure link · sent on behalf of {sender ?? 'your accounting team'}
        </p>
      </div>
    </main>
  );
}

export function PublicRequestNotice({ heading, body }: { heading: string; body: string }) {
  return (
    <PublicRequestFrame eyebrow="Request" sender={null}>
      <h1 className="t-head" style={{ margin: 0 }}>
        {heading}
      </h1>
      <p className="ink-2" style={{ marginTop: 8 }}>
        {body}
      </p>
    </PublicRequestFrame>
  );
}
