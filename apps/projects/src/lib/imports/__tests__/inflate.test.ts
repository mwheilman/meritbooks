import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { isFailure, readUpload } from '../engine';
import { boundedInflate, InflateBudgetError } from '../inflate';
import { MAX_ZIP_ENTRIES } from '../../onboarding/import/xlsx';
import { makeXlsx } from './helpers';

describe('zip-bomb limits on .xlsx uploads', () => {
  const bomb = new Uint8Array(deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0x41))); // 8 MB of "A" → a few KB
  it('an entry over the per-entry cap throws instead of allocating', () => {
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => boundedInflate(1024 * 1024, 10 * 1024 * 1024)(bomb)).toThrow();
  });
  it('the per-file budget is shared by every entry', () => {
    const small = new Uint8Array(deflateRawSync(Buffer.alloc(600 * 1024, 0x41)));
    const inflate = boundedInflate(1024 * 1024, 1024 * 1024);
    expect(inflate(small).length).toBe(600 * 1024);
    expect(() => inflate(small)).toThrow();
    const exhausted = boundedInflate(1024, 1024);
    exhausted(new Uint8Array(deflateRawSync(Buffer.alloc(1024))));
    expect(() => exhausted(new Uint8Array(deflateRawSync(Buffer.alloc(1))))).toThrow(InflateBudgetError);
  });
  it('a workbook whose sheet inflates past the cap is reported unreadable, not parsed', () => {
    const big = makeXlsx([['Job Number', 'Job Name'], ...Array.from({ length: 4000 }, (_, i) => [`J-${i}`, 'x'.repeat(200)])]);
    const ok = readUpload('jobs.xlsx', null, big, boundedInflate());
    expect(isFailure(ok)).toBe(false);
    const capped = readUpload('jobs.xlsx', null, big, boundedInflate(64 * 1024, 64 * 1024));
    expect(isFailure(capped) && capped.message).toMatch(/couldn't open that Excel file/);
  });
  it('an archive claiming more entries than a workbook has is refused', () => {
    const x = makeXlsx([['Job Number', 'Job Name'], ['1', 'A']]);
    const view = new DataView(x.buffer, x.byteOffset, x.byteLength);
    const eocd = x.length - 22;
    view.setUint16(eocd + 10, MAX_ZIP_ENTRIES + 1, true);
    const r = readUpload('jobs.xlsx', null, x, boundedInflate());
    expect(isFailure(r)).toBe(true);
  });
});
