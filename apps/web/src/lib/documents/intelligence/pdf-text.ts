/**
 * PDF text-layer sniffer — the deterministic "first page text" the classifier reads when
 * AI is off (FPB-document-intelligence §7.3). No dependency beyond node:zlib.
 *
 * It is deliberately NOT a PDF renderer: it walks the file's content streams (inflating
 * FlateDecode ones), pulls the string operands of the text-showing operators (Tj, TJ, ',
 * ") inside BT … ET blocks, plus the Info dictionary's Title / Subject, and returns up to
 * `maxChars` of normalized text. Scanned PDFs (images only) and fonts with custom
 * encodings yield little or nothing — that is expected; the AI read covers them.
 *
 * Pure (bytes in, text out), bounded (stream count + bytes inflated), never throws.
 */

import { inflateSync } from 'node:zlib';

export interface PdfTextOptions {
  /** Stop once this much text has been collected (default 6000). */
  maxChars?: number;
  /** Look at no more than this many streams (default 80). */
  maxStreams?: number;
  /** Cap on bytes inflated in total (default 4 MB). */
  maxInflatedBytes?: number;
}

/** True when the buffer starts with the PDF magic. */
export function isPdf(buf: Uint8Array): boolean {
  return buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}

/** Decode a PDF literal string body (between the outer parentheses) with its escapes. */
export function decodeLiteral(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) break;
    i++;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (n === '(' || n === ')' || n === '\\') out += n;
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else if (n === '\r' || n === '\n') {
      if (n === '\r' && body[i + 1] === '\n') i++;
    } else out += n;
  }
  return out;
}

/** Decode a hex string body. Two-byte (CID-ish, 00xx) runs are read as UTF-16BE. */
export function decodeHex(hex: string): string {
  const h = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2).padEnd(2, '0'), 16));
  if (bytes.length >= 2 && bytes.length % 2 === 0) {
    let zeroHigh = 0;
    for (let i = 0; i < bytes.length; i += 2) if (bytes[i] === 0) zeroHigh++;
    if (zeroHigh >= bytes.length / 4) {
      let s = '';
      for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return s;
    }
  }
  return String.fromCharCode(...bytes);
}

/** Read a balanced literal string starting at s[i] === '('. Returns [body, nextIndex]. */
function readLiteral(s: string, i: number): [string, number] {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
    }
  }
  return [s.slice(i + 1), s.length];
}

/**
 * Pull the shown text out of one content stream. Keeps word breaks: TJ kerning gaps
 * larger than ~ a space, the Td / TD / T-star / quote moves and ET all become whitespace.
 */
