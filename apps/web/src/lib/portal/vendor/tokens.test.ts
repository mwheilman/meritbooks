import { describe, it, expect } from 'vitest';
import {
  evaluateTokenState,
  assertSafeUpload,
  docKindToDocType,
  isPortalDocKind,
  generatePortalToken,
  PORTAL_MAX_BYTES,
  sniffPortalMime,
  assertSafeUploadBytes,
} from './tokens';

describe('evaluateTokenState — the public-route gate', () => {
  const now = new Date('2026-08-09T12:00:00Z');

  it('is not_found for a missing row', () => {
    expect(evaluateTokenState(null, now)).toBe('not_found');
    expect(evaluateTokenState(undefined, now)).toBe('not_found');
  });

  it('is active for an ACTIVE token with no / future expiry', () => {
    expect(evaluateTokenState({ status: 'ACTIVE', expires_at: null }, now)).toBe('active');
    expect(evaluateTokenState({ status: 'ACTIVE', expires_at: '2026-12-31T00:00:00Z' }, now)).toBe('active');
  });

  it('is revoked for a REVOKED token even if not yet expired', () => {
    expect(evaluateTokenState({ status: 'REVOKED', expires_at: '2026-12-31T00:00:00Z' }, now)).toBe('revoked');
  });

  it('is expired for an ACTIVE token whose expiry has passed (sweep not required)', () => {
    expect(evaluateTokenState({ status: 'ACTIVE', expires_at: '2026-01-01T00:00:00Z' }, now)).toBe('expired');
  });

  it('honours a stored EXPIRED status', () => {
    expect(evaluateTokenState({ status: 'EXPIRED', expires_at: null }, now)).toBe('expired');
  });

  it('fails closed on an unknown status', () => {
    expect(evaluateTokenState({ status: 'WHATEVER', expires_at: null }, now)).toBe('revoked');
  });
});

describe('assertSafeUpload — file-type / size guard', () => {
  it('accepts a small PDF', () => {
    expect(assertSafeUpload({ fileName: 'w9.pdf', mimeType: 'application/pdf', size: 1024 }).ok).toBe(true);
  });

  it('accepts JPG/PNG by mime + extension', () => {
    expect(assertSafeUpload({ fileName: 'coi.jpg', mimeType: 'image/jpeg', size: 2048 }).ok).toBe(true);
    expect(assertSafeUpload({ fileName: 'coi.PNG', mimeType: 'image/png', size: 2048 }).ok).toBe(true);
  });

  it('rejects an executable / unsupported extension even with a spoofed pdf mime', () => {
    const r = assertSafeUpload({ fileName: 'evil.exe', mimeType: 'application/pdf', size: 1024 });
    expect(r.ok).toBe(false);
  });

  it('rejects a disallowed mime type', () => {
    const r = assertSafeUpload({ fileName: 'notes.txt', mimeType: 'text/plain', size: 1024 });
    expect(r.ok).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(assertSafeUpload({ fileName: 'w9.pdf', mimeType: 'application/pdf', size: 0 }).ok).toBe(false);
  });

  it('rejects a file over the size cap', () => {
    expect(assertSafeUpload({ fileName: 'w9.pdf', mimeType: 'application/pdf', size: PORTAL_MAX_BYTES + 1 }).ok).toBe(false);
  });
});

describe('doc-kind narrowing / scoping', () => {
  it('maps kinds to retention doc types', () => {
    expect(docKindToDocType('W9')).toBe('W9');
    expect(docKindToDocType('COI')).toBe('COI');
    expect(docKindToDocType('BANKING')).toBe('OTHER');
  });

  it('recognises only the known kinds (rejects arbitrary client input)', () => {
    expect(isPortalDocKind('W9')).toBe(true);
    expect(isPortalDocKind('COI')).toBe(true);
    expect(isPortalDocKind('BANKING')).toBe(true);
    expect(isPortalDocKind('SSN')).toBe(false);
    expect(isPortalDocKind('')).toBe(false);
    expect(isPortalDocKind(42)).toBe(false);
  });
});

describe('generatePortalToken', () => {
  it('produces a long, URL-safe, unique-per-call token', () => {
    const a = generatePortalToken();
    const b = generatePortalToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('assertSafeUploadBytes — magic bytes (security review LOW)', () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const HTML = new TextEncoder().encode('<html><script>alert(1)</script></html>');

  it('sniffs the three accepted types', () => {
    expect(sniffPortalMime(PDF)).toBe('application/pdf');
    expect(sniffPortalMime(PNG)).toBe('image/png');
    expect(sniffPortalMime(JPG)).toBe('image/jpeg');
    expect(sniffPortalMime(HTML)).toBeNull();
    expect(sniffPortalMime(new Uint8Array())).toBeNull();
  });
  it('returns the sniffed type for a genuine file', () => {
    expect(assertSafeUploadBytes({ fileName: 'w9.pdf', mimeType: 'application/pdf', size: 8 }, PDF)).toEqual({ ok: true, mimeType: 'application/pdf' });
    expect(assertSafeUploadBytes({ fileName: 'coi.JPEG', mimeType: '', size: 6 }, JPG)).toEqual({ ok: true, mimeType: 'image/jpeg' });
  });
  it('refuses HTML disguised as a PDF, a PNG named .pdf, and a mime that disagrees with the bytes', () => {
    expect(assertSafeUploadBytes({ fileName: 'w9.pdf', mimeType: 'application/pdf', size: 40 }, HTML).ok).toBe(false);
    expect(assertSafeUploadBytes({ fileName: 'w9.pdf', mimeType: 'application/pdf', size: 9 }, PNG).ok).toBe(false);
    expect(assertSafeUploadBytes({ fileName: 'scan.png', mimeType: 'image/jpeg', size: 9 }, PNG).ok).toBe(false);
  });
});
