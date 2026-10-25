/**
 * Bounded inflate for .xlsx uploads (security review: zip bombs). Every entry is capped at
 * `maxEntryBytes` uncompressed (node:zlib maxOutputLength) and one file's entries share a total
 * budget; going over throws, which the xlsx reader turns into "couldn't open that file". Create
 * one per uploaded file.
 */
import { inflateRawSync } from 'node:zlib';
import type { InflateRaw } from '../onboarding/import/xlsx';

export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_INFLATED_BYTES = 96 * 1024 * 1024;

export class InflateBudgetError extends Error {}

export function boundedInflate(maxEntryBytes = MAX_ENTRY_BYTES, maxTotalBytes = MAX_FILE_INFLATED_BYTES): InflateRaw {
  let used = 0;
  return (data: Uint8Array): Uint8Array => {
    const room = Math.min(maxEntryBytes, maxTotalBytes - used);
    if (room <= 0) throw new InflateBudgetError('uncompressed size budget used up');
    const out = new Uint8Array(inflateRawSync(data, { maxOutputLength: room }));
    used += out.length;
    return out;
  };
}
