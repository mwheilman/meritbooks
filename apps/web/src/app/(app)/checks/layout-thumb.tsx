import { PAGE_H, PAGE_W, pageBands, type CheckLayout } from '@/lib/ap/check-print/layout';

/**
 * A to-scale miniature of one sheet of check stock, drawn from the same band geometry the
 * PDF renderer uses (lib/ap/check-print/layout `pageBands`), so the thumbnail can never
 * disagree with what prints. Check bands: Electric fill with payee / amount / MICR strokes;
 * stubs: Sky with ruled lines. Decorative — the button label carries the meaning.
 */
export function LayoutThumb({ layout, className }: { layout: CheckLayout; className?: string }) {
  const bands = pageBands(layout);
  const pad = 14;
  return (
    <svg className={className} viewBox={`0 0 ${PAGE_W} ${PAGE_H}`} aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width={PAGE_W} height={PAGE_H} fill="var(--white)" stroke="var(--line-2)" strokeWidth="10" />
      {bands.map((b, i) => {
        const y = b.top;
        const h = b.height;
        if (b.kind === 'check') {
          return (
            <g key={i}>
              <rect x={pad} y={y + pad} width={PAGE_W - pad * 2} height={h - pad * 2} fill="var(--sky)" stroke="var(--electric)" strokeWidth="8" />
              {/* payee line, amount box, signature line, MICR band */}
              <rect x={pad + 40} y={y + h * 0.36} width={PAGE_W * 0.52} height="10" fill="var(--electric)" />
              <rect x={PAGE_W - pad - 150} y={y + h * 0.3} width="110" height="34" fill="none" stroke="var(--electric)" strokeWidth="8" />
              <rect x={PAGE_W - pad - 230} y={y + h * 0.68} width="190" height="8" fill="var(--electric)" />
              <rect x={pad + 40} y={y + h - pad - 40} width={PAGE_W * 0.6} height="14" fill="var(--midnight)" />
            </g>
          );
        }
        return (
          <g key={i}>
            <rect x={pad} y={y + pad} width={PAGE_W - pad * 2} height={h - pad * 2} fill="var(--canvas)" stroke="var(--line-2)" strokeWidth="6" />
            {[0.28, 0.44, 0.6, 0.76].map((f) => (
              <rect key={f} x={pad + 40} y={y + h * f} width={f === 0.28 ? PAGE_W * 0.35 : PAGE_W * 0.72} height="8" fill="var(--grey-400)" />
            ))}
          </g>
        );
      })}
      {/* perforations between bands */}
      {bands.slice(1).map((b, i) => (
        <line key={`p${i}`} x1="0" x2={PAGE_W} y1={b.top} y2={b.top} stroke="var(--ink-3)" strokeWidth="5" strokeDasharray="18 14" />
      ))}
    </svg>
  );
}
