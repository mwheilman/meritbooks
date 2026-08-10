import { describe, it, expect } from 'vitest';
import {
  evaluateTokenState,
  assertSafeUpload,
  docKindToDocType,
  isPortalDocKind,
  generatePortalToken,
  PORTAL_MAX_BYTES,
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
