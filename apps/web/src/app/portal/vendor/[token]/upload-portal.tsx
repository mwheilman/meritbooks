'use client';

import { useCallback, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Public vendor upload UI (no app hooks — this renders OUTSIDE the authenticated
 * shell). One clean card per requested document with drag-and-drop + a file
 * picker, client-side type/size validation (the server re-validates), a success
 * confirmation, and re-upload. Light branded theme, emerald accent.
 */

type PortalDocKind = 'W9' | 'COI' | 'BANKING';
type Phase = 'idle' | 'uploading' | 'done' | 'error';

// Client-side mirror of the server guard (server is authoritative).
const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png'];
const MAX_BYTES = 15 * 1024 * 1024;

const HINT: Record<PortalDocKind, string> = {
  W9: 'The signed IRS Form W-9 with your legal name, TIN, and address.',
  COI: 'A current Certificate of Insurance showing your coverage and expiration.',
  BANKING: 'A voided check or bank letter with your remittance / ACH details.',
};

export function VendorPortalClient({
  token,
  companyName,
  vendorName,
  requestedDocs,
  docLabels,
}: {
  token: string;
  companyName: string;
  vendorName: string;
  requestedDocs: PortalDocKind[];
  docLabels: Record<PortalDocKind, string>;
}) {
  return (
    <div>
      <div style={S.header}>
        <div style={S.badge}>Secure document upload</div>
        <h1 style={S.h1}>{companyName} requested your documents</h1>
        <p style={S.sub}>
          {vendorName ? <>Uploading as <strong>{vendorName}</strong>. </> : null}
          Add each requested file below. Your uploads are received for review — you can re-upload if you need to
          replace a file. Nothing is shared beyond {companyName}.
        </p>
      </div>

      <div style={S.stack}>
        {requestedDocs.map((kind) => (
          <DocCard key={kind} token={token} kind={kind} label={docLabels[kind]} hint={HINT[kind]} />
        ))}
      </div>

      <p style={S.footNote}>
        Accepted files: PDF, JPG, or PNG, up to 15 MB. Having trouble? Reply to the message that sent you this link.
      </p>
    </div>
  );
}

function DocCard({ token, kind, label, hint }: { token: string; kind: PortalDocKind; label: string; hint: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const validate = (file: File): string | null => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXT.includes(ext)) return 'Unsupported file type. Upload a PDF, JPG, or PNG.';
    if (file.size <= 0) return 'That file appears to be empty.';
    if (file.size > MAX_BYTES) return 'That file is larger than 15 MB.';
    return null;
  };

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      const v = validate(file);
      if (v) {
        setError(v);
        setPhase('error');
        return;
      }
      setPhase('uploading');
      setFileName(file.name);
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('doc_kind', kind);
        const res = await fetch(`/api/portal/vendor/${encodeURIComponent(token)}/upload`, {
          method: 'POST',
          body: fd,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          setError(body.error || 'Upload failed. Please try again.');
          setPhase('error');
          return;
        }
        setPhase('done');
      } catch {
        setError('Network error. Please check your connection and try again.');
        setPhase('error');
      }
    },
    [kind, token],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  };

  const done = phase === 'done';

  return (
    <section style={{ ...S.card, ...(done ? S.cardDone : null) }} aria-label={label}>
      <div style={S.cardHead}>
        <div>
          <div style={S.cardTitle}>{label}</div>
          <div style={S.cardHint}>{hint}</div>
        </div>
        {done && <span style={S.doneChip}>✓ Received</span>}
      </div>

      {done ? (
        <div style={S.doneBox} aria-live="polite">
          <div style={S.doneMsg}>
            <strong>{fileName}</strong> received — pending review.
          </div>
          <button
            type="button"
            className="mb-linkbtn"
            style={S.linkBtn}
            onClick={() => { setPhase('idle'); setError(null); }}
          >
            Replace file
          </button>
        </div>
      ) : (
        <>
          <div
            role="button"
            tabIndex={0}
            className="mb-dropzone"
            onClick={() => phase !== 'uploading' && inputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && phase !== 'uploading') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              ...S.drop,
              ...(dragOver ? S.dropActive : null),
              ...(phase === 'uploading' ? S.dropBusy : null),
            }}
            aria-label={`Upload ${label}`}
            aria-busy={phase === 'uploading'}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              style={{ display: 'none' }}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = '';
              }}
            />
            {phase === 'uploading' ? (
              <div style={S.dropText}>
                <Loader2 size={16} className="animate-spin" style={{ display: 'inline-block', verticalAlign: '-3px', marginRight: 6, color: ACCENT }} aria-hidden="true" />
                Uploading {fileName}…
              </div>
            ) : (
              <>
                <div style={S.dropIcon} aria-hidden="true">↑</div>
                <div style={S.dropText}>
                  <strong>Drop a file here</strong> or click to browse
                </div>
                <div style={S.dropSub}>PDF, JPG, or PNG · up to 15 MB</div>
              </>
            )}
          </div>
          {error && phase === 'error' && (
            <div style={S.errorBox} role="alert">
              {error}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const ACCENT = '#10b981';

const S: Record<string, React.CSSProperties> = {
  header: { marginBottom: 24 },
  badge: {
    display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
    color: ACCENT, background: '#ecfdf5', borderRadius: 999, padding: '5px 12px', marginBottom: 14,
  },
  h1: { fontSize: 24, fontWeight: 800, margin: '0 0 8px', letterSpacing: -0.3 },
  sub: { color: '#475569', fontSize: 14.5, lineHeight: 1.6, margin: 0 },
  stack: { display: 'flex', flexDirection: 'column', gap: 16 },
  card: { background: '#fff', borderRadius: 14, padding: 20, boxShadow: '0 6px 24px rgba(15,23,42,0.08)' },
  cardDone: { boxShadow: '0 6px 24px rgba(16,185,129,0.14)', border: '1px solid #a7f3d0' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  cardTitle: { fontSize: 16, fontWeight: 700 },
  cardHint: { fontSize: 12.5, color: '#64748b', marginTop: 3, lineHeight: 1.5 },
  doneChip: { fontSize: 12, fontWeight: 700, color: '#15803d', background: '#dcfce7', borderRadius: 999, padding: '4px 10px', whiteSpace: 'nowrap' },
  drop: {
    border: '2px dashed #cbd5e1', borderRadius: 12, padding: '26px 16px', textAlign: 'center',
    cursor: 'pointer', transition: 'all 0.15s', background: '#f8fafc',
  },
  dropActive: { borderColor: ACCENT, background: '#ecfdf5' },
  dropBusy: { cursor: 'default', borderColor: '#93c5fd', background: '#eff6ff' },
  dropIcon: { fontSize: 22, color: ACCENT, fontWeight: 800, lineHeight: 1 },
  dropText: { fontSize: 14, color: '#334155', marginTop: 8 },
  dropSub: { fontSize: 12, color: '#94a3b8', marginTop: 4 },
  doneBox: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: '#f0fdf4', borderRadius: 10, padding: '14px 16px' },
  doneMsg: { fontSize: 13.5, color: '#15803d' },
  linkBtn: { background: 'none', border: 'none', color: '#0f766e', fontWeight: 600, fontSize: 13, cursor: 'pointer', textDecoration: 'underline', padding: 0, whiteSpace: 'nowrap' },
  errorBox: { marginTop: 12, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 500 },
  footNote: { color: '#94a3b8', fontSize: 12.5, marginTop: 20, textAlign: 'center', lineHeight: 1.6 },
};
