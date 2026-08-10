/**
 * Observability scrub + digest — the non-negotiables.
 *
 * These assert the two properties the whole layer rides on: (1) no secret ever
 * survives into a log row, and (2) the same error fingerprints identically so the
 * dashboard groups instead of drowning.
 */

import { describe, it, expect } from 'vitest';
import { scrubString, scrubMeta, digestFor, REDACTED } from './scrub';

describe('scrubString — secrets never survive', () => {
  it('redacts Authorization: Bearer tokens', () => {
    const out = scrubString('GET /x failed with Authorization: Bearer abc.def.ghi123');
    expect(out).not.toContain('abc.def.ghi123');
    expect(out).toContain(REDACTED);
  });

  it('redacts a value under an authorization/token/apikey key (key survives, value dies)', () => {
    const out = scrubString('headers {"authorization":"sk_live_ABC123DEF456","x-api-key":"topsecretvalue"}');
    expect(out).not.toContain('sk_live_ABC123DEF456');
    expect(out).not.toContain('topsecretvalue');
    expect(out).toContain('authorization');
    expect(out).toContain(REDACTED);
  });

  it('redacts Stripe/Clerk keys, webhook secrets, JWTs and Anthropic keys by shape', () => {
    const raw = [
      'pk_test_51ABCdef',
      'sk_live_51ZZZyyy',
      'whsec_abcdef123456',
      'sk-ant-api03-abcDEF123456ghiJKL',
      'eyJhbGciOi.eyJzdWIiOiJ1c2Vy.SIGNATUREvalue',
    ].join(' ');
    const out = scrubString(raw);
    for (const secret of ['pk_test_51ABCdef', 'sk_live_51ZZZyyy', 'whsec_abcdef123456', 'sk-ant-api03-abcDEF123456ghiJKL', 'eyJhbGciOi.eyJzdWIiOiJ1c2Vy.SIGNATUREvalue']) {
      expect(out).not.toContain(secret);
    }
  });

  it('is safe on empty / nullish input', () => {
    expect(scrubString('')).toBe('');
    expect(scrubString(null)).toBe('');
    expect(scrubString(undefined)).toBe('');
  });
});

describe('scrubMeta — deep redaction, JSON-safe, never loops', () => {
  it('blanks values under secret-named keys and scrubs nested strings', () => {
    const meta = {
      route: '/api/pay',
      cookie: 'session=abc123',
      nested: { apiKey: 'secretkey', note: 'Bearer zzz.yyy.xxx' },
    };
    const out = scrubMeta(meta) as Record<string, unknown>;
    expect(out.cookie).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).note).not.toContain('zzz.yyy.xxx');
    expect(out.route).toBe('/api/pay');
  });

  it('does not throw or loop on a circular reference', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    expect(() => scrubMeta(a)).not.toThrow();
    const out = scrubMeta(a) as Record<string, unknown>;
    expect(out.self).toBe('[Circular]');
  });
});

describe('digestFor — stable grouping', () => {
  it('is identical for two occurrences of the same error (ids/line-numbers normalized)', () => {
    const a = digestFor({
      name: 'TypeError',
      route: '/api/gl/post',
      message: 'invoice 9d1f8c2a-1111-2222-3333-444455556666 not found (attempt 3)',
      stack: 'TypeError: x\n    at post (/app/route.ts:42:10)',
    });
    const b = digestFor({
      name: 'TypeError',
      route: '/api/gl/post',
      message: 'invoice 00000000-aaaa-bbbb-cccc-999988887777 not found (attempt 17)',
      stack: 'TypeError: x\n    at post (/app/route.ts:99:4)',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differs for genuinely different errors', () => {
    const a = digestFor({ name: 'TypeError', route: '/a', message: 'boom' });
    const b = digestFor({ name: 'RangeError', route: '/a', message: 'boom' });
    const c = digestFor({ name: 'TypeError', route: '/b', message: 'boom' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
