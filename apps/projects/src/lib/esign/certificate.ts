/**
 * The signed PDF (PLT-52): the exact version that was sent (its SHA-256 re-checked first), each
 * signer's drawn signature + typed name + date stamped on their signature line when the document
 * carries anchors (rendered templates do), and an audit certificate appended: document, hashes,
 * signers with consent / time / IP / browser, and the full event trail. Pure (bytes in, bytes out).
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { sha256Hex } from '@/lib/documents/pdf';
import { winAnsi, type SignatureAnchor } from '@/lib/templates/layout';

export interface CertSigner {
  position: number;
  name: string;
  email: string | null;
  phone: string | null;
  roleLabel: string | null;
  typedName: string;
  signaturePng: string;
  signedAt: string;
  consentedAt: string | null;
  consentVersion: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface CertEvent {
  at: string;
  event: string;
  signerName: string | null;
  ip: string | null;
  userAgent?: string | null;
}

export interface CertificateInput {
  original: Uint8Array;
  expectedSha256: string;
  envelopeId: string;
  title: string;
  companyName: string;
  sentAt: string | null;
  completedAt: string;
  senderName: string;
  consentText: string;
  signers: CertSigner[];
  events: CertEvent[];
  anchors?: SignatureAnchor[] | null;
}

export interface SignedPdf {
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
  certificatePages: number;
}

export class HashMismatchError extends Error {
  constructor(public readonly actual: string, public readonly expected: string) {
    super(`The stored file does not match the version that was sent (sha-256 ${actual.slice(0, 12)}… ≠ ${expected.slice(0, 12)}…).`);
  }
}

function pngBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function utc(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

const EVENT_WORD: Record<string, string> = {
  created: 'Request created', sent: 'Request sent', delivered: 'Link sent', resent: 'Link re-sent', viewed: 'Opened',
  consented: 'Agreed to sign electronically', signed: 'Signed', declined: 'Declined', completed: 'All parties signed',
  voided: 'Voided', expired: 'Expired', token_rejected: 'Link refused (used, expired or replaced)',
};

class Cursor {
  page!: PDFPage;
  y = 0;
  pages = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont, private header: string) {}
  next(): void {
    this.page = this.doc.addPage([612, 792]);
    this.pages += 1;
    this.page.drawText(winAnsi(this.bold, 'CERTIFICATE OF COMPLETION'), { x: 43, y: 749, size: 13, font: this.bold, color: rgb(0.04, 0.09, 0.16) });
    this.page.drawText(winAnsi(this.font, this.header), { x: 43, y: 734, size: 8, font: this.font, color: rgb(0.24, 0.31, 0.4) });
    this.page.drawRectangle({ x: 43, y: 724, width: 526, height: 2, color: rgb(0.145, 0.388, 0.922) });
    this.y = 706;
  }
  room(h: number): void { if (this.y - h < 50) this.next(); }
  line(text: string, opts: { bold?: boolean; size?: number; x?: number; muted?: boolean } = {}): void {
    const f = opts.bold ? this.bold : this.font;
    const size = opts.size ?? 8.5;
    const x = opts.x ?? 43;
    for (const l of wrap(f, winAnsi(f, text), size, 569 - x)) {
      this.room(size + 3);
      this.page.drawText(l, { x, y: this.y, size, font: f, color: opts.muted ? rgb(0.24, 0.31, 0.4) : rgb(0.04, 0.09, 0.16) });
      this.y -= size + 3;
    }
  }
}

function wrap(f: PDFFont, s: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) <= maxW) { line = next; continue; }
      if (line) out.push(line);
      line = word;
      while (f.widthOfTextAtSize(line, size) > maxW && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && f.widthOfTextAtSize(line.slice(0, cut), size) > maxW) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

export async function buildSignedPdf(input: CertificateInput): Promise<SignedPdf> {
  const actual = sha256Hex(input.original);
  if (actual !== input.expectedSha256) throw new HashMismatchError(actual, input.expectedSha256);
  const doc = await PDFDocument.load(input.original, { ignoreEncryption: true, updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const originalPages = doc.getPageCount();
  const images = new Map<number, Awaited<ReturnType<PDFDocument['embedPng']>>>();
  for (const s of input.signers) images.set(s.position, await doc.embedPng(pngBytes(s.signaturePng)));

  // 1. stamp each signature on its line (anchors from the rendered template)
  const pages = doc.getPages();
  for (const a of input.anchors ?? []) {
    const s = input.signers.find((x) => x.position === a.position);
    const img = s ? images.get(s.position) : undefined;
    const page = pages[a.page];
    if (!s || !img || !page) continue;
    const scale = Math.min(a.width / img.width, a.height / img.height);
    page.drawImage(img, { x: a.x + 2, y: a.y, width: img.width * scale, height: img.height * scale });
    const stamp = winAnsi(font, `${s.typedName} · ${utc(s.signedAt)} · ID ${input.envelopeId.slice(0, 8)}`);
    page.drawText(stamp, { x: a.x, y: a.y - 31, size: 6, font, color: rgb(0.145, 0.388, 0.922) });
  }

  // 2. the certificate
  const c = new Cursor(doc, font, bold, `${input.companyName} · envelope ${input.envelopeId}`);
  c.next();
  c.line('Document', { bold: true, size: 10 });
  c.line(input.title, { size: 10 });
  c.line(`Original document SHA-256: ${input.expectedSha256}`, { muted: true });
  c.line(`Pages in the signed document: ${originalPages} (plus this certificate)`, { muted: true });
  c.line(`Sent by ${input.senderName} on ${utc(input.sentAt)} · completed ${utc(input.completedAt)}`, { muted: true });
  c.y -= 8;
  c.line('Signers', { bold: true, size: 10 });
  for (const s of [...input.signers].sort((a, b) => a.position - b.position)) {
    c.room(92);
    const top = c.y;
    const img = images.get(s.position);
    if (img) {
      const scale = Math.min(150 / img.width, 44 / img.height);
      c.page.drawImage(img, { x: 410, y: top - 46, width: img.width * scale, height: img.height * scale });
      c.page.drawLine({ start: { x: 410, y: top - 48 }, end: { x: 569, y: top - 48 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.86) });
    }
    c.line(`${s.position}. ${s.name}${s.roleLabel ? ` (${s.roleLabel})` : ''}`, { bold: true });
    c.line(`Typed name: ${s.typedName}`);
    c.line([s.email, s.phone].filter(Boolean).join(' · ') || 'Contact: link only');
    c.line(`Signed ${utc(s.signedAt)} · consent ${s.consentVersion ?? '-'} at ${utc(s.consentedAt)}`);
    c.line(`IP ${s.ip ?? '-'} · ${(s.userAgent ?? '-').slice(0, 140)}`, { muted: true });
    c.y = Math.min(c.y, top - 58) - 8;
  }
  c.y -= 4;
  c.line('Consent each signer agreed to', { bold: true, size: 10 });
  c.line(input.consentText, { muted: true });
  c.y -= 8;
  c.line('Event trail', { bold: true, size: 10 });
  for (const e of input.events) {
    c.line(`${utc(e.at)}  ${EVENT_WORD[e.event] ?? e.event}${e.signerName ? ` - ${e.signerName}` : ''}${e.ip ? ` - IP ${e.ip}` : ''}`);
  }
  c.y -= 8;
  c.line('Each signer reached this document through a one-time link sent to their own email or phone. The SHA-256 above identifies the exact document that was presented for signature; any change to it after sending would have stopped this request.', { muted: true });

  doc.setTitle(`${input.title} (signed)`);
  doc.setProducer('Merit Projects e-signature');
  doc.setModificationDate(new Date(input.completedAt));
  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, sha256: sha256Hex(bytes), pageCount: doc.getPageCount(), certificatePages: c.pages };
}
