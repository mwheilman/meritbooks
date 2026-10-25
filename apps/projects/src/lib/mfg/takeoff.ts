/**
 * On-screen drawing takeoff math (MFG-05). Points are [x, y] fractions of the page (0–1, top-left
 * origin, as pdf.js renders it); the page is width × height PDF points (the 1115 revision's size).
 * A calibration (two points + their real length) gives points-per-unit. Mirrors pm._mfg5_len /
 * _mfg5_area / _mfg5_takeoff_qty in migration 1125 (parity test), so the number on screen is the
 * number the database stores.
 */

export type Pt = readonly [number, number];
export type ScaleUnit = 'IN' | 'FT' | 'MM' | 'M';
export type TakeoffKind = 'LINEAR' | 'AREA' | 'COUNT';

export interface Page {
  width: number;
  height: number;
}

export function polylineLength(points: readonly Pt[], page: Page): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    s += Math.hypot((b[0] - a[0]) * page.width, (b[1] - a[1]) * page.height);
  }
  return s;
}

/** Shoelace area of a closed polygon, in square PDF points. */
export function polygonArea(points: readonly Pt[], page: Page): number {
  if (points.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    s += a[0] * page.width * (b[1] * page.height) - b[0] * page.width * (a[1] * page.height);
  }
  return Math.abs(s) / 2;
}

/** Length in the scale unit → LF (imperial) or M (metric). */
export function toBase(len: number, unit: ScaleUnit): number {
  return unit === 'IN' ? len / 12 : unit === 'FT' ? len : unit === 'MM' ? len / 1000 : len;
}

export function uomFor(kind: TakeoffKind, unit: ScaleUnit): 'EA' | 'LF' | 'M' | 'SF' | 'M2' {
  if (kind === 'COUNT') return 'EA';
  const metric = unit === 'MM' || unit === 'M';
  if (kind === 'LINEAR') return metric ? 'M' : 'LF';
  return metric ? 'M2' : 'SF';
}

/** Points per unit from a calibration line of known length. */
export function calibrate(p1: Pt, p2: Pt, knownLength: number, page: Page): number {
  const d = polylineLength([p1, p2], page);
  if (d <= 0 || knownLength <= 0) throw new Error('Pick two different points and a length above zero.');
  return d / knownLength;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function takeoffQty(kind: TakeoffKind, points: readonly Pt[], page: Page, ptsPerUnit: number, unit: ScaleUnit): number {
  if (kind === 'COUNT') return points.length;
  if (kind === 'LINEAR') return r4(toBase(polylineLength(points, page) / ptsPerUnit, unit));
  return r4(toBase(1, unit) * toBase(1, unit) * (polygonArea(points, page) / (ptsPerUnit * ptsPerUnit)));
}

/** Clamp a pointer position (client px inside the rendered page box) to a page fraction. */
export function toFraction(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }): Pt {
  const x = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
  const y = Math.min(Math.max((clientY - box.top) / box.height, 0), 1);
  return [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6];
}
