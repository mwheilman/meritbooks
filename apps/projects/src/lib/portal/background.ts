/**
 * Run work after the response is sent (sign-in sends must not reveal, by timing, whether an
 * address has access). On Vercel this is the platform's request-context waitUntil (what
 * @vercel/functions' waitUntil calls); elsewhere the promise simply runs on. Never throws.
 */
type Ctx = { waitUntil?: (p: Promise<unknown>) => void };

export function inBackground(task: () => Promise<unknown>): void {
  const p = Promise.resolve().then(task).catch((e: unknown) => console.error('[portal] background task failed', e));
  const holder = (globalThis as Record<symbol, { get?: () => Ctx | undefined } | undefined>)[Symbol.for('@vercel/request-context')];
  try {
    holder?.get?.()?.waitUntil?.(p);
  } catch {
    // no platform context: the promise still runs
  }
}
