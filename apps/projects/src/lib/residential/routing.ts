/**
 * Drive-time model for in-home appointments (RES-10 / FLR-07 / ID-03) — the exact mirror of
 * migration 1124's pm.wc_distance_km / pm.wc_drive_minutes, so the slot preview in the browser
 * and the slot the database offers agree (parity-tested against SQL).
 *
 *   distance  great-circle km (R = 6371.0088), rounded to 3 decimals
 *   minutes   ⌈km × 1.3 road factor ÷ 50 km/h × 60⌉ + 5 to park; 30 when a point has no coordinates
 *
 * Pure and client-safe.
 */

export interface LatLng {
  lat: number | null | undefined;
  lng: number | null | undefined;
}

const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

function known(p: LatLng): p is { lat: number; lng: number } {
  return typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

/** Great-circle distance in km, 3 decimals; null when either point is missing. */
export function distanceKm(a: LatLng, b: LatLng): number | null {
  if (!known(a) || !known(b)) return null;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  const km = 2 * R_KM * Math.asin(Math.sqrt(h));
  return Math.round(km * 1000) / 1000;
}

/** Minutes of driving the slot finder adds between two visits. */
export function driveMinutes(a: LatLng, b: LatLng): number {
  const km = distanceKm(a, b);
  if (km == null) return 30;
  return Math.ceil(((km * 1.3) / 50) * 60 - 1e-9) + 5;
}

/** "Tue Oct 27 · 9:30 AM" for a slot in the company's time zone. */
export function slotLabel(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  return `${day} · ${time}`;
}
