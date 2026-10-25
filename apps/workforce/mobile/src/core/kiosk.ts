/**
 * Shop-floor station mode (MFG kiosk, 1122) on a shared tablet: badge → PIN → the worker's
 * operations → start / pause / stop / complete with good and scrap quantities → back to the badge
 * screen. Badge + PIN is checked online (the station locks after repeated failures); every tap
 * after that is a queued `kiosk.event` with its original time, replayed in order when Wi-Fi comes
 * back. No money on any station screen. Pure (unit-tested).
 */
import type { KioskEventCommand, KioskSession } from './contract';
import type { QueuedCommand } from './queue';

/** A worker who walks away is signed out of the station after this. */
export const KIOSK_IDLE_MS = 45_000;
export const PIN_MAX = 8;

export type PinKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'del' | 'clear';

export function pressPin(pin: string, key: PinKey): string {
  if (key === 'clear') return '';
  if (key === 'del') return pin.slice(0, -1);
  return pin.length >= PIN_MAX ? pin : pin + key;
}

export const pinReady = (pin: string) => /^\d{4,8}$/.test(pin);

/** Badge scanners type the code and Enter; trim it and refuse anything too short to be a badge. */
export function cleanBadge(raw: string): string | null {
  const b = raw.replace(/[\r\n\t]/g, '').trim();
  return b.length >= 4 && b.length <= 64 ? b : null;
}

export function sessionLive(s: Pick<KioskSession, 'expires_at'>, now: number): boolean {
  return Date.parse(s.expires_at) > now;
}

export function idle(lastTapAt: number, now: number): boolean {
  return now - lastTapAt >= KIOSK_IDLE_MS;
}

const OPEN = new Set(['pending', 'sending', 'done']);

/**
 * What the worker has running: the open punches the server gave at sign-in, plus the taps made
 * since at this station (queued or sent) for the same badge session.
 */
export function runningOperations(s: KioskSession, queued: ReadonlyArray<QueuedCommand>): Set<string> {
  const running = new Set(s.open.map((o) => o.operation_id).filter((x): x is string => !!x));
  for (const q of queued) {
    const c = q.command;
    if (c.kind !== 'kiosk.event' || c.sessionToken !== s.session_token || !OPEN.has(q.status) || !c.operationId) continue;
    if (c.action === 'START') running.add(c.operationId);
    if (c.action === 'STOP' || c.action === 'PAUSE' || c.action === 'COMPLETE') running.delete(c.operationId);
  }
  return running;
}

export function indirectRunning(s: KioskSession, queued: ReadonlyArray<QueuedCommand>): string | null {
  let code = s.open.find((o) => o.indirect_code)?.indirect_code ?? null;
  for (const q of queued) {
    const c = q.command;
    if (c.kind !== 'kiosk.event' || c.sessionToken !== s.session_token || !OPEN.has(q.status)) continue;
    if (c.action === 'INDIRECT_START') code = c.indirectCode ?? 'OTHER';
    if (c.action === 'INDIRECT_STOP') code = null;
  }
  return code;
}

export function kioskDraft(companyId: string, s: KioskSession, action: KioskEventCommand['action'], extra: Partial<Pick<KioskEventCommand, 'operationId' | 'goodQty' | 'scrapQty' | 'reason' | 'indirectCode'>> = {}): Omit<KioskEventCommand, 'id' | 'at' | 'tz' | 'geo' | 'offline'> {
  return { kind: 'kiosk.event', companyId, sessionToken: s.session_token, action, ...extra };
}

/** Plain words for the station's sign-in refusals (codes from pm.mfg_kiosk_identify). */
export function identifyRefusal(code: string | null): 'badge' | 'pin' | 'pinRequired' | 'locked' | 'busy' | 'offline' | 'other' {
  switch (code) {
    case 'PM_KIOSK_BADGE': return 'badge';
    case 'PM_KIOSK_PIN': return 'pin';
    case 'PM_KIOSK_PIN_REQUIRED': return 'pinRequired';
    case 'PM_KIOSK_DEVICE_LOCKED': return 'locked';
    case 'PM_KIOSK_RATE_LIMIT': return 'busy';
    case 'OFFLINE': return 'offline';
    default: return 'other';
  }
}

export function isKioskSession(v: unknown): v is KioskSession {
  const s = v as KioskSession;
  return typeof v === 'object' && v !== null && s.ok === true && typeof s.session_token === 'string' && Array.isArray(s.operations) && Array.isArray(s.open);
}
