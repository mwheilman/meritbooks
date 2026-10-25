/**
 * The one-screen HTML page the no-account trade links render (lib-only so it is unit-tested):
 * every interpolated value goes through esc(); the style is inline (merit-ui colours, system font —
 * the page is opened on a phone from a text message, outside the app shell).
 */

/** HTML-escape anything (null / undefined → ''). */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"'`=/]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** "1,250.5" → 125050; '' → null; anything else → undefined (invalid). */
export function centsFromDollars(s: string): number | null | undefined {
  const t = s.trim().replace(/[$,\s]/g, '');
  if (t === '') return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return undefined;
  const [d, c = ''] = t.split('.');
  return Number(d) * 100 + Number((c + '00').slice(0, 2));
}

const CSS = `
:root{color-scheme:light}body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#F5F3EF;color:#0A1628}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:8px 0 12px;border-bottom:2px solid #2563EB;padding-bottom:8px}
dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:0 0 16px}dt{color:#3D4F65;font-size:13px;text-transform:uppercase;letter-spacing:.04em}dd{margin:0}
form{background:#FDFCFA;border:1px solid #E1E5EA;padding:12px;margin:12px 0}label{display:block;margin:8px 0;font-size:14px;color:#3D4F65}
input,textarea{display:block;width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #CCD3DB;margin-top:4px;background:#FFFFFF}
input[type=checkbox]{display:inline;width:auto;margin-right:6px}textarea{min-height:80px}
button{font:inherit;padding:12px 16px;border:1px solid #0A1628;background:#FFFFFF;color:#0A1628;width:100%;margin-top:8px;cursor:pointer}
button.primary{background:#2563EB;border-color:#2563EB;color:#FFFFFF;font-weight:600}table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #E1E5EA;vertical-align:top}td input{margin:0}small{color:#3D4F65}
.ok{background:#EBF2FE;border-left:3px solid #2563EB;padding:10px 12px}footer{color:#3D4F65;font-size:12px;margin-top:24px}`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main><h1>${esc(title)}</h1>${body}<footer>Sent to you by your builder through Merit Projects. This link works only for you; do not forward it.</footer></main></body></html>`;
}

/**
 * The client address for the per-client trade-link rate limit, from what the platform sets — never
 * from the request body or the caller-controlled left end of x-forwarded-for. On Vercel,
 * x-vercel-forwarded-for is written by the edge (a client cannot set it); otherwise NextRequest.ip,
 * then the RIGHTMOST x-forwarded-for hop (the one the nearest trusted proxy appended). Null when
 * none is present (the database then buckets the call as 'unknown'; the per-link and global caps
 * still apply).
 */
export function trustedClientIp(headers: Pick<Headers, 'get'>, platformIp?: string | null): string | null {
  const clean = (v: string | null | undefined): string | null => {
    const t = (v ?? '').trim();
    return t && t.length <= 100 && /^[0-9a-fA-F:.]+$/.test(t) ? t : null;
  };
  const vercel = headers.get('x-vercel-forwarded-for');
  if (vercel) {
    const first = clean(vercel.split(',')[0]);
    if (first) return first;
  }
  const ip = clean(platformIp);
  if (ip) return ip;
  const hops = (headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return clean(hops[hops.length - 1]);
}