export function textFromContentStream(content: string): string {
  let out = '';
  let inText = false;
  let pending = '';
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (c === '(') {
      const [body, next] = readLiteral(content, i);
      if (inText) pending += decodeLiteral(body);
      i = next;
      continue;
    }
    if (c === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i + 1);
      if (end < 0) break;
      if (inText) pending += decodeHex(content.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '[' && inText) {
      // TJ array: strings and kerning numbers.
      let j = i + 1;
      while (j < n && content[j] !== ']') {
        const d = content[j];
        if (d === '(') {
          const [body, next] = readLiteral(content, j);
          pending += decodeLiteral(body);
          j = next;
          continue;
        }
        if (d === '<') {
          const end = content.indexOf('>', j + 1);
          if (end < 0) {
            j = n;
            break;
          }
          pending += decodeHex(content.slice(j + 1, end));
          j = end + 1;
          continue;
        }
        if (d === '-' || (d >= '0' && d <= '9') || d === '.') {
          let k = j;
          while (k < n && /[-0-9.]/.test(content[k])) k++;
          const v = Number(content.slice(j, k));
          if (Number.isFinite(v) && v < -180) pending += ' ';
          j = k;
          continue;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    // Operators (letters / quotes).
    if (/[A-Za-z'"*]/.test(c)) {
      let k = i;
      while (k < n && /[A-Za-z'"*]/.test(content[k])) k++;
      const op = content.slice(i, k);
      if (op === 'BT') {
        inText = true;
      } else if (op === 'ET') {
        if (pending) out += `${pending}\n`;
        pending = '';
        inText = false;
      } else if (inText && (op === 'Tj' || op === 'TJ')) {
        out += pending;
        pending = '';
      } else if (inText && (op === "'" || op === '"' || op === 'T*' || op === 'Td' || op === 'TD' || op === 'Tm')) {
        out += `${pending} `;
        pending = '';
        if (op === "'" || op === '"' || op === 'T*') out += '\n';
      }
      i = k;
      continue;
    }
    i++;
  }
  if (pending) out += pending;
  return out;
}

const SKIP_DICT = /\/Subtype\s*\/(Image|Type1C|CIDFontType0C|OpenType|XML)|\/Type\s*\/(XRef|ObjStm|XObject|EmbeddedFile)|\/Length[123]\s|\/FontFile/;

/** Keep printable text, collapse whitespace. */
export function normalizeText(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Extract up to `maxChars` of text from a PDF's text layer. '' when none / not a PDF. */
export function extractPdfText(buf: Uint8Array, opts: PdfTextOptions = {}): string {
  try {
    if (!isPdf(buf)) return '';
    const maxChars = opts.maxChars ?? 6000;
    const maxStreams = opts.maxStreams ?? 80;
    let budget = opts.maxInflatedBytes ?? 4 * 1024 * 1024;
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const s = b.toString('latin1');

    let text = '';
    // Info dictionary Title / Subject (often the only words a scanner leaves).
    for (const key of ['Title', 'Subject']) {
      const m = new RegExp(`/${key}\\s*\\(`).exec(s);
      if (m) {
        const [body] = readLiteral(s, m.index + m[0].length - 1);
        const v = decodeLiteral(body).trim();
        if (v && v.length < 300) text += `${v}\n`;
      }
    }

    let from = 0;
    let seen = 0;
    while (seen < maxStreams && text.length < maxChars) {
      const at = s.indexOf('stream', from);
      if (at < 0) break;
      // `endstream` also contains "stream" — skip it.
      if (s.slice(at - 3, at) === 'end') {
        from = at + 6;
        continue;
      }
      let start = at + 6;
      if (s[start] === '\r') start++;
      if (s[start] === '\n') start++;
      const end = s.indexOf('endstream', start);
      if (end < 0) break;
      from = end + 9;
      seen++;
      const dictStart = Math.max(s.lastIndexOf('obj', at), at - 2000, 0);
      const dict = s.slice(dictStart, at);
      if (SKIP_DICT.test(dict)) continue;
      const filters = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict)?.[1] ?? '';
      let raw: Buffer = b.subarray(start, end);
      if (filters) {
        if (!/FlateDecode/.test(filters) || /DCT|JPX|JBIG2|CCITT|ASCII85|LZW|RunLength/.test(filters)) continue;
        if (budget <= 0) break;
        try {
          raw = inflateSync(raw, { maxOutputLength: Math.min(budget, 2 * 1024 * 1024) });
        } catch {
          continue;
        }
        budget -= raw.length;
      }
      const content = raw.toString('latin1');
      if (!/\bBT\b/.test(content)) continue;
      const t = textFromContentStream(content);
      if (t.trim()) text += `${t}\n`;
    }
    return normalizeText(text).slice(0, maxChars);
  } catch {
    return '';
  }
}

/** Share of letters/digits/spaces in a text (0–1) — tells readable text from font-encoded noise. */
export function readability(text: string): number {
  if (!text) return 0;
  const sample = text.slice(0, 3000);
  const good = (sample.match(/[A-Za-z0-9 .,$%\n:/\-()&']/g) ?? []).length;
  return good / sample.length;
}
