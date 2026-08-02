import { describe, it, expect, vi } from 'vitest';
import { parseInvoiceWithAI } from './bill-parser';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Guards the gateway-routed bill parser (canon §2: the model call goes through
 * @meritbooks/core-ai, never a direct Anthropic fetch).
 *
 * The unsupported-media-type path returns before any gateway/network call, so we
 * can assert the new org-scoped signature without a live gateway. A stub supabase
 * whose methods throw proves that path never touches the DB or the provider.
 */
describe('parseInvoiceWithAI', () => {
  it('rejects an unsupported media type before calling the gateway', async () => {
    const throwingSupabase = {
      from: vi.fn(() => {
        throw new Error('supabase must not be touched on the unsupported-type path');
      }),
    } as unknown as SupabaseClient;

    const res = await parseInvoiceWithAI(throwingSupabase, 'test-key', {
      orgId: 'org_123',
      userId: 'user_123',
      base64Data: 'AAAA',
      mediaType: 'text/plain',
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unsupported file type/i);
    expect((throwingSupabase.from as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
