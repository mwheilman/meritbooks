/**
 * Logo SSRF guard (Wave 1 security review): only the org's own upload in the public
 * branding bucket is accepted / rendered; uploads are typed by their bytes.
 */
import { describe, it, expect } from 'vitest';
import { isTenantLogoUrl, sniffLogoType, tenantLogoOrNull, logoExtension } from './logo-url';

const SB = 'https://abc123.supabase.co';
const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const good = `${SB}/storage/v1/object/public/branding/${ORG}/aaaaaaaa-0000-0000-0000-00000000000a-1729000000000.png`;

describe('isTenantLogoUrl', () => {
  it('accepts exactly the org\'s own upload', () => {
    expect(isTenantLogoUrl(good, ORG, SB)).toBe(true);
    expect(isTenantLogoUrl(`${SB}/storage/v1/object/public/branding/${ORG}/org-1.jpg`, ORG, SB)).toBe(true);
  });

  it.each([
    ['another tenant\'s folder', `${SB}/storage/v1/object/public/branding/${OTHER}/org-1.png`],
    ['another host', `https://evil.example/storage/v1/object/public/branding/${ORG}/org-1.png`],
    ['an internal address', 'http://169.254.169.254/latest/meta-data/'],
    ['plain http to the project', good.replace('https://', 'http://')],
    ['another bucket', `${SB}/storage/v1/object/public/documents/${ORG}/org-1.png`],
    ['a signed / private object path', `${SB}/storage/v1/object/sign/branding/${ORG}/org-1.png`],
    ['a query string', `${good}?x=1`],
    ['a fragment', `${good}#x`],
    ['credentials', good.replace('https://', 'https://u:p@')],
    ['traversal', `${SB}/storage/v1/object/public/branding/${ORG}/../${OTHER}/org-1.png`],
    ['a nested path', `${SB}/storage/v1/object/public/branding/${ORG}/a/b.png`],
    ['a non-image name', `${SB}/storage/v1/object/public/branding/${ORG}/org-1.svg`],
    ['not a URL', 'logo.png'],
  ])('refuses %s', (_label, url) => {
    expect(isTenantLogoUrl(url, ORG, SB)).toBe(false);
  });

  it('fails closed without an org or a configured project URL', () => {
    expect(isTenantLogoUrl(good, null, SB)).toBe(false);
    expect(isTenantLogoUrl(good, ORG, null)).toBe(false);
    expect(tenantLogoOrNull(`https://evil.example/x.png`, ORG)).toBeNull();
  });
});

describe('sniffLogoType', () => {
  it('detects PNG and JPEG by magic bytes', () => {
    expect(sniffLogoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(sniffLogoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('jpeg');
    expect(logoExtension('jpeg')).toBe('jpg');
  });
  it('refuses SVG / HTML / WebP / empty regardless of the claimed name or type', () => {
    expect(sniffLogoType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffLogoType(new TextEncoder().encode('<html><script>x</script>'))).toBeNull();
    expect(sniffLogoType(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBeNull();
    expect(sniffLogoType(new Uint8Array([]))).toBeNull();
  });
});
