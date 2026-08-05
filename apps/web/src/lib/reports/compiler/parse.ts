/**
 * NL Report Compiler — the AI PARSE (mapping only, never computation).
 *
 * The model receives the user's request + the allowlisted report catalog + the
 * fixed period-descriptor grammar, and returns a STRUCTURED list of report specs
 * as JSON. That's ALL it does. Hard safety (canon):
 *   - The model NEVER computes a date and NEVER computes a number. It returns
 *     report types (allowlist), a basis, and RELATIVE period descriptors from a
 *     closed grammar. lib/reports/compiler/spec.ts expands those to concrete
 *     dates deterministically; the report engines produce every figure.
 *   - The output is validated by `compilerParseSchema` (Zod). Anything off the
 *     allowlist, any unknown descriptor, any malformed shape is DROPPED; if
 *     nothing valid remains, the caller ABSTAINS (never guesses).
 *   - No SQL, table names, org ids, or account numbers are ever emitted or read
 *     from the model.
 */

import {
  REPORT_CATALOG,
  REPORT_TYPES,
  compilerParseSchema,
  type CompilerParse,
} from './spec';

export const COMPILER_FEATURE = 'REPORT_COMPILER';

export const COMPILER_SYSTEM =
  'You are a report-pack planner for an accounting book of record. You translate a ' +
  'plain-English request into a STRUCTURED list of report specifications. You do NOT ' +
  'compute any dates, amounts, or figures, and you do NOT write SQL — you only choose ' +
  'report types from a fixed allowlist, a basis, and RELATIVE period descriptors from a ' +
  'fixed grammar. Deterministic code turns your descriptors into concrete dates and the ' +
  'ledger produces every number. If the request names a report type or basis that is not ' +
  'on the allowlist, omit it. If nothing on the allowlist matches, return an empty list.';

/** Build the user-turn prompt: the catalog + grammar + the request. */
export function buildCompilerPrompt(userPrompt: string): string {
  const catalog = REPORT_TYPES.map((t) => {
    const e = REPORT_CATALOG[t];
    const basis =
      e.cashBasis === 'FULL'
        ? 'basis: ACCRUAL or CASH'
        : e.supportsBasis
          ? 'basis: ACCRUAL (cash not available)'
          : 'basis: ACCRUAL only';
    return `- "${t}": ${e.description}\n    period: ${e.periodKind} | ${basis}`;
  }).join('\n');

  return `ALLOWLISTED REPORTS (choose only these ids):
${catalog}

PERIOD DESCRIPTOR GRAMMAR (choose only these; NEVER invent a concrete date except EXPLICIT):
- { "type": "LAST_N_FISCAL_YEARS", "n": <1-10> }   → the N full fiscal years before the current one (e.g. "last three years" → n:3)
- { "type": "FISCAL_YEAR", "offset": <-20..0> }    → a single fiscal year; 0 = current (year to date), -1 = last full year
- { "type": "CALENDAR_YEAR", "year": <YYYY> }      → a fiscal year the user named explicitly (e.g. "2023")
- { "type": "FISCAL_YTD", "throughMonth": <1-12 optional> } → current fiscal year to date; throughMonth caps it ("this year through June" → throughMonth:6)
- { "type": "LAST_N_MONTHS", "n": <1-60> }         → trailing N whole months
- { "type": "EXPLICIT", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" } → ONLY when the user literally states exact calendar dates

RULES:
- Return one spec per (report type + basis) the user asked for. A report can carry MULTIPLE period descriptors (e.g. two different windows).
- For AS_OF reports (balance sheet, trial balance) the period end is used as the "as of" date; still express the periods using the grammar above (e.g. LAST_N_FISCAL_YEARS gives one balance sheet per year-end).
- Use CASH basis ONLY if the user explicitly asks for it AND the report allows it; otherwise ACCRUAL.
- If the user asks for a report or basis NOT on the allowlist, omit that part. If nothing matches, return { "reports": [] }.
- Do NOT output any dollar figures, account numbers, org ids, SQL, or prose numbers.

USER REQUEST:
"""${userPrompt}"""

Respond with ONLY a JSON object, no markdown, no commentary:
{ "reports": [ { "report": "<id>", "basis": "ACCRUAL"|"CASH", "periods": [ <descriptor>, ... ] } ] }`;
}

/** Parse the model's JSON (tolerant of code fences) into a raw object, or null. */
export function parseCompilerRaw(text: string): unknown {
  const jsonStr = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // Grab the outermost JSON object if the model wrapped it in stray prose.
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? jsonStr.slice(start, end + 1) : jsonStr;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export type CompilerParseResult =
  | { ok: true; parse: CompilerParse }
  | { ok: false; reason: string };

/**
 * The safety gate: validate the model output against the allowlist schema.
 * `.strip()`-style validation via Zod drops unknown keys; discriminatedUnion
 * rejects unknown descriptor types; the enum rejects unknown report ids. Returns
 * `ok:false` (→ abstain) on unparseable / empty / invalid output.
 */
export function validateCompilerOutput(text: string): CompilerParseResult {
  const raw = parseCompilerRaw(text);
  if (raw == null || typeof raw !== 'object') return { ok: false, reason: 'unparseable output' };

  // Be lenient about a bare array vs { reports: [...] }.
  const candidate = Array.isArray(raw) ? { reports: raw } : raw;
  const result = compilerParseSchema.safeParse(candidate);
  if (!result.success) return { ok: false, reason: 'output failed allowlist validation' };
  if (result.data.reports.length === 0) return { ok: false, reason: 'no allowlisted reports matched' };
  return { ok: true, parse: result.data };
}
