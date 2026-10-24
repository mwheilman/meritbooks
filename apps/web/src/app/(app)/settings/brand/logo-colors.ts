/**
 * Read a logo's pixels in the browser (FPB-branding §4.5): draw it, downscaled, onto a
 * canvas and hand the RGBA to the pure extractor. The server never decodes images.
 * No dependency — a canvas is all it takes.
 */

import { extractPalette, type Extraction } from '@/lib/branding/extract';

const MAX_SIDE = 200;

function loadImage(src: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be read.'));
    img.src = src;
  });
}

async function pixelsOf(img: HTMLImageElement): Promise<Extraction> {
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('The image has no size.');
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser can’t read image colours.');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return extractPalette({ data: data.data, width: w, height: h });
}

/** Colours of a file the user just picked (before it is uploaded). */
export async function extractFromFile(file: File): Promise<Extraction> {
  const url = URL.createObjectURL(file);
  try {
    return await pixelsOf(await loadImage(url, false));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Colours of an already-saved logo (public Storage URL, CORS-enabled). */
export async function extractFromUrl(url: string): Promise<Extraction> {
  return pixelsOf(await loadImage(url, true));
}
