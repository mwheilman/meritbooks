/**
 * The shop-floor station's offline queue (MFG kiosk: start / stop / quantity on a shared tablet,
 * Wi-Fi in a cabinet shop drops). Every tap becomes an event with a client id and the time it
 * happened; the station sends the queue to pm.mfg_kiosk_events in order, and the database answers
 * a replayed id with its first answer, so sending twice never double-counts. Storage is
 * injectable (the station passes window.localStorage, guarded; tests pass a Map). Pure apart from
 * the storage it is handed.
 */

export const KIOSK_ACTIONS = ['START', 'STOP', 'PAUSE', 'COMPLETE', 'INDIRECT_START', 'INDIRECT_STOP', 'REMAKE'] as const;
export type KioskAction = (typeof KIOSK_ACTIONS)[number];

export interface KioskEvent {
  client_event_id: string;
  session_token: string;
  action: KioskAction;
  operation_id?: string | null;
  good_qty?: number | null;
  scrap_qty?: number | null;
  reason?: string | null;
  indirect_code?: string | null;
  part_label?: string | null;
  remake_reason?: string | null;
  qty?: number | null;
  at: string;
}

export interface KioskResult {
  client_event_id?: string;
  ok: boolean;
  error?: string;
  replay?: boolean;
  [k: string]: unknown;
}

export interface KioskStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const MAX_QUEUE = 500;

function key(locationId: string): string {
  return `merit.kiosk.queue.${locationId}`;
}

/** A client id the database can dedupe on (≥ 8 chars, unique per tap). */
export function newEventId(now: number = Date.now(), rand: () => number = Math.random): string {
  return `k${now.toString(36)}${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

function safeRead(s: KioskStorage | null, k: string): KioskEvent[] {
  if (!s) return [];
  try {
    const raw = s.getItem(k);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as KioskEvent[]).filter((e) => e && typeof e.client_event_id === 'string') : [];
  } catch {
    return [];
  }
}

function safeWrite(s: KioskStorage | null, k: string, q: KioskEvent[]): void {
  if (!s) return;
  try {
    if (q.length) s.setItem(k, JSON.stringify(q.slice(-MAX_QUEUE))); else s.removeItem(k);
  } catch {
    /* storage full or blocked: the queue lives in memory for this page */
  }
}

export class KioskQueue {
  private mem: KioskEvent[];

  constructor(private readonly locationId: string, private readonly storage: KioskStorage | null) {
    this.mem = safeRead(storage, key(locationId));
  }

  get pending(): ReadonlyArray<KioskEvent> {
    return this.mem;
  }

  push(e: Omit<KioskEvent, 'client_event_id' | 'at'> & Partial<Pick<KioskEvent, 'client_event_id' | 'at'>>): KioskEvent {
    const ev: KioskEvent = { ...e, client_event_id: e.client_event_id ?? newEventId(), at: e.at ?? new Date().toISOString() };
    this.mem = [...this.mem, ev].slice(-MAX_QUEUE);
    safeWrite(this.storage, key(this.locationId), this.mem);
    return ev;
  }

  /**
   * Send everything pending, oldest first, in batches. Events the database answered (ok or a
   * business refusal) leave the queue; a network failure keeps the rest for the next try.
   */
  async flush(send: (events: KioskEvent[]) => Promise<KioskResult[] | null>, batch = 50): Promise<{ sent: number; results: KioskResult[]; offline: boolean }> {
    const results: KioskResult[] = [];
    let sent = 0;
    while (this.mem.length) {
      const chunk = this.mem.slice(0, batch);
      let res: KioskResult[] | null;
      try {
        res = await send(chunk);
      } catch {
        res = null;
      }
      if (!res) return { sent, results, offline: true };
      results.push(...res.map((r, i) => ({ ...r, client_event_id: r.client_event_id ?? chunk[i]?.client_event_id })));
      sent += chunk.length;
      this.mem = this.mem.slice(chunk.length);
      safeWrite(this.storage, key(this.locationId), this.mem);
    }
    return { sent, results, offline: false };
  }
}

/** Minutes between two ISO times, floored, never negative. */
export function minutesBetween(a: string, b: string): number {
  const d = (Date.parse(b) - Date.parse(a)) / 60_000;
  return Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
}
