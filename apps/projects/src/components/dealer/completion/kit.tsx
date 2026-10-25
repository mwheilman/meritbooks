'use client';

/**
 * Client kit for the 1125 screens (dealer + manufacturing completion): money cells, the scan box a
 * yard or shop phone uses (keyboard wedge scanners type + Enter; the camera reads barcodes where the
 * browser offers BarcodeDetector), photo and signature capture that file a document and hand back
 * its id, and the phone's position for the lot count.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ButtonRow, Input, money } from '@meritbooks/merit-ui';

/** A picker option the server pages pass down. */
export interface Opt { id: string; label: string; sub?: string | null }

/** Cents → "$1,234.00", or a dash when the figure is hidden / missing. */
export function m(c: number | string | null | undefined): string {
  if (c == null || c === '') return '—';
  const n = Number(c);
  return Number.isFinite(n) ? money(Math.round(n)) : '—';
}

/** Read a JSON response or throw its error sentence. */
export async function postForm(url: string, form: FormData): Promise<{ documentId: string }> {
  const r = await fetch(url, { method: 'POST', body: form });
  const j = (await r.json().catch(() => ({}))) as { documentId?: string; error?: string };
  if (!r.ok || !j.documentId) throw new Error(j.error ?? 'The file did not upload.');
  return { documentId: j.documentId };
}

interface Detector { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> }
interface DetectorCtor { new (o: { formats: string[] }): Detector }

/** A scan field: Enter submits; "Camera" reads a barcode when the device supports it. */
export function ScanBox({ label, onScan, disabled, placeholder = 'Scan or type the serial' }: { label: string; onScan: (code: string) => void | Promise<void>; disabled?: boolean; placeholder?: string }) {
  const [v, setV] = useState('');
  const [cam, setCam] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const ref = useRef<HTMLInputElement>(null);
  const Ctor = typeof window !== 'undefined' ? (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector : undefined;

  const submit = useCallback(async (code: string) => {
    const c = code.trim();
    if (!c) return;
    setV('');
    await onScan(c);
    ref.current?.focus();
  }, [onScan]);

  useEffect(() => {
    if (!cam || !Ctor) return;
    let stop = false;
    let stream: MediaStream | null = null;
    const det = new Ctor({ formats: ['code_128', 'code_39', 'qr_code', 'ean_13', 'upc_a', 'data_matrix'] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        while (!stop) {
          const found = await det.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) { setCam(false); await submit(found[0].rawValue); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setErr('The camera is not available. Type the serial or use a scanner.');
        setCam(false);
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [cam, Ctor, submit]);

  return (
    <div className="stack" style={{ gap: 8 }}>
      <ButtonRow>
        <Input ref={ref} aria-label={label} autoFocus autoCapitalize="characters" autoComplete="off" disabled={disabled} placeholder={placeholder} value={v}
          onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(v); } }} style={{ minWidth: 240, fontSize: 18 }} />
        <Button variant="primary" disabled={disabled || !v.trim()} onClick={() => void submit(v)}>Record</Button>
        {Ctor && <Button variant="quiet" disabled={disabled} onClick={() => { setErr(null); setCam((c) => !c); }}>{cam ? 'Close camera' : 'Camera'}</Button>}
      </ButtonRow>
      {cam && <video ref={video} muted playsInline aria-label="Camera view" style={{ width: '100%', maxWidth: 420 }} />}
      {err && <p className="neg t-cap" role="alert">{err}</p>}
    </div>
  );
}

/** Take / pick a photo, file it, and return the document id. */
export function PhotoButton({ url, label = 'Add photo', onFiled, disabled }: { url: string; label?: string; onFiled: (documentId: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="btn-row">
      <input ref={ref} type="file" accept="image/*" capture="environment" className="sr" aria-label={label} onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const fd = new FormData();
        fd.append('file', f);
        setBusy(true); setErr(null);
        try { onFiled((await postForm(url, fd)).documentId); } catch (x) { setErr(x instanceof Error ? x.message : 'The photo did not upload.'); } finally { setBusy(false); }
      }} />
      <Button variant="quiet" disabled={disabled || busy} onClick={() => ref.current?.click()}>{busy ? 'Uploading…' : label}</Button>
      {err && <span className="neg t-cap" role="alert">{err}</span>}
    </span>
  );
}

/** A finger / mouse signature: filed as a PNG document; hands back its id. */
export function SignaturePad({ url, onFiled, disabled }: { url: string; onFiled: (documentId: string) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filed, setFiled] = useState(false);
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * e.currentTarget.width, ((e.clientY - r.top) / r.height) * e.currentTarget.height] as const;
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <canvas ref={canvas} width={600} height={180} aria-label="Signature pad: sign with a finger or the mouse" className="sig-pad"
        style={{ width: '100%', maxWidth: 600, height: 180, border: '1px solid var(--rule, #CCD3DB)', touchAction: 'none', background: '#FFFFFF' }}
        onPointerDown={(e) => { if (disabled || filed) return; drawing.current = true; const c = e.currentTarget.getContext('2d'); if (!c) return; const [x, y] = at(e); c.lineWidth = 2.5; c.lineCap = 'round'; c.strokeStyle = '#0A1628'; c.beginPath(); c.moveTo(x, y); e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (!drawing.current) return; const c = e.currentTarget.getContext('2d'); if (!c) return; const [x, y] = at(e); c.lineTo(x, y); c.stroke(); setInked(true); }}
        onPointerUp={() => { drawing.current = false; }} />
      <ButtonRow>
        <Button variant="quiet" disabled={busy || filed} onClick={() => { const c = canvas.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height); setInked(false); }}>Clear</Button>
        <Button disabled={!inked || busy || filed || disabled} onClick={() => {
          const c = canvas.current;
          if (!c) return;
          setBusy(true); setErr(null);
          c.toBlob(async (blob) => {
            try {
              if (!blob) throw new Error('The signature could not be saved.');
              const fd = new FormData();
              fd.append('file', new File([blob], 'signature.png', { type: 'image/png' }));
              onFiled((await postForm(url, fd)).documentId);
              setFiled(true);
            } catch (x) { setErr(x instanceof Error ? x.message : 'The signature did not upload.'); } finally { setBusy(false); }
          }, 'image/png');
        }}>{filed ? 'Signature saved' : busy ? 'Saving…' : 'Save signature'}</Button>
      </ButtonRow>
      {err && <p className="neg t-cap" role="alert">{err}</p>}
    </div>
  );
}

/** The phone's position once, for the lot count (null when the person declines). */
export function usePosition(): { pos: { lat: number; lng: number } | null; ask: () => void; note: string | null } {
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ask = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setNote('This device does not share its location.'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setPos({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6 }); setNote(null); },
      () => setNote('Location is off: scans are recorded without the GPS check.'),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 10_000 },
    );
  }, []);
  return { pos, ask, note };
}
