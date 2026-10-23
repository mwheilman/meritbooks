/**
 * Minimal PDF text extraction for tests: inflates every FlateDecode stream that
 * @react-pdf/renderer (pdfkit) writes and decodes the hex / literal strings inside
 * TJ / Tj operators, plus raw (uncompressed) object text such as link URIs. Good enough
 * to assert "this text is / is not on the page" — not a general PDF parser.
 */
import zlib from 'node:zlib';

function decodeHex(h: string): string {
  const clean = h.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function decodeLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, g: string) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[g] ?? g;
  });
}

/** Text shown on the pages, run together per text operator (joined with spaces). */
export function pdfText(buf: Uint8Array | Buffer): string {
  const bin = Buffer.from(buf).toString('latin1');
  const chunks: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const start = m.index + m[0].length;
    const end = bin.indexOf('endstream', start);
    if (end < 0) break;
    const raw = Buffer.from(bin.slice(start, end), 'latin1');
    let content: string;
    try {
      content = zlib.inflateSync(raw).toString('latin1');
    } catch {
      content = raw.toString('latin1');
    }
    // TJ arrays and Tj strings.
    for (const op of content.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|(<[0-9A-Fa-f\s]*>|\((?:[^()\\]|\\.)*\))\s*Tj/g)) {
      const body = op[1] ?? op[2] ?? '';
      let s = '';
      for (const part of body.matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:[^()\\]|\\.)*)\)/g)) {
        s += part[1] !== undefined ? decodeHex(part[1]) : decodeLiteral(part[2] ?? '');
      }
      chunks.push(s);
    }
    re.lastIndex = end;
  }
  return chunks.join(' ');
}

/** Raw object text outside streams (annotations: link URIs etc.). */
export function pdfObjects(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString('latin1').replace(/stream\r?\n[\s\S]*?endstream/g, '');
}
