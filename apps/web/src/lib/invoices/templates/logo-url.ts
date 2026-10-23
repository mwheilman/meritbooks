/**
 * Invoice logos: only the tenant's own uploaded file, never an arbitrary URL (security
 * review, Wave 1 MEDIUM-6).
 *
 * The PDF renderer (@react-pdf) FETCHES a logo URL server-side. A free-form https link
 * therefore let any template editor make the server request an address of their choosing
 * (internal metadata endpoints, another tenant's signed objects, slow-loris hosts) every
 * time an invoice, statement or estimate PDF rendered — server-side request forgery.
 *
 * A logo is accepted only when it is the public URL the upload route
 * (/api/settings/invoice-branding/logo) returns for THIS org:
 *   ${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/branding/${orgId}/<file>.png|jpg
 * Anything else is refused on save and dropped (rendered as the company name) on read.
 *
 * Uploads are checked by their bytes (PNG / JPEG magic numbers), not the browser's claimed
 * MIME type, and the stored extension comes from the detected type.
 */

export const BRANDING_BUCKET = 'branding';
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export type LogoImageType = 'png' | 'jpeg';

/** Detect PNG / JPEG from the first bytes; null for anything else (SVG, WebP, HTML, …). */
export function sniffLogoType(bytes: Uint8Array): LogoImageType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

export function logoExtension(t: LogoImageType): 'png' | 'jpg' {
  return t === 'png' ? 'png' : 'jpg';
}

export function logoContentType(t: LogoImageType): 'image/png' | 'image/jpeg' {
  return t === 'png' ? 'image/png' : 'image/jpeg';
}

function supabaseOrigin(supabaseUrl: string | null | undefined): string | null {
  if (!supabaseUrl) return null;
  try {
    const u = new URL(supabaseUrl);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Is `url` this org's uploaded logo in the public branding bucket? Strict: same origin as
 * the Supabase project, the exact public-object path, the org's folder, one file segment
 * with a .png / .jpg / .jpeg name, no query string, fragment, credentials or traversal.
 */
export function isTenantLogoUrl(
  url: string | null | undefined,
  orgId: string | null | undefined,
  supabaseUrl: string | null | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL,
): boolean {
  if (!url || !orgId || url.length > 1000) return false;
  const origin = supabaseOrigin(supabaseUrl);
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin !== origin || u.username || u.password || u.search || u.hash) return false;
  const prefix = `/storage/v1/object/public/${BRANDING_BUCKET}/${orgId}/`;
  if (!u.pathname.startsWith(prefix)) return false;
  const rest = u.pathname.slice(prefix.length);
  return /^[A-Za-z0-9._-]{1,200}$/.test(rest) && !rest.includes('..') && /\.(png|jpe?g)$/i.test(rest);
}

/** The logo if it is the tenant's own upload, else null (render the company name instead). */
export function tenantLogoOrNull(url: string | null | undefined, orgId: string | null | undefined): string | null {
  return url && isTenantLogoUrl(url, orgId) ? url : null;
}

export const LOGO_URL_ERROR = 'Upload the logo here — links to images hosted elsewhere are not accepted.';
