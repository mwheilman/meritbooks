import type { ReactNode } from 'react';

/**
 * The public request frame: Midnight band with the asking client's name, Warm White
 * sheet, kit type. Server component; no app shell (the visitor has no session).
 */
export function PublicRequestFrame({ eyebrow, sender, children }: { eyebrow: string; sender: string | null; children: ReactNode }) {
  return (
    <main style={{ minHeight: '100vh', background: 'var(--canvas, #F5F3EF)', display: 'flex', justifyContent: 'center', padding: '32px 16px' }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div className="on-dark" style={{ background: 'var(--midnight, #0A1628)', color: '#fff', padding: '16px 24px' }}>
          {sender && <div style={{ fontWeight: 700, fontSize: 16 }}>{sender}</div>}
          <div className="eyebrow" style={{ color: 'var(--signal, #3B82F6)', marginTop: 4 }}>
            {eyebrow}
          </div>
        </div>
        <div style={{ height: 2, background: 'var(--electric, #2563EB)' }} />
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
