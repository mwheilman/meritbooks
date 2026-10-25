import 'server-only';
/**
 * Portal configuration (server-side).
 *   PORTAL_SERVER_KEY   ≥ 16 chars; its sha-256 must be in pm.portal_server_keys (fail closed).
 *   PORTAL_BASE_URL     public origin of this app for links in messages (https://…); falls back to
 *                       PROJECTS_APP_URL / NEXT_PUBLIC_APP_URL / VERCEL_URL.
 */
export function portalServerKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env.PORTAL_SERVER_KEY;
  return k && k.length >= 16 ? k : null;
}

export function portalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.PORTAL_BASE_URL || env.PROJECTS_APP_URL || env.NEXT_PUBLIC_APP_URL || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : 'http://localhost:3001');
  return v.replace(/\/+$/, '');
}
