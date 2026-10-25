'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '@meritbooks/merit-ui';

export interface SignaturePadHandle {
  /** PNG data URL of the drawing (trimmed of nothing; white is transparent), or null when empty. */
  toDataUrl(): string | null;
  clear(): void;
}

/**
 * Draw-to-sign: pointer events (mouse, pen, finger), smoothed strokes, high-DPI canvas,
 * keyboard-reachable Clear. A drawing shorter than ~40px of ink counts as empty.
 */
export const SignaturePad = forwardRef<SignaturePadHandle, { label: string; onChange?: (hasInk: boolean) => void; disabled?: boolean }>(
  function SignaturePad({ label, onChange, disabled }, ref) {
    const canvas = useRef<HTMLCanvasElement | null>(null);
    const drawing = useRef(false);
    const last = useRef<{ x: number; y: number } | null>(null);
    const ink = useRef(0);
    const [hasInk, setHasInk] = useState(false);

    const size = useCallback(() => {
      const c = canvas.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      c.width = Math.max(1, Math.floor(r.width * dpr));
      c.height = Math.max(1, Math.floor(r.height * dpr));
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = getComputedStyle(c).getPropertyValue('--midnight').trim() || 'black';
      }
      ink.current = 0;
      setHasInk(false);
      onChange?.(false);
    }, [onChange]);

    useEffect(() => {
      size();
      const onResize = () => size();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, [size]);

    useImperativeHandle(ref, () => ({
      toDataUrl: () => (canvas.current && ink.current >= 40 ? canvas.current.toDataURL('image/png') : null),
      clear: size,
    }), [size]);

    const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    return (
      <div className="stack" style={{ gap: 6 }}>
        <div className="sign-pad">
          <canvas
            ref={canvas}
            role="img"
            aria-label={`${label}. Draw with your finger, a pen or the mouse.`}
            onPointerDown={(e) => {
              if (disabled) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              drawing.current = true;
              last.current = pos(e);
            }}
            onPointerMove={(e) => {
              if (!drawing.current || !last.current) return;
              const ctx = e.currentTarget.getContext('2d');
              const p = pos(e);
              if (!ctx) return;
              const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
              ctx.beginPath();
              ctx.moveTo(last.current.x, last.current.y);
              ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
              ctx.lineTo(p.x, p.y);
              ctx.stroke();
              ink.current += Math.hypot(p.x - last.current.x, p.y - last.current.y);
              last.current = p;
              if (!hasInk && ink.current >= 40) { setHasInk(true); onChange?.(true); }
            }}
            onPointerUp={() => { drawing.current = false; last.current = null; }}
            onPointerCancel={() => { drawing.current = false; last.current = null; }}
          />
          <span className="base" aria-hidden="true" />
          {!hasInk && <span className="hint" aria-hidden="true">Sign here</span>}
        </div>
        <div><Button variant="quiet" size="md" onClick={size} disabled={disabled || !hasInk}>Clear signature</Button></div>
      </div>
    );
  },
);
