/**
 * Field-service checklists with readings (FS-29) on the phone, offline: the same checks the server
 * runs (mirror of apps/projects lib/fieldservice/rules.ts validateForm), so the tech sees a missing
 * reading, an out-of-range value or a red tag before leaving the house. Plus the will-call pickup
 * draft. Pure (unit-tested).
 */
import type { FormAnswer, FormField, FsWillCallCommand, WillCall } from './contract';

export interface FormCheck {
  missing: string[];
  outOfRange: Array<{ key: string; label: string; value: number; min?: number; max?: number; unit?: string }>;
  failed: string[];
  redTag: boolean;
  redTagReason: string | null;
}

const empty = (a: FormAnswer | undefined): boolean => a == null || (typeof a === 'string' && a.trim() === '') || (Array.isArray(a) && a.length === 0);

export function validateForm(fields: ReadonlyArray<FormField>, answers: Readonly<Record<string, FormAnswer | undefined>>): FormCheck {
  const out: FormCheck = { missing: [], outOfRange: [], failed: [], redTag: false, redTagReason: null };
  for (const f of fields) {
    const label = f.label ?? f.key;
    const a = answers[f.key];
    if (empty(a)) {
      if (f.required) out.missing.push(label);
      continue;
    }
    const t = f.type ?? 'text';
    if (t === 'reading' || t === 'number') {
      const v = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a.replace(',', '.')) : NaN;
      if (!Number.isFinite(v)) {
        out.missing.push(label);
        continue;
      }
      if ((f.min != null && v < f.min) || (f.max != null && v > f.max)) out.outOfRange.push({ key: f.key, label, value: v, min: f.min, max: f.max, unit: f.unit });
      if ((f.red_tag_above != null && v > f.red_tag_above) || (f.red_tag_below != null && v < f.red_tag_below)) {
        out.redTag = true;
        out.redTagReason ??= `${label} reading ${v}${f.unit ? ` ${f.unit}` : ''}`;
      }
    } else if (t === 'pass_fail') {
      const v = String(a).toUpperCase();
      if (!['PASS', 'FAIL', 'NA'].includes(v)) {
        out.missing.push(label);
        continue;
      }
      if (v === 'FAIL') {
        out.failed.push(f.key);
        if (f.red_tag_on_fail) {
          out.redTag = true;
          out.redTagReason ??= `${label} failed`;
        }
      }
    } else if (t === 'choice') {
      if (f.options && !f.options.includes(String(a))) out.missing.push(label);
    }
  }
  return out;
}

/** What the server stores: readings as numbers, the rest as typed. */
export function answersForServer(fields: ReadonlyArray<FormField>, raw: Readonly<Record<string, FormAnswer | undefined>>): Record<string, FormAnswer> {
  const out: Record<string, FormAnswer> = {};
  for (const f of fields) {
    const a = raw[f.key];
    if (empty(a)) continue;
    if ((f.type === 'reading' || f.type === 'number') && typeof a === 'string') {
      const n = Number(a.replace(',', '.'));
      out[f.key] = Number.isFinite(n) ? n : a;
    } else out[f.key] = a ?? null;
  }
  return out;
}

/** Can the form be sent? Missing required answers block it; a red tag needs a reason and the customer's name. */
export function formBlockers(check: FormCheck, o: { requiresSignature: boolean; signedName: string; drawn: boolean; redTagReason: string }): Array<'missing' | 'signature' | 'redTag'> {
  const b: Array<'missing' | 'signature' | 'redTag'> = [];
  if (check.missing.length) b.push('missing');
  if ((o.requiresSignature || check.redTag) && (!o.signedName.trim() || !o.drawn)) b.push('signature');
  if (check.redTag && !o.redTagReason.trim()) b.push('redTag');
  return b;
}

/** Will-call pickup: everything still owed on each line, unless the tech changed the count. */
export function pickupDraft(w: WillCall, qty: Readonly<Record<string, string>>, serials: Readonly<Record<string, string>>): Omit<FsWillCallCommand, 'id' | 'at' | 'tz' | 'geo' | 'offline'> | null {
  if (!w.pickup_code || !/^\d{6}$/.test(w.pickup_code)) return null;
  const lines = w.lines
    .map((l) => {
      const owed = Math.max(0, (l.qty ?? 0) - (l.received_qty ?? 0));
      const typed = qty[l.line_id];
      const q = typed !== undefined && typed.trim() !== '' ? Number(typed.replace(',', '.')) : owed;
      const s = (serials[l.line_id] ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 50);
      return { lineId: l.line_id, qty: Number.isFinite(q) ? q : 0, serials: s };
    })
    .filter((l) => l.qty > 0);
  if (!lines.length) return null;
  return { kind: 'fs.willcall.pickup', commitmentId: w.commitment_id, pickupCode: w.pickup_code, lines };
}

/** Will-calls picked up on this phone (queued or sent) drop off the list at once. */
export function pickedUpHere(queued: ReadonlyArray<{ command: { kind: string }; status: string }>): Set<string> {
  const s = new Set<string>();
  for (const q of queued) {
    if (q.command.kind !== 'fs.willcall.pickup' || q.status === 'rejected' || q.status === 'dismissed') continue;
    s.add((q.command as FsWillCallCommand).commitmentId);
  }
  return s;
}
