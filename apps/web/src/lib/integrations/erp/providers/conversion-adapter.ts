/**
 * The bridge from a direct-API pull into the EXISTING historical-conversion pipeline.
 *
 * The CSV onboarding path posts `{ companyId, asOfDate, mapping, rows }` to
 * /api/onboarding/conversion, where `mapping` is fieldKey -> column-header and `rows`
 * are the raw CSV row objects (header -> cell string). This module produces exactly
 * that `{ mapping, rows }` shape from a provider's normalized trial balance — so the
 * direct-API import is simply ANOTHER SOURCE feeding the same pipeline. There is no
 * second importer: assembly, the account mapping, the balance check, the preview, the
 * human tie-out gate, and the balanced opening JE all remain in the existing code.
 *
 * Money: the normalized rows are in CENTS. The conversion route's `money` fields
 * coerce DOLLARS -> cents, so we emit decimal-dollar strings here using integer math
 * (no floating point), and the pipeline converts them back to cents. Lossless for
 * integer cents.
 */

import { CONVERSION_SOURCE_FIELDS } from '@/lib/onboarding/conversion';
import type { ProviderTrialBalanceRow } from './types';

/** Stable synthetic column headers for the generated "CSV-shaped" rows. */
export const CONVERSION_HEADERS = {
  account: 'Account',
  name: 'Account Name',
  debit: 'Debit',
  credit: 'Credit',
} as const;

/** The input shape accepted by POST /api/onboarding/conversion. */
export interface ConversionInput {
  mapping: Record<string, string>;
  rows: Record<string, string>[];
}

/** Integer cents -> a plain decimal-dollar string ("125000" -> "1250.00"). */
export function centsToDecimalString(cents: number): string {
  if (!Number.isFinite(cents) || cents === 0) return '';
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${neg ? '-' : ''}${dollars}.${String(rem).padStart(2, '0')}`;
}

/** The fixed fieldKey -> synthetic-header mapping the conversion route expects. */
export function conversionMapping(): Record<string, string> {
  return {
    source_account: CONVERSION_HEADERS.account,
    source_name: CONVERSION_HEADERS.name,
    debit_cents: CONVERSION_HEADERS.debit,
    credit_cents: CONVERSION_HEADERS.credit,
  };
}

/**
 * Turn a provider's normalized trial balance into the exact `{ mapping, rows }` the
 * existing conversion route accepts. Pure and total — unit-testable against fixtures.
 */
export function trialBalanceToConversionInput(
  rows: ProviderTrialBalanceRow[],
): ConversionInput {
  const outRows: Record<string, string>[] = rows
    // Drop rows with no account code (defensive — a real TB line always has one).
    .filter((r) => r.accountCode && r.accountCode.trim().length > 0)
    .map((r) => ({
      [CONVERSION_HEADERS.account]: r.accountCode.trim(),
      [CONVERSION_HEADERS.name]: r.accountName ?? '',
      [CONVERSION_HEADERS.debit]: centsToDecimalString(r.debitCents),
      [CONVERSION_HEADERS.credit]: centsToDecimalString(r.creditCents),
    }));

  return { mapping: conversionMapping(), rows: outRows };
}

/**
 * Guard: the synthetic mapping only references field keys the conversion pipeline
 * actually defines. Exposed so a test (and a future refactor) can assert the bridge
 * stays aligned with CONVERSION_SOURCE_FIELDS.
 */
export function conversionMappingIsValid(): boolean {
  const known = new Set(CONVERSION_SOURCE_FIELDS.map((f) => f.key));
  return Object.keys(conversionMapping()).every((k) => known.has(k));
}
