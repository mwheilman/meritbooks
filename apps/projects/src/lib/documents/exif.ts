/**
 * Minimal EXIF reader for JPEG photos (PLT-49): capture time, GPS and device, nothing else.
 * Pure and dependency-free — runs on the server against the uploaded bytes, so the stored
 * metadata never depends on what a client claims. Unknown / malformed data yields nulls.
 */

export interface PhotoExif {
  /** ISO 8601 with offset when the camera wrote one (OffsetTimeOriginal), else built from `tzOffsetMinutes`. */
  takenAt: string | null;
  /** The camera's local clock string as written ("2026:10:01 09:03:00"). */
  takenAtRaw: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsAltM: number | null;
  make: string | null;
  model: string | null;
  width: number | null;
  height: number | null;
}

const EMPTY: PhotoExif = { takenAt: null, takenAtRaw: null, gpsLat: null, gpsLng: null, gpsAltM: null, make: null, model: null, width: null, height: null };

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface Tiff {
  view: DataView;
  start: number;
  le: boolean;
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Offset (in the view) of the value bytes. */
  at: number;
}

function readIfd(t: Tiff, offset: number): Entry[] {
  const out: Entry[] = [];
  const base = t.start + offset;
  if (base + 2 > t.view.byteLength) return out;
  const n = t.view.getUint16(base, t.le);
  if (n > 512) return out;
  for (let i = 0; i < n; i++) {
    const e = base + 2 + i * 12;
    if (e + 12 > t.view.byteLength) break;
    const tag = t.view.getUint16(e, t.le);
    const type = t.view.getUint16(e + 2, t.le);
    const count = t.view.getUint32(e + 4, t.le);
    const size = (TYPE_SIZE[type] ?? 0) * count;
    if (!size) continue;
    const at = size <= 4 ? e + 8 : t.start + t.view.getUint32(e + 8, t.le);
    if (at + size > t.view.byteLength) continue;
    out.push({ tag, type, count, at });
  }
  return out;
}

function ascii(t: Tiff, e: Entry | undefined): string | null {
  if (!e || e.type !== 2) return null;
  let s = '';
  for (let i = 0; i < e.count; i++) {
    const c = t.view.getUint8(e.at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  s = s.trim();
  return s ? s.slice(0, 80) : null;
}

function uint(t: Tiff, e: Entry | undefined): number | null {
  if (!e) return null;
  if (e.type === 3) return t.view.getUint16(e.at, t.le);
  if (e.type === 4) return t.view.getUint32(e.at, t.le);
  if (e.type === 1) return t.view.getUint8(e.at);
  return null;
}

function rationals(t: Tiff, e: Entry | undefined): number[] | null {
  if (!e || (e.type !== 5 && e.type !== 10)) return null;
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const num = e.type === 5 ? t.view.getUint32(e.at + i * 8, t.le) : t.view.getInt32(e.at + i * 8, t.le);
    const den = e.type === 5 ? t.view.getUint32(e.at + i * 8 + 4, t.le) : t.view.getInt32(e.at + i * 8 + 4, t.le);
    out.push(den === 0 ? 0 : num / den);
  }
  return out;
}

function dms(parts: number[] | null, ref: string | null, max: number): number | null {
  if (!parts || parts.length < 1) return null;
  const v = (parts[0] ?? 0) + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600;
  if (!Number.isFinite(v) || v > max) return null;
  const signed = ref === 'S' || ref === 'W' ? -v : v;
  return Math.round(signed * 1e6) / 1e6;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026:10:01 09:03:00" + "-05:00" (or a minute offset) → ISO 8601. */
export function exifDateToIso(raw: string, offset: string | null, tzOffsetMinutes = 0): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (Number(y) < 1990 || Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  let off = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : null;
  if (!off) {
    // the browser's getTimezoneOffset(): minutes BEHIND UTC (Chicago summer = 300 → "-05:00")
    const total = -Math.trunc(tzOffsetMinutes);
    if (Math.abs(total) > 14 * 60) return null;
    off = `${total < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(total) / 60))}:${pad(Math.abs(total) % 60)}`;
  }
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${off}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** Read EXIF from JPEG bytes. Never throws. */
export function readJpegExif(bytes: Uint8Array, tzOffsetMinutes = 0): PhotoExif {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { ...EMPTY };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p] !== 0xff) return { ...EMPTY };
      const marker = bytes[p + 1];
      if (marker === 0xda || marker === 0xd9) break; // start of scan / end: no EXIF before the image
      const len = view.getUint16(p + 2);
      if (len < 2) return { ...EMPTY };
      if (marker === 0xe1 && p + 10 <= bytes.length
          && bytes[p + 4] === 0x45 && bytes[p + 5] === 0x78 && bytes[p + 6] === 0x69 && bytes[p + 7] === 0x66 && bytes[p + 8] === 0 && bytes[p + 9] === 0) {
        return parseTiff(view, p + 10, tzOffsetMinutes);
      }
      p += 2 + len;
    }
    return { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

function parseTiff(view: DataView, start: number, tzOffsetMinutes: number): PhotoExif {
  const order = view.getUint16(start);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return { ...EMPTY };
  const t: Tiff = { view, start, le };
  if (view.getUint16(start + 2, le) !== 42) return { ...EMPTY };
  const ifd0 = readIfd(t, view.getUint32(start + 4, le));
  const find = (list: Entry[], tag: number) => list.find((e) => e.tag === tag);
  const make = ascii(t, find(ifd0, 0x010f));
  const model = ascii(t, find(ifd0, 0x0110));
  const exifPtr = uint(t, find(ifd0, 0x8769));
  const gpsPtr = uint(t, find(ifd0, 0x8825));
  const exif = exifPtr ? readIfd(t, exifPtr) : [];
  const raw = ascii(t, find(exif, 0x9003)) ?? ascii(t, find(ifd0, 0x0132));
  const offset = ascii(t, find(exif, 0x9011));
  const width = uint(t, find(exif, 0xa002));
  const height = uint(t, find(exif, 0xa003));
  let gpsLat: number | null = null;
  let gpsLng: number | null = null;
  let gpsAltM: number | null = null;
  if (gpsPtr) {
    const gps = readIfd(t, gpsPtr);
    gpsLat = dms(rationals(t, find(gps, 2)), ascii(t, find(gps, 1)), 90);
    gpsLng = dms(rationals(t, find(gps, 4)), ascii(t, find(gps, 3)), 180);
    const alt = rationals(t, find(gps, 6));
    const altRef = uint(t, find(gps, 5));
    if (alt && alt.length && Number.isFinite(alt[0])) gpsAltM = Math.round((altRef === 1 ? -alt[0] : alt[0]) * 10) / 10;
    if (gpsLat === 0 && gpsLng === 0) { gpsLat = null; gpsLng = null; }   // "null island" = no fix
  }
  return {
    takenAt: raw ? exifDateToIso(raw, offset, tzOffsetMinutes) : null,
    takenAtRaw: raw,
    gpsLat, gpsLng, gpsAltM, make, model,
    width: width && width > 0 ? width : null,
    height: height && height > 0 ? height : null,
  };
}
