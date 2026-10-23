/** Security review M8 — opening a W-9 image is a logged TIN reveal. */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FieldLevel } from '@/lib/rbac/field-masks';
import { DocAccessError, inlineAllowed, isTinBearingDoc, mayOpenW9, revealTinDocument } from './doc-access';

const client = {} as SupabaseClient;
const input = { orgId: 'o', userId: 'u', documentId: 'd', mimeType: 'application/pdf', subjectTable: 'documents', subjectId: 'd', reason: 'Reviewing W-9' };

function deps(level: FieldLevel, logged = true) {
  const logReveal = vi.fn(async () => logged);
  const sign = vi.fn(async (_c: SupabaseClient, _id: string, _e?: number, o?: { download?: boolean }) => ({ url: `u?dl=${String(o?.download)}`, fileName: 'w9.pdf' }));
  return { resolveLevel: async () => level, logReveal, sign };
}

describe('revealTinDocument', () => {
  it('hidden / masked roles cannot open a W-9 image (no log, no URL)', async () => {
    for (const level of ['hidden', 'masked'] as FieldLevel[]) {
      const d = deps(level);
      await expect(revealTinDocument(client, client, input, d)).rejects.toMatchObject({ status: 403, code: 'TIN_REVEAL_DENIED' });
      expect(d.logReveal).not.toHaveBeenCalled();
      expect(d.sign).not.toHaveBeenCalled();
    }
  });
  it('reveal_logged: logs the reveal (tin, subject, reason) BEFORE signing', async () => {
    const d = deps('reveal_logged');
    const link = await revealTinDocument(client, client, input, d);
    expect(link.url).toBe('u?dl=false');
    expect(d.logReveal).toHaveBeenCalledWith(client, expect.objectContaining({ fieldClass: 'tin', subjectTable: 'documents', subjectIds: ['d'], reason: 'Reviewing W-9', clerkUserId: 'u' }));
    expect(d.logReveal.mock.invocationCallOrder[0]).toBeLessThan(d.sign.mock.invocationCallOrder[0]);
  });
  it('no log → no URL; a missing reason is refused', async () => {
    const d = deps('visible', false);
    await expect(revealTinDocument(client, client, input, d)).rejects.toMatchObject({ code: 'REVEAL_LOG_FAILED' });
    expect(d.sign).not.toHaveBeenCalled();
    await expect(revealTinDocument(client, client, { ...input, reason: ' ' }, deps('visible'))).rejects.toBeInstanceOf(DocAccessError);
  });
  it('an unsafe type is forced to download', async () => {
    const d = deps('visible');
    expect((await revealTinDocument(client, client, { ...input, mimeType: 'text/html' }, d)).url).toBe('u?dl=true');
  });
});

describe('pure helpers', () => {
  it('classifies', () => {
    expect(mayOpenW9('reveal_logged')).toBe(true);
    expect(mayOpenW9('masked')).toBe(false);
    expect(isTinBearingDoc('W9')).toBe(true);
    expect(isTinBearingDoc('COI')).toBe(false);
    expect(inlineAllowed('image/png')).toBe(true);
    expect(inlineAllowed('image/svg+xml')).toBe(false);
  });
});
