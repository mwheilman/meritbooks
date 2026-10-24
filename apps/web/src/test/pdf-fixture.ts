/** Test fixture: a minimal, valid-enough PDF with a real text layer (FlateDecode content stream). */
import { deflateSync } from 'node:zlib';

/** A minimal PDF whose one page shows `lines` through a FlateDecode content stream. */
export function makePdf(lines: string[], opts: { compress?: boolean; title?: string } = {}): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 11 Tf 72 720 Td ${lines.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`).join(' ')} ET`;
  const body = opts.compress === false ? Buffer.from(content, 'latin1') : deflateSync(Buffer.from(content, 'latin1'));
  const filter = opts.compress === false ? '' : ' /Filter /FlateDecode';
  const parts: Buffer[] = [
    Buffer.from('%PDF-1.4\n', 'latin1'),
    Buffer.from(`1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`, 'latin1'),
    Buffer.from(`2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n`, 'latin1'),
    Buffer.from(`3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n`, 'latin1'),
    Buffer.from(`4 0 obj << /Length ${body.length}${filter} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ];
  if (opts.title) parts.push(Buffer.from(`5 0 obj << /Title (${esc(opts.title)}) >> endobj\n`, 'latin1'));
  parts.push(Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

