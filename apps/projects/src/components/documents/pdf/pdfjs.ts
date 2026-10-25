'use client';
/**
 * pdf.js in the browser (pdfjs-dist 4.10, legacy build for older Safari): renders sheets to a
 * canvas for the viewer / overlay compare, and reads each page's text layer at upload so sheet
 * numbers and titles come from the title block. Loaded lazily — nothing here runs on the server.
 * If pdf.js cannot load, callers fall back (iframe view; manual sheet numbers).
 */
import type { PageText, TextItem } from '@/lib/documents/sheets';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

let loading: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  if (!loading) {
    loading = import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
      if (!lib.GlobalWorkerOptions.workerPort) {
        lib.GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
      }
      return lib;
    }).catch((e: unknown) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

export async function openPdf(src: string | ArrayBuffer): Promise<PdfDoc> {
  const lib = await loadPdfJs();
  const task = typeof src === 'string' ? lib.getDocument({ url: src, isEvalSupported: false }) : lib.getDocument({ data: new Uint8Array(src.slice(0)), isEvalSupported: false });
  return task.promise;
}

export interface RenderResult { width: number; height: number }

/** Render page 1 (sheets are single-page PDFs) at `cssWidth` CSS pixels, crisp on high-DPI screens. */
export async function renderToCanvas(doc: PdfDoc, canvas: HTMLCanvasElement, cssWidth: number, pageNo = 1): Promise<RenderResult> {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = cssWidth / base.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const vp = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${Math.floor(base.width * scale)}px`;
  canvas.style.height = `${Math.floor(base.height * scale)}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { width: base.width * scale, height: base.height * scale };
}

/** Every page's text items in displayed orientation (PDF points, origin bottom-left). */
export async function extractPages(data: ArrayBuffer, onProgress?: (done: number, total: number) => void): Promise<PageText[]> {
  const doc = await openPdf(data);
  const out: PageText[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const raw of content.items) {
        if (!('str' in raw) || !raw.str.trim()) continue;
        const [a, b, c, d, e, f] = raw.transform as number[];
        const [vx, vy] = vp.convertToViewportPoint(e, f) as [number, number];
        const h = Math.hypot(c, d) || Math.hypot(a, b) || raw.height || 0;
        items.push({ str: raw.str, x: vx, y: vp.height - vy, w: raw.width, h });
      }
      out.push({ index: n - 1, width: vp.width, height: vp.height, items });
      page.cleanup();
      onProgress?.(n, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
