/**
 * The phone itself: GPS at the moment of a punch (never tracked in between), the camera (photos
 * are copied into the app's own storage before they are queued), ids, time zone and language.
 */
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as Localization from 'expo-localization';
import * as Location from 'expo-location';
import type { Geo } from '@/core/contract';
import { langFromLocale, type Lang } from '@/core/i18n';
import { fitWithin, shrinkToLimit } from '@/core/photoSize';

export function newId(): string {
  return Crypto.randomUUID();
}

export function deviceTimeZone(): string | null {
  return Localization.getCalendars()[0]?.timeZone ?? null;
}

export function deviceLang(): Lang {
  return langFromLocale(Localization.getLocales()[0]?.languageTag);
}

/** Today in the phone's time zone ("2026-10-24"). */
export function localDay(iso: string | number = Date.now()): string {
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function clockText(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleTimeString(lang === 'es' ? 'es-US' : 'en-US', { hour: 'numeric', minute: '2-digit' });
}

let askedLocation = false;

/** One GPS fix for this punch, or null (permission off, no fix in 8 s). Never blocks a punch. */
export async function currentFix(): Promise<Geo | null> {
  try {
    let perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted && !askedLocation && perm.canAskAgain) {
      askedLocation = true;
      perm = await Location.requestForegroundPermissionsAsync();
    }
    if (!perm.granted) return null;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000));
    const fix = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), timeout]);
    const pos = fix ?? (await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }));
    if (!pos) return null;
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null };
  } catch {
    return null;
  }
}

function photoDir(): Directory {
  const dir = new Directory(Paths.document, 'photos');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export type PhotoCapture = { ok: true; uri: string } | { ok: false; reason: 'denied' | 'cancelled' | 'failed' | 'too_large' };

function sizeOf(uri: string): number {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Longest edge ≤ 2048 px, JPEG, quality stepped down until ≤ 3.5 MB (core/photoSize), so the
 * upload stays under the server host's 4.5 MB request limit.
 */
async function shrinkPhoto(uri: string, width: number, height: number): Promise<string> {
  const longest = Math.max(width, height) || 2048;
  const result = await shrinkToLimit(async (maxEdge, quality) => {
    const ctx = ImageManipulator.manipulate(uri);
    const target = fitWithin(width || longest, height || longest, maxEdge);
    if (target) ctx.resize(target);
    const ref = await ctx.renderAsync();
    const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress: quality });
    return { uri: saved.uri, bytes: sizeOf(saved.uri) };
  }, undefined, Math.min(2048, longest));
  for (const u of result.discarded) removePhoto(u);
  return result.uri;
}

/** Take a photo, shrink it, and copy it into the app's storage as <commandId>.jpg BEFORE anything is queued. */
export async function capturePhoto(commandId: string): Promise<PhotoCapture> {
  try {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'denied' };
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9, exif: false, allowsEditing: false });
    const asset = r.canceled ? undefined : r.assets[0];
    if (!asset) return { ok: false, reason: 'cancelled' };
    let small: string;
    try {
      small = await shrinkPhoto(asset.uri, asset.width, asset.height);
    } catch {
      return { ok: false, reason: 'too_large' };
    }
    // Moving into the app's photos folder can fail if the phone locks mid-write (iOS file protection):
    // keep the shrunk copy where it is (app-private cache, wiped on sign-out) rather than lose the photo.
    try {
      const dest = new File(photoDir(), `${commandId}.jpg`);
      await new File(small).move(dest);
      return { ok: true, uri: dest.uri };
    } catch {
      return new File(small).exists ? { ok: true, uri: small } : { ok: false, reason: 'failed' };
    }
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export function photoExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export function removePhoto(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // already gone
  }
}
