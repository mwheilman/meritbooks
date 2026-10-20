'use client';

/** Multipart upload to POST /api/dealer/imports/parse (the JSON api-client can't send files). */

import type { ImportFileKind } from '@/lib/dealer/types';
import type { ParseResponse } from '@/lib/dealer/imports/protocol';
import type { DealerResult } from '../../_lib/use-dealer';

export interface ParseRequest {
  locationId: string;
  fileKind: ImportFileKind;
  sourceSystem: string;
  lineId?: string | null;
  oemVendorId?: string | null;
  useAi?: boolean;
  file?: File | null;
  text?: string | null;
}

export async function uploadForParse(r: ParseRequest): Promise<DealerResult<ParseResponse>> {
  const fd = new FormData();
  fd.set('locationId', r.locationId);
  fd.set('fileKind', r.fileKind);
  if (r.sourceSystem.trim()) fd.set('sourceSystem', r.sourceSystem.trim());
  if (r.lineId) fd.set('lineId', r.lineId);
  if (r.oemVendorId) fd.set('oemVendorId', r.oemVendorId);
  if (r.useAi) fd.set('useAi', '1');
  if (r.file) fd.set('file', r.file);
  else if (r.text) fd.set('text', r.text);
  try {
    const res = await fetch('/api/dealer/imports/parse', { method: 'POST', body: fd });
    const body = (await res.json().catch(() => null)) as { data?: ParseResponse; error?: string; code?: string; details?: unknown } | null;
    if (!res.ok || !body?.data) {
      return { data: null, status: res.status, error: { error: body?.error ?? 'The upload failed', code: body?.code ?? 'ERROR', details: body?.details } };
    }
    return { data: body.data, error: null, status: res.status };
  } catch (e) {
    return { data: null, status: 0, error: { error: e instanceof Error ? e.message : 'Network error', code: 'NETWORK_ERROR' } };
  }
}
