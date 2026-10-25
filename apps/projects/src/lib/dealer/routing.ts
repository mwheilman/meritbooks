/**
 * Truck route proposal for pickup / delivery stops (DLR-41): nearest neighbour from the store,
 * respecting time windows first (a stop whose window ends earlier goes first when windows overlap
 * the drive), then a 2-opt pass on the stops without windows. Great-circle distances; deterministic.
 * The writer can drag the order; pm.dlr_set_route_order saves whichever order they keep.
 */

export interface Stop {
  id: string;
  lat: number | null;
  lng: number | null;
  window_start?: string | null; // HH:MM[:SS]
  window_end?: string | null;
}

export interface Origin {
  lat: number | null;
  lng: number | null;
}

export function meters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const minutes = (t: string | null | undefined): number | null => {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const located = (s: Stop): s is Stop & { lat: number; lng: number } => s.lat != null && s.lng != null;

/** Total route length in meters (origin → stops in order), counting only located stops. */
export function routeLength(origin: Origin, order: readonly Stop[]): number {
  let total = 0;
  let cur: { lat: number; lng: number } | null = origin.lat != null && origin.lng != null ? { lat: origin.lat, lng: origin.lng } : null;
  for (const s of order) {
    if (!located(s)) continue;
    if (cur) total += meters(cur.lat, cur.lng, s.lat, s.lng);
    cur = { lat: s.lat, lng: s.lng };
  }
  return total;
}

export function proposeRoute(origin: Origin, stops: readonly Stop[]): Stop[] {
  const windowed = stops.filter((s) => minutes(s.window_end) != null).sort((a, b) => (minutes(a.window_end)! - minutes(b.window_end)!) || a.id.localeCompare(b.id));
  const free = stops.filter((s) => minutes(s.window_end) == null && located(s));
  const unlocated = stops.filter((s) => minutes(s.window_end) == null && !located(s));
  // nearest neighbour over the free stops, starting where the windowed stops end (or the store)
  const out: Stop[] = [...windowed];
  let cur: { lat: number; lng: number } | null = null;
  const lastLocated = [...windowed].reverse().find(located);
  if (lastLocated && located(lastLocated)) cur = { lat: lastLocated.lat, lng: lastLocated.lng };
  else if (origin.lat != null && origin.lng != null) cur = { lat: origin.lat, lng: origin.lng };
  const left = [...free];
  while (left.length) {
    let best = 0;
    if (cur) {
      let bd = Infinity;
      left.forEach((s, i) => {
        const d = meters(cur!.lat, cur!.lng, s.lat!, s.lng!);
        if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && s.id < left[best]!.id)) { bd = d; best = i; }
      });
    }
    const [s] = left.splice(best, 1);
    out.push(s!);
    cur = { lat: s!.lat!, lng: s!.lng! };
  }
  // 2-opt on the free tail only (windows stay in their order)
  const head = out.slice(0, windowed.length);
  let tail = out.slice(windowed.length);
  let improved = tail.length > 3;
  while (improved) {
    improved = false;
    for (let i = 0; i < tail.length - 1; i++) {
      for (let k = i + 1; k < tail.length; k++) {
        const cand = [...tail.slice(0, i), ...tail.slice(i, k + 1).reverse(), ...tail.slice(k + 1)];
        if (routeLength(origin, [...head, ...cand]) + 1e-6 < routeLength(origin, [...head, ...tail])) { tail = cand; improved = true; }
      }
    }
  }
  return [...head, ...tail, ...unlocated];
}
