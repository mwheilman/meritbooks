/**
 * Parse a receipt upload (multipart/form-data) into capture inputs. Shared by the desk
 * route, the signed-in Merit Workforce route and the magic-link route. Server-only.
 *
 *   file / files   one or more files (field name `file` or `files`)
 *   other fields   lib/validations/receipts.ts uploadFields
 */

import { dollarsToCents } from '@meritbooks/shared';
import { uploadFields, type UploadFields } from '@/lib/validations/receipts';
import { checkReceiptFile, type CaptureFile } from './capture';

export const MAX_FILES_PER_UPLOAD = 25;

export type ParsedUpload =
  | { ok: true; files: Array<{ file: CaptureFile; error: string | null }>; fields: UploadFields; amountCents: number | null }
  | { ok: false; status: number; error: string };

function mimeOf(f: File): string {
  const t = (f.type || '').toLowerCase();
  if (t) return t;
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  return ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'heic' ? 'image/heic' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
}

export async function parseReceiptUpload(req: Request, opts: { maxFiles?: number } = {}): Promise<ParsedUpload> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { ok: false, status: 400, error: 'Expected a file upload.' };
  }
  const raw: Record<string, string> = {};
  for (const k of ['location_id', 'transaction_id', 'assignment_id', 'memo', 'job_id', 'merchant', 'amount', 'date']) {
    const v = form.get(k);
    if (typeof v === 'string' && v.trim() !== '') raw[k] = v.trim();
  }
  const parsed = uploadFields.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 422, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  const blobs = [...form.getAll('file'), ...form.getAll('files')].filter((f): f is File => f instanceof File);
  if (blobs.length === 0) return { ok: false, status: 400, error: 'Choose a photo or a file.' };
  const max = opts.maxFiles ?? MAX_FILES_PER_UPLOAD;
  if (blobs.length > max) return { ok: false, status: 400, error: `Upload at most ${max} files at once.` };
  const files: Array<{ file: CaptureFile; error: string | null }> = [];
  for (const b of blobs) {
    const meta = { fileName: b.name || 'receipt', mimeType: mimeOf(b), sizeBytes: b.size };
    const error = checkReceiptFile(meta);
    const base64 = error ? '' : Buffer.from(await b.arrayBuffer()).toString('base64');
    files.push({ file: { ...meta, base64 }, error });
  }
  const amountCents = parsed.data.amount ? dollarsToCents(parsed.data.amount) : null;
  return { ok: true, files, fields: parsed.data, amountCents };
}
