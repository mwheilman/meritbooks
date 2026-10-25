/**
 * Rules-only helpers for the field-service completion screens and the phone (migration 1123):
 *   replyIntent        the reply to a reminder text (mirror of pm._fs_reply_intent)
 *   validateForm       required readings, ranges, red tags (mirror of pm._fs_validate_form, so the
 *                      phone checks offline exactly what the server will refuse)
 *   lineTax            per-line sales tax, integer half-up (mirror of pm._fs_tax_lines)
 *   decodeSerialYear   manufacture year from common HVAC serial formats (the nameplate read)
 * Pure; unit-tested against the SQL behaviour.
 */

export type ReplyIntent = 'CONFIRM' | 'RESCHEDULE' | 'CANCEL' | 'STOP' | 'OTHER';

export function replyIntent(body: string | null | undefined): ReplyIntent {
  const w = (body ?? '').trim().split(' ')[0]?.replace(/[^A-Za-z0-9]/g, '').toUpperCase() ?? '';
  if (['C', 'Y', 'YES', 'CONFIRM', 'CONFIRMED', 'OK', 'OKAY', '1'].includes(w)) return 'CONFIRM';
  if (['R', 'RESCHEDULE', 'RESCHED', 'CHANGE', '2'].includes(w)) return 'RESCHEDULE';
  if (['CANCEL', 'CANCELLED', '3'].includes(w)) return 'CANCEL';
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT', 'REVOKE', 'OPTOUT'].includes(w)) return 'STOP';
  return 'OTHER';
}

export type FormFieldType = 'reading' | 'number' | 'pass_fail' | 'check' | 'choice' | 'text' | 'photo';

export interface FormField {
  key: string;
  label?: string;
  type?: FormFieldType;
  unit?: string;
  min?: number;
  max?: number;
  required?: boolean;
  options?: string[];
  red_tag_on_fail?: boolean;
  red_tag_above?: number;
  red_tag_below?: number;
}

export type FormAnswer = string | number | boolean | string[] | null | undefined;

export interface FormCheck {
  missing: string[];
  out_of_range: Array<{ key: string; label: string; value: number; min?: number; max?: number; unit?: string }>;
  failed: string[];
  red_tag: boolean;
  red_tag_reason: string | null;
}

const empty = (a: FormAnswer): boolean => a == null || (typeof a === 'string' && a.trim() === '') || (Array.isArray(a) && a.length === 0);

export function validateForm(fields: ReadonlyArray<FormField>, answers: Readonly<Record<string, FormAnswer>>): FormCheck {
  const out: FormCheck = { missing: [], out_of_range: [], failed: [], red_tag: false, red_tag_reason: null };
  for (const f of fields) {
    const label = f.label ?? f.key;
    const a = answers[f.key];
    if (empty(a)) {
      if (f.required) out.missing.push(label);
      continue;
    }
    const t = f.type ?? 'text';
    if (t === 'reading' || t === 'number') {
      const v = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN;
      if (!Number.isFinite(v)) { out.missing.push(`${label} (not a number)`); continue; }
      if ((f.min != null && v < f.min) || (f.max != null && v > f.max)) {
        out.out_of_range.push({ key: f.key, label, value: v, min: f.min, max: f.max, unit: f.unit });
      }
      if ((f.red_tag_above != null && v > f.red_tag_above) || (f.red_tag_below != null && v < f.red_tag_below)) {
        out.red_tag = true;
        out.red_tag_reason ??= `${label} reading ${v}${f.unit ? ` ${f.unit}` : ''}`;
      }
    } else if (t === 'pass_fail') {
      const v = String(a).toUpperCase();
      if (!['PASS', 'FAIL', 'NA'].includes(v)) { out.missing.push(`${label} (pass, fail or n/a)`); continue; }
      if (v === 'FAIL') {
        out.failed.push(f.key);
        if (f.red_tag_on_fail) { out.red_tag = true; out.red_tag_reason ??= `${label} failed`; }
      }
    } else if (t === 'choice') {
      if (f.options && !f.options.includes(String(a))) out.missing.push(`${label} (pick one of the choices)`);
    }
  }
  return out;
}

/** Half-up integer division for a non-negative numerator (pm.fs_rdiv). */
function rdiv(n: bigint, d: bigint): bigint {
  return d === 0n ? 0n : (2n * n + d) / (2n * d);
}

/** Tax on one line in cents: sign × half-up(|amount| × rate% / 100). Rate up to 4 decimals (numeric(7,4)). */
export function lineTax(amountCents: number, ratePct: number): number {
  if (!(ratePct > 0) || amountCents === 0) return 0;
  const rate4 = BigInt(Math.round(ratePct * 10_000));
  const a = BigInt(Math.abs(Math.trunc(amountCents)));
  const t = Number(rdiv(a * rate4, 100n * 10_000n));
  return amountCents < 0 ? -t : t;
}

/** Default taxability when the company set no rule for the state (pm._fs_line_taxable). */
export function taxableByDefault(kind: string): boolean {
  return kind === 'PART' || kind === 'EQUIPMENT' || kind === 'FREIGHT';
}

/**
 * Manufacture year from a serial, for the common residential formats. Returns null when unsure —
 * the tech then types the date from the nameplate.
 *   Carrier / Bryant / Payne: WWYY…   (e.g. 1209E12345 → week 12, 2009)
 *   Trane / American Standard (2002+): YYWW… (e.g. 2312ABC… → 2023)
 *   Goodman / Amana: YYMM…            (e.g. 1805123456 → 2018)
 *   Lennox: ##YY…                     (e.g. 5819A12345 → 2019)
 *   Rheem / Ruud: …MMYY in letters+digits (e.g. W031912345 → 2019)
 */
export function decodeSerialYear(make: string | null | undefined, serial: string | null | undefined, today = new Date()): number | null {
  const s = (serial ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = (make ?? '').toLowerCase();
  const thisYear = today.getUTCFullYear();
  const yy = (n: number) => {
    const y = n + 2000;
    return y > thisYear + 1 ? y - 100 : y;
  };
  const two = (i: number) => (/^\d{2}$/.test(s.slice(i, i + 2)) ? Number(s.slice(i, i + 2)) : null);
  let y: number | null = null;
  if (/carrier|bryant|payne|day ?& ?night|heil|tempstar/.test(m)) { const v = two(2); y = v == null ? null : yy(v); }
  else if (/trane|american standard/.test(m)) { const v = two(0); y = v == null ? null : yy(v); }
  else if (/goodman|amana|daikin/.test(m)) { const v = two(0); y = v == null ? null : yy(v); }
  else if (/lennox|armstrong|ducane/.test(m)) { const v = two(2); y = v == null ? null : yy(v); }
  else if (/rheem|ruud/.test(m)) { const mm = s.match(/^[A-Z](\d{2})(\d{2})/); y = mm ? yy(Number(mm[2])) : null; }
  if (y == null || y < 1970 || y > thisYear + 1) return null;
  return y;
}
