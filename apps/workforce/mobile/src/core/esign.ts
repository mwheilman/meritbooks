/**
 * Customer sign-off on the technician's phone (e-sign 1115 and the field-service sale). Pure
 * checks shared by the signing screen and the sell flow (unit-tested).
 */
import type { EsignSignCommand } from './contract';

/** The public e-sign API takes at most 400 000 characters of PNG data URL. */
export const SIGNATURE_MAX_CHARS = 400_000;

/** react-native-svg's toDataURL gives bare base64; the server wants a PNG data URL. */
export function pngDataUrl(base64: string): string | null {
  const b = base64.replace(/^data:image\/png;base64,/, '').replace(/\s+/g, '');
  if (!b || !/^[A-Za-z0-9+/=]+$/.test(b)) return null;
  const url = `data:image/png;base64,${b}`;
  return url.length <= SIGNATURE_MAX_CHARS ? url : null;
}

export type SignMissing = 'consent' | 'name' | 'signature';

export function signMissing(i: { consent: boolean; name: string; drawn: boolean }): SignMissing[] {
  const m: SignMissing[] = [];
  if (!i.consent) m.push('consent');
  if (i.name.trim().length < 2) m.push('name');
  if (!i.drawn) m.push('signature');
  return m;
}

export function signDraft(token: string, name: string, png: string): Omit<EsignSignCommand, 'id' | 'at' | 'tz' | 'geo' | 'offline'> {
  return { kind: 'esign.sign', token, typedName: name.trim(), signaturePng: png, consent: true };
}

/** The signing session's file route is relative to Merit Projects; make it absolute. */
export function absoluteUrl(base: string, path: string): string | null {
  if (/^https:\/\//.test(path)) return path;
  if (!path.startsWith('/') || path.startsWith('//') || !base) return null;
  return `${base.replace(/\/+$/, '')}${path}`;
}
