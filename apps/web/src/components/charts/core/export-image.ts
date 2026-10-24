/**
 * SVG / PNG export of a rendered chart (browser only).
 *
 * Chart styling lives in classes (charts.css, kit tokens). A standalone SVG file
 * has no stylesheet, so we clone the SVG and inline the computed paint/type
 * properties onto every element, then resolve var() into literal colours. The
 * hatch <pattern>s live inside each chart's own <defs>, so they travel with it.
 *
 * PNG: the inlined SVG is drawn to a 2× canvas. Canvas can't load web fonts
 * from an SVG image, so the PNG falls back to the system sans if DM Sans isn't
 * installed locally — the SVG export keeps the font-family declaration.
 */

/** Properties copied from computed style onto the clone. */
export const INLINE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'paint-order',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-variant-numeric',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'visibility',
  'display',
] as const;

/** Serialize an on-screen chart SVG into a standalone, styled SVG string. */
export function serializeSvg(svg: SVGSVGElement, opts: { title?: string; background?: string } = {}): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = svg.querySelectorAll<SVGElement>('*');
  const dst = clone.querySelectorAll<SVGElement>('*');
  src.forEach((el, i) => {
    const target = dst[i];
    if (!target) return;
    const cs = window.getComputedStyle(el);
    const decl: string[] = [];
    for (const p of INLINE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) decl.push(`${p}:${v}`);
    }
    target.setAttribute('style', decl.join(';'));
    target.removeAttribute('class');
    target.removeAttribute('tabindex');
  });
  const box = svg.getBoundingClientRect();
  const w = Math.round(box.width) || Number(svg.getAttribute('width')) || 640;
  const h = Math.round(box.height) || Number(svg.getAttribute('height')) || 240;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  if (opts.background) {
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', opts.background);
    clone.insertBefore(bg, clone.firstChild);
  }
  if (opts.title) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = opts.title;
    clone.insertBefore(t, clone.firstChild);
  }
  return new XMLSerializer().serializeToString(clone);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadSvg(svg: SVGSVGElement, filename: string, title?: string): void {
  const text = serializeSvg(svg, { title, background: '#FFFFFF' });
  downloadBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), filename);
}

export async function downloadPng(svg: SVGSVGElement, filename: string, title?: string, scale = 2): Promise<void> {
  const text = serializeSvg(svg, { title, background: '#FFFFFF' });
  const box = svg.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  const img = new Image();
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the chart image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not encode the PNG');
    downloadBlob(blob, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}
