import 'server-only';
import type { NextRequest } from 'next/server';
import { HttpError } from '@/lib/api-errors';

export interface Upload {
  form: FormData;
  file: File;
  bytes: Uint8Array;
  mimeType: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Browsers send '' or octet-stream for some types; infer from the extension for the common ones. */
export function mimeOf(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type.slice(0, 120);
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp',
    dwg: 'application/acad', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

export async function readUpload(req: NextRequest, opts: { maxBytes: number; pdfOnly?: boolean }): Promise<Upload> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'Send the file as an upload.', 'BAD_UPLOAD');
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) throw new HttpError(422, 'Pick a file to upload.', 'VALIDATION');
  if (file.size > opts.maxBytes) throw new HttpError(422, `That file is over ${Math.round(opts.maxBytes / 1024 / 1024)} MB.`, 'TOO_LARGE');
  const mimeType = mimeOf(file);
  if (opts.pdfOnly && mimeType !== 'application/pdf') throw new HttpError(422, 'Upload the set as one PDF.', 'VALIDATION');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (mimeType === 'application/pdf' && !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    throw new HttpError(422, 'That file is not a PDF.', 'VALIDATION');
  }
  return { form, file, bytes, mimeType };
}

export function field(form: FormData, key: string, max = 2000): string | null {
  const v = form.get(key);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export function uuidField(form: FormData, key: string): string | null {
  const v = field(form, key, 64);
  if (v && !UUID.test(v)) throw new HttpError(422, `${key} is not a valid id.`, 'VALIDATION');
  return v;
}

export function linkBase(req: NextRequest): string {
  const env = process.env.NEXT_PUBLIC_PROJECTS_URL;
  return env && /^https?:\/\//.test(env) ? env : req.nextUrl.origin;
}
