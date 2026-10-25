/**
 * PDF helpers on the server (pdf-lib): page count, page sizes, split a drawing set into
 * single-page PDFs (one per sheet revision), and the SHA-256 every version carries.
 */
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

export const MAX_SET_PAGES = 400;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  // Encrypted / owner-protected sets still split (most CAD exports set an owner password only).
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

export interface PdfPageInfo { index: number; width: number; height: number }

export async function pdfPages(bytes: Uint8Array): Promise<PdfPageInfo[]> {
  const doc = await loadPdf(bytes);
  return doc.getPages().map((p, index) => {
    const { width, height } = p.getSize();
    const rot = ((p.getRotation().angle % 360) + 360) % 360;
    return rot === 90 || rot === 270 ? { index, width: height, height: width } : { index, width, height };
  });
}

export interface SplitPage extends PdfPageInfo {
  bytes: Uint8Array;
  sha256: string;
}

/** One single-page PDF per page of the set (rotation and boxes preserved by copyPages). */
export async function splitPdf(bytes: Uint8Array, opts: { maxPages?: number; title?: string } = {}): Promise<SplitPage[]> {
  const src = await loadPdf(bytes);
  const n = src.getPageCount();
  const max = opts.maxPages ?? MAX_SET_PAGES;
  if (n === 0) throw new Error('The PDF has no pages.');
  if (n > max) throw new Error(`The set has ${n} pages; upload at most ${max} pages at a time.`);
  const info = await pdfPages(bytes);
  const out: SplitPage[] = [];
  for (let i = 0; i < n; i++) {
    const one = await PDFDocument.create();
    const [page] = await one.copyPages(src, [i]);
    one.addPage(page);
    if (opts.title) one.setTitle(`${opts.title} — page ${i + 1}`);
    one.setProducer('Merit Projects');
    const b = await one.save({ useObjectStreams: true });
    out.push({ ...info[i], bytes: b, sha256: sha256Hex(b) });
  }
  return out;
}
