/**
 * MICR E-13B line composition — PURE (ANSI X9.13 / ISO 1004 field positions).
 *
 * The line is laid out in CHARACTER POSITIONS counted from the RIGHT edge of the check
 * (position 1 = rightmost; pitch 0.125", 8 per inch; position 1's right edge sits 5/16"
 * from the check's right edge; the baseline is 3/16" above the bottom edge, inside the
 * 5/8" clear band). Business-check (auxiliary on-us) format:
 *
 *     ⑈001043⑈  ⑆123456780⑆  000123456789⑈
 *     └ aux on-us ┘ └─ transit ─┘ └── on-us ──┘   (amount field 1–12: blank, bank-encoded)
 *
 *   positions  1–12  amount field — never printed by the issuer
 *   position   13    blank
 *   positions 14–32  on-us: ⑈ at 14, account number right-justified at 15…
 *   positions 33–43  transit: ⑆ at 33 and 43, routing digits 42 … 34 (left → right)
 *   position   44    blank
 *   positions 45–…   auxiliary on-us: ⑈ at 45, check number (zero-padded), ⑈
 *
 * Symbols are carried as letters so the line is plain ASCII until it is drawn:
 *   T = ⑆ transit   U = ⑈ on-us   A = ⑇ amount   D = ⑉ dash
 */

export type MicrSymbol = 'T' | 'U' | 'A' | 'D';
export type MicrChar = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | MicrSymbol;

export const MICR_PITCH_IN = 0.125;
export const MICR_RIGHT_MARGIN_IN = 5 / 16;
export const MICR_BASELINE_IN = 3 / 16;
export const MICR_CLEAR_BAND_IN = 5 / 8;

export const ON_US_POSITION = 14;
export const TRANSIT_RIGHT_POSITION = 33;
export const TRANSIT_LEFT_POSITION = 43;
export const AUX_ON_US_RIGHT_POSITION = 45;
/** Highest position that fits on an 8.5" business check. */
export const MAX_POSITION = 65;

export class MicrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrError';
  }
}

/** ABA routing-number checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
export function isValidRoutingNumber(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split('').map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

/** Account numbers on the on-us field: 4–17 digits (no spaces or dashes on the MICR line). */
export function normalizeAccountNumber(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

export function validateMicrInputs(routing: string, account: string): string | null {
  if (!/^\d{9}$/.test(routing)) return 'The routing number must be 9 digits.';
  if (!isValidRoutingNumber(routing)) return 'That routing number fails the ABA checksum — check it against a printed check.';
  const acct = normalizeAccountNumber(account);
  if (!/^\d{4,17}$/.test(acct)) return 'The account number must be 4 to 17 digits.';
  return null;
}

/** Last-4 mask the database stores ("****0021"). */
export function maskLast4(digits: string): string {
  const d = digits.replace(/\D/g, '');
  const last = d.slice(-4);
  return `${'*'.repeat(Math.max(0, Math.min(d.length - 4, 8)))}${last}`;
}

export interface MicrInput {
  checkNumber: number;
  routing: string;
  account: string;
  /** Zero-pad the check number in the auxiliary on-us field (bank preference; default 6). */
  auxDigits?: number;
}

export interface MicrCell {
  position: number;
  char: MicrChar;
}

export interface MicrLine {
  /** Occupied positions (1 = rightmost). */
  cells: MicrCell[];
  /** Left-to-right text from the highest occupied position to position 1 (blank = space). */
  text: string;
  /** Same with the Unicode OCR symbols, for display / tests. */
  display: string;
}

const UNICODE: Record<MicrSymbol, string> = { T: '⑆', U: '⑈', A: '⑇', D: '⑉' };

export function micrDisplay(text: string): string {
  return text.replace(/[TUAD]/g, (c) => UNICODE[c as MicrSymbol]);
}

/** Compose the business-check MICR line at its X9.13 positions. Throws MicrError on bad input. */
export function composeMicrLine(input: MicrInput): MicrLine {
  const routing = input.routing.trim();
  const account = normalizeAccountNumber(input.account.trim());
  const problem = validateMicrInputs(routing, account);
  if (problem) throw new MicrError(problem);
  if (!Number.isSafeInteger(input.checkNumber) || input.checkNumber < 1 || input.checkNumber > 99_999_999) {
    throw new MicrError('The check number must be 1 to 99,999,999.');
  }
  const auxDigits = Math.min(10, Math.max(4, input.auxDigits ?? 6));
  const checkDigits = String(input.checkNumber).padStart(auxDigits, '0');

  const cells: MicrCell[] = [];
  const put = (position: number, char: MicrChar) => cells.push({ position, char });

  // On-us: ⑈ at 14, account digits right-justified at 15… (positions 15–31 max).
  put(ON_US_POSITION, 'U');
  account.split('').reverse().forEach((ch, i) => put(ON_US_POSITION + 1 + i, ch as MicrChar));

  // Transit: ⑆ 33, routing digits 34–42 (reversed so the first digit lands at 42), ⑆ 43.
  put(TRANSIT_RIGHT_POSITION, 'T');
  routing.split('').reverse().forEach((ch, i) => put(TRANSIT_RIGHT_POSITION + 1 + i, ch as MicrChar));
  put(TRANSIT_LEFT_POSITION, 'T');

  // Auxiliary on-us: ⑈ at 45, check number, ⑈.
  put(AUX_ON_US_RIGHT_POSITION, 'U');
  checkDigits.split('').reverse().forEach((ch, i) => put(AUX_ON_US_RIGHT_POSITION + 1 + i, ch as MicrChar));
  const auxLeft = AUX_ON_US_RIGHT_POSITION + 1 + checkDigits.length;
  put(auxLeft, 'U');
  if (auxLeft > MAX_POSITION) throw new MicrError('The check number is too long for the MICR line.');

  cells.sort((a, b) => b.position - a.position);
  const byPos = new Map(cells.map((c) => [c.position, c.char]));
  let text = '';
  for (let pos = auxLeft; pos >= 1; pos--) text += byPos.get(pos) ?? ' ';
  return { cells, text, display: micrDisplay(text) };
}

/**
 * The x coordinate (inches from the check's LEFT edge) of a position's character cell,
 * for a check `checkWidthIn` wide: [left, right].
 */
export function positionCellIn(position: number, checkWidthIn: number): { left: number; right: number } {
  const right = checkWidthIn - MICR_RIGHT_MARGIN_IN - (position - 1) * MICR_PITCH_IN;
  return { left: right - MICR_PITCH_IN, right };
}
