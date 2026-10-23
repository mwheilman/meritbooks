/**
 * The data a printed check run needs — PURE types + shaping helpers.
 *
 * Full MICR numbers and signature bytes only ever exist inside a print request on the
 * server (read from Vault / private storage right before rendering); nothing here is
 * persisted or returned to a browser except as the rendered PDF.
 */

import { composeMicrLine, type MicrLine } from '@/lib/ap/checks/micr';
import { amountToWords, protectedAmount, wordsLine } from '@/lib/ap/checks/amount-words';
import { STUB_MAX_LINES, type CheckLayout } from './layout';

export interface ImageBytes {
  data: Buffer;
  format: 'png' | 'jpg';
}

export interface CheckStockSetup {
  layout: CheckLayout;
  offsetXPt: number;
  offsetYPt: number;
  payerName: string;
  payerAddress: string | null;
  logo: ImageBytes | null;
  bankName: string | null;
  bankAddress: string | null;
  bankFraction: string | null;
  routing: string;
  account: string;
  auxDigits: number;
  voidAfterDays: number;
  signature: ImageBytes | null;
  signature2: ImageBytes | null;
  secondSignatureOverCents: number | null;
}

export interface StubLine {
  date: string | null;
  ref: string | null;
  billAmountCents: number;
  discountCents: number;
  paidCents: number;
}

export interface PrintableCheck {
  checkNumber: number;
  checkDate: string; // YYYY-MM-DD
  payeeName: string;
  payeeAddress: string | null;
  amountCents: number;
  memo: string | null;
  stubLines: StubLine[];
}

export interface RenderedCheck extends PrintableCheck {
  micr: MicrLine;
  words: string;
  wordsFilled: string;
  numeral: string;
  /** Signatures this check requires (1, or 2 over the account's threshold). */
  signaturesRequired: 1 | 2;
  /** Signature images that will print (0–2). */
  signaturesPrinted: number;
  stubVisible: StubLine[];
  stubOverflow: number;
}

export function signaturesRequired(amountCents: number, secondOverCents: number | null): 1 | 2 {
  return secondOverCents != null && amountCents > secondOverCents ? 2 : 1;
}

export function signaturesPrinted(amountCents: number, setup: Pick<CheckStockSetup, 'signature' | 'signature2' | 'secondSignatureOverCents'>): number {
  const need = signaturesRequired(amountCents, setup.secondSignatureOverCents);
  let n = setup.signature ? 1 : 0;
  if (need === 2 && setup.signature2) n += 1;
  return n;
}

/** Everything a renderer draws for one check (throws MicrError / CheckAmountError on bad input). */
export function renderCheck(check: PrintableCheck, setup: CheckStockSetup): RenderedCheck {
  const micr = composeMicrLine({ checkNumber: check.checkNumber, routing: setup.routing, account: setup.account, auxDigits: setup.auxDigits });
  const visible = check.stubLines.length > STUB_MAX_LINES ? check.stubLines.slice(0, STUB_MAX_LINES - 1) : check.stubLines;
  return {
    ...check,
    micr,
    words: amountToWords(check.amountCents),
    wordsFilled: wordsLine(check.amountCents),
    numeral: protectedAmount(check.amountCents),
    signaturesRequired: signaturesRequired(check.amountCents, setup.secondSignatureOverCents),
    signaturesPrinted: signaturesPrinted(check.amountCents, setup),
    stubVisible: visible,
    stubOverflow: check.stubLines.length - visible.length,
  };
}

export function formatCheckDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
}

export function money(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `${String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `(${s})` : s;
}
