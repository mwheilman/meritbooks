/**
 * Payroll-register parser — DROP-AND-PARSE payroll → payroll journal entry.
 *
 * This is the MANUAL-IMPORT path for tenants NOT on the embedded provider
 * (Check/Gusto). Instead of running payroll inside MeritBooks, the tenant runs it
 * at an outside processor (ADP, Paychex, Gusto, QuickBooks Payroll, a spreadsheet)
 * and drops the resulting PAYROLL REGISTER (a period summary PDF). Through the
 * Core AI gateway (`@meritbooks/core-ai`, feature PAYROLL_REGISTER_EXTRACT,
 * metered to core.ai_usage_log, tenant budget enforced across the combined suite)
 * the AI extracts the period TOTALS — pay date, gross wages, employee tax
 * withholdings (federal / state / FICA), employer taxes, other deductions, and net
 * pay — and this module NORMALIZES them into a proposed BALANCED payroll journal
 * entry (bigint cents), addressed by ROLE, that a human reviews and confirms.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes a debit/credit.
 * The deterministic engine (`postJournalEntry` / `check_journal_balance()`) does
 * the accounting once a human confirms via the gated confirm route. Anything the
 * model can't determine is left BLANK for the human — never guessed.
 *
 * The payroll JE shape mirrors the embedded run engine
 * (`lib/money/posting/payroll-posting.ts`), summarized to period totals:
 *
 *   DR Wages Expense (WAGES_EXPENSE)                    gross
 *   DR Employer Payroll Tax Expense (PAYROLL_TAX_EXPENSE)  Σ employer taxes
 *     CR Net Pay -> Payments in Transit (PAYMENTS_IN_TRANSIT)   net
 *     CR Federal Tax Payable (FEDERAL_TAX_PAYABLE)       fed WH + FUTA
 *     CR State Tax Payable (STATE_TAX_PAYABLE)           state/local WH + SUTA
 *     CR FICA Payable (FICA_PAYABLE)                     employee + employer FICA
 *     CR <deduction> payable (GARNISHMENT/HEALTH/RETIREMENT/ACCRUED)  deductions
 *
 * Identity that makes it balance: gross = net + employee withholdings + deductions
 * (the employee side), and employer-tax EXPENSE == employer-tax PAYABLE (the
 * employer side balances on its own). We VERIFY both — the built entry must foot
 * (debits == credits) AND the register's own arithmetic must foot; either failure
 * is FLAGGED for the human (the entry is never silently forced to balance).
 *
 * The extraction NORMALIZATION and the BALANCE CHECK are PURE and unit-tested with
 * no gateway/DB dependency (`normalizeRegisterExtraction`, `buildProposedPayrollJE`,
 * `parseAmountToCents`). The model call itself lives in `parsePayrollRegister`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import type { AccountRoleKey } from '@/lib/posting/account-roles';

export const PAYROLL_REGISTER_EXTRACT_FEATURE = 'PAYROLL_REGISTER_EXTRACT';
export const PAYROLL_REGISTER_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single raw line item the model surfaced (an employer tax or a deduction). */
export interface RegisterLineItem {
  /** Verbatim label from the register (e.g. "Employer FICA", "401(k)", "Child Support"). */
  label: string;
  cents: number;
}

/**
 * The normalized period totals extracted from a payroll register. All money is
 * bigint cents. Fields the model could not determine are 0 (and flagged) — never
 * guessed.
 */
export interface NormalizedRegister {
  payDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  employeeCount: number | null;
  grossCents: number;
  netCents: number;
  /** Employee tax withholdings (reduce net pay). */
  federalWithholdingCents: number;
  stateWithholdingCents: number;
  localWithholdingCents: number;
  ficaEmployeeCents: number;
  /** Employer-side payroll taxes (an employer EXPENSE, matched by a payable). */
  employerTaxes: RegisterLineItem[];
  /** Other employee deductions (post/pre-tax: benefits, retirement, garnishments). */
  deductions: RegisterLineItem[];
  /** Per-field model confidence, 0..1. Missing => 0. */
  confidence: Record<string, number>;
  /** Fields the UI should highlight (low confidence or blank-but-required). */
  lowConfidenceFields: string[];
}

/** One proposed journal-entry line, addressed by ROLE for downstream resolution. */
export interface ProposedPayrollLine {
  roleKey: AccountRoleKey;
  side: 'DR' | 'CR';
  cents: number;
  /** Human-facing line label for the review UI. */
  label: string;
  /** The raw register label this line came from, when applicable (traceability). */
  sourceLabel: string | null;
  /**
   * True when the source item could not be mapped to a specific liability role and
   * fell back to a generic accrual — the human should re-map the account.
   */
  degraded: boolean;
}

export interface ProposedPayrollJE {
  lines: ProposedPayrollLine[];
  totalDebitCents: number;
  totalCreditCents: number;
  /** The built entry foots: debits == credits. */
  balanced: boolean;
  /** debits - credits (0 when balanced). */
  imbalanceCents: number;
  /** The register's own arithmetic foots: gross - employee WH - deductions == net. */
  registerFoots: boolean;
  /** (gross - employee WH - deductions) - net (0 when the register foots). */
  footingDeltaCents: number;
}

export type ParseRegisterResult =
  | {
      ok: true;
      register: NormalizedRegister;
      proposed: ProposedPayrollJE;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

// ---------------------------------------------------------------------------
// Pure classifiers (documented keyword rules; refuse to guess on unknown kinds)
// ---------------------------------------------------------------------------

/**
 * Map an employer-tax label to its liability role. Employer FICA remits to the
 * FICA payable alongside the employee share; FUTA is a federal liability; SUTA /
 * state UI / ETT are state liabilities. Anything unrecognized is treated as a
 * state/local employer liability (the most common catch-all).
 */
export function classifyEmployerTaxRole(label: string): AccountRoleKey {
  const a = label.toLowerCase();
  if (/(fica|social security|soc sec|medicare|oasdi|ss\b)/.test(a)) return 'FICA_PAYABLE';
  if (/(futa|federal unemployment|fed unemploy|940)/.test(a)) return 'FEDERAL_TAX_PAYABLE';
  if (/(federal|irs|fed\b|941|944)/.test(a)) return 'FEDERAL_TAX_PAYABLE';
  // SUTA / SUI / state unemployment / ETT / state disability -> state liability.
  return 'STATE_TAX_PAYABLE';
}

/**
 * Map an employee deduction label to its liability role. Unknown kinds do NOT
 * throw (this is a summary import, not a per-employee post): they fall back to a
 * generic accrued-liability role and are FLAGGED (`degraded`) so the human can
 * remap the account rather than the parser guessing wrong.
 */
export function classifyDeductionRole(label: string): { role: AccountRoleKey; degraded: boolean } {
  const k = label.toLowerCase();
  if (/(child support|garnish|levy|withholding order|wage assignment)/.test(k)) return { role: 'GARNISHMENT_PAYABLE', degraded: false };
  if (/(health|medical|dental|vision|hsa|fsa|insurance|premium)/.test(k)) return { role: 'HEALTH_INSURANCE_PAYABLE', degraded: false };
  if (/(401|403b|457|retire|pension|roth|ira|deferral)/.test(k)) return { role: 'RETIREMENT_PAYABLE', degraded: false };
  return { role: 'ACCRUED_EXPENSES', degraded: true };
}

// ---------------------------------------------------------------------------
// Pure amount / date coercion
// ---------------------------------------------------------------------------

/**
 * Parse a dollar amount to bigint cents. Accepts numbers (assumed dollars),
 * strings with $/commas/whitespace, and parenthesized negatives "(1,234.56)".
 * Returns 0 for blank/unparseable input (never NaN). Rounds to the nearest cent.
 */
export function parseAmountToCents(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return 0;
    return Math.round(raw * 100);
  }
  if (typeof raw !== 'string') return 0;
  let s = raw.trim();
  if (s === '') return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  const cleaned = s.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned)) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

/** ISO yyyy-mm-dd or null. Rejects malformed shapes AND impossible calendar dates. */
export function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return s;
}

function toIntOrNull(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= 0 ? i : null;
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

const LOW_CONFIDENCE = 0.6;

function normalizeLineItems(raw: unknown): RegisterLineItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RegisterLineItem[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const rec = item as { label?: unknown; amount?: unknown; cents?: unknown };
    const label = typeof rec.label === 'string' ? rec.label.trim() : '';
    const cents = rec.cents !== undefined ? parseAmountToCents(rec.cents) : parseAmountToCents(rec.amount);
    if (!label || cents <= 0) continue;
    out.push({ label, cents });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure normalizer: model JSON -> NormalizedRegister
// ---------------------------------------------------------------------------

interface RawRegister {
  pay_date?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  employee_count?: unknown;
  gross_wages?: unknown;
  net_pay?: unknown;
  employee_taxes?: {
    federal?: unknown;
    state?: unknown;
    local?: unknown;
    fica_social_security?: unknown;
    fica_medicare?: unknown;
    fica?: unknown;
  };
  employer_taxes?: unknown;
  deductions?: unknown;
  confidence?: unknown;
}

/**
 * Turn the model's loose JSON into a validated NormalizedRegister. Never throws —
 * a malformed shape yields an all-zero register that the balance check will flag.
 */
export function normalizeRegisterExtraction(raw: unknown): NormalizedRegister {
  const root = (raw ?? {}) as RawRegister;
  const et = root.employee_taxes ?? {};

  const grossCents = parseAmountToCents(root.gross_wages);
  const netCents = parseAmountToCents(root.net_pay);
  const federalWithholdingCents = parseAmountToCents(et.federal);
  const stateWithholdingCents = parseAmountToCents(et.state);
  const localWithholdingCents = parseAmountToCents(et.local);
  // FICA may arrive split (SS + Medicare) or combined.
  const ficaSplit = parseAmountToCents(et.fica_social_security) + parseAmountToCents(et.fica_medicare);
  const ficaEmployeeCents = ficaSplit > 0 ? ficaSplit : parseAmountToCents(et.fica);

  const employerTaxes = normalizeLineItems(root.employer_taxes);
  const deductions = normalizeLineItems(root.deductions);

  const c = (root.confidence ?? {}) as Record<string, unknown>;
  const confidence: Record<string, number> = {
    pay_date: conf(c.pay_date),
    gross_wages: conf(c.gross_wages),
    net_pay: conf(c.net_pay),
    employee_taxes: conf(c.employee_taxes),
    employer_taxes: conf(c.employer_taxes),
    deductions: conf(c.deductions),
  };

  const low: string[] = [];
  if (toIsoDate(root.pay_date) === null) low.push('pay_date');
  else if (confidence.pay_date < LOW_CONFIDENCE) low.push('pay_date');
  if (grossCents <= 0) low.push('gross_wages');
  else if (confidence.gross_wages < LOW_CONFIDENCE) low.push('gross_wages');
  if (netCents <= 0) low.push('net_pay');
  else if (confidence.net_pay < LOW_CONFIDENCE) low.push('net_pay');
  if (confidence.employee_taxes < LOW_CONFIDENCE) low.push('employee_taxes');

  return {
    payDate: toIsoDate(root.pay_date),
    periodStart: toIsoDate(root.period_start),
    periodEnd: toIsoDate(root.period_end),
    employeeCount: toIntOrNull(root.employee_count),
    grossCents,
    netCents,
    federalWithholdingCents,
    stateWithholdingCents,
    localWithholdingCents,
    ficaEmployeeCents,
    employerTaxes,
    deductions,
    confidence,
    lowConfidenceFields: Array.from(new Set(low)),
  };
}

// ---------------------------------------------------------------------------
// Pure builder: NormalizedRegister -> proposed balanced JE + balance verification
// ---------------------------------------------------------------------------

/** Role-keyed credit accumulator so multiple sources posting to the same liability merge. */
class CreditMap {
  private readonly totals = new Map<AccountRoleKey, number>();
  private readonly labels = new Map<AccountRoleKey, string>();
  private readonly degraded = new Set<AccountRoleKey>();

  add(role: AccountRoleKey, cents: number, label: string, degraded = false): void {
    if (cents <= 0) return;
    this.totals.set(role, (this.totals.get(role) ?? 0) + cents);
    if (!this.labels.has(role)) this.labels.set(role, label);
    if (degraded) this.degraded.add(role);
  }

  toLines(): ProposedPayrollLine[] {
    const out: ProposedPayrollLine[] = [];
    for (const [role, cents] of this.totals) {
      out.push({
        roleKey: role,
        side: 'CR',
        cents,
        label: this.labels.get(role) ?? role,
        sourceLabel: null,
        degraded: this.degraded.has(role),
      });
    }
    return out;
  }
}

const ROLE_LABEL: Partial<Record<AccountRoleKey, string>> = {
  FEDERAL_TAX_PAYABLE: 'Federal tax payable',
  STATE_TAX_PAYABLE: 'State / local tax payable',
  FICA_PAYABLE: 'FICA payable (Social Security + Medicare)',
  GARNISHMENT_PAYABLE: 'Garnishments payable',
  HEALTH_INSURANCE_PAYABLE: 'Health / benefit deductions payable',
  RETIREMENT_PAYABLE: 'Retirement deductions payable',
  ACCRUED_EXPENSES: 'Other payroll deductions payable',
};

/**
 * Build the proposed balanced payroll JE from the normalized register and VERIFY
 * it foots. Pure and DB-free. Debit lines: gross wages + employer-tax expense.
 * Credit lines: net pay, employee withholdings, employer-tax payables, and
 * deduction payables (aggregated by role). Both the built entry's balance and the
 * register's own footing are reported so the caller can flag a bad register.
 */
export function buildProposedPayrollJE(reg: NormalizedRegister): ProposedPayrollJE {
  const debits: ProposedPayrollLine[] = [];
  const credits = new CreditMap();

  // ── Debit side ──────────────────────────────────────────────────────────────
  if (reg.grossCents > 0) {
    debits.push({ roleKey: 'WAGES_EXPENSE', side: 'DR', cents: reg.grossCents, label: 'Gross wages', sourceLabel: null, degraded: false });
  }
  const employerTaxTotal = reg.employerTaxes.reduce((s, t) => s + t.cents, 0);
  if (employerTaxTotal > 0) {
    debits.push({ roleKey: 'PAYROLL_TAX_EXPENSE', side: 'DR', cents: employerTaxTotal, label: 'Employer payroll taxes', sourceLabel: null, degraded: false });
  }

  // ── Credit side ─────────────────────────────────────────────────────────────
  // Net pay clears through Payments in Transit (the provider/bank debits the tenant
  // for the funding; that later clears this against cash). The human can re-map to
  // the operating bank if they book net pay straight to cash.
  const netLine: ProposedPayrollLine | null =
    reg.netCents > 0
      ? { roleKey: 'PAYMENTS_IN_TRANSIT', side: 'CR', cents: reg.netCents, label: 'Net pay (in transit)', sourceLabel: null, degraded: false }
      : null;

  // Employee withholdings.
  credits.add('FEDERAL_TAX_PAYABLE', reg.federalWithholdingCents, ROLE_LABEL.FEDERAL_TAX_PAYABLE!);
  credits.add('STATE_TAX_PAYABLE', reg.stateWithholdingCents + reg.localWithholdingCents, ROLE_LABEL.STATE_TAX_PAYABLE!);
  credits.add('FICA_PAYABLE', reg.ficaEmployeeCents, ROLE_LABEL.FICA_PAYABLE!);

  // Employer taxes -> their matching payables (balances the employer-tax expense debit).
  for (const t of reg.employerTaxes) {
    const role = classifyEmployerTaxRole(t.label);
    credits.add(role, t.cents, ROLE_LABEL[role] ?? role);
  }

  // Employee deductions -> their liability payables (garnishment/benefit/retirement).
  const deductionLines: ProposedPayrollLine[] = [];
  const deductionCredits = new CreditMap();
  for (const d of reg.deductions) {
    const { role, degraded } = classifyDeductionRole(d.label);
    deductionCredits.add(role, d.cents, ROLE_LABEL[role] ?? role, degraded);
  }
  for (const line of deductionCredits.toLines()) deductionLines.push(line);

  const creditLines = credits.toLines();
  const lines: ProposedPayrollLine[] = [
    ...debits,
    ...(netLine ? [netLine] : []),
    ...creditLines,
    ...deductionLines,
  ];

  const totalDebitCents = lines.filter((l) => l.side === 'DR').reduce((s, l) => s + l.cents, 0);
  const totalCreditCents = lines.filter((l) => l.side === 'CR').reduce((s, l) => s + l.cents, 0);
  const imbalanceCents = totalDebitCents - totalCreditCents;

  // The register's OWN arithmetic: gross must equal net + employee WH + deductions.
  const employeeWithholdingTotal =
    reg.federalWithholdingCents + reg.stateWithholdingCents + reg.localWithholdingCents + reg.ficaEmployeeCents;
  const deductionTotal = reg.deductions.reduce((s, d) => s + d.cents, 0);
  const footingDeltaCents = reg.grossCents - employeeWithholdingTotal - deductionTotal - reg.netCents;

  return {
    lines,
    totalDebitCents,
    totalCreditCents,
    balanced: imbalanceCents === 0 && totalDebitCents > 0,
    imbalanceCents,
    registerFoots: footingDeltaCents === 0 && reg.grossCents > 0,
    footingDeltaCents,
  };
}

// ---------------------------------------------------------------------------
// Model call (through the metered Core AI gateway)
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an expert payroll accountant. Read this PAYROLL REGISTER (a pay-period summary from an outside payroll processor such as ADP, Paychex, Gusto, or QuickBooks Payroll) and extract the PERIOD TOTALS needed to book the payroll journal entry.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "pay_date": "YYYY-MM-DD or null — the check/pay date",
  "period_start": "YYYY-MM-DD or null",
  "period_end": "YYYY-MM-DD or null",
  "employee_count": number or null,
  "gross_wages": number — TOTAL gross wages for the period, in DOLLARS (e.g. 52350.00). null/0 if not found,
  "employee_taxes": {
    "federal": number — total employee FEDERAL income tax withheld, in DOLLARS,
    "state": number — total employee STATE income tax withheld, in DOLLARS,
    "local": number — total employee LOCAL/city tax withheld, in DOLLARS (0 if none),
    "fica_social_security": number — total EMPLOYEE Social Security (OASDI) withheld, in DOLLARS,
    "fica_medicare": number — total EMPLOYEE Medicare withheld, in DOLLARS
  },
  "employer_taxes": [
    { "label": "string — verbatim (e.g. 'Employer FICA', 'FUTA', 'SUTA', 'State UI', 'ETT')", "amount": number — in DOLLARS }
  ],
  "deductions": [
    { "label": "string — verbatim (e.g. '401(k)', 'Health Insurance', 'Child Support', 'HSA')", "amount": number — in DOLLARS }
  ],
  "net_pay": number — TOTAL net pay (take-home) for the period, in DOLLARS,
  "confidence": {
    "pay_date": number 0-1,
    "gross_wages": number 0-1,
    "net_pay": number 0-1,
    "employee_taxes": number 0-1,
    "employer_taxes": number 0-1,
    "deductions": number 0-1
  },
  "document_note": "string or null — anything unusual (scanned/illegible, a single employee vs a full company register, YTD-only with no current period, totals don't add up)"
}

Rules:
- Report AMOUNTS IN DOLLARS as plain numbers (52350.00, not 5235000 and not "$52,350.00").
- Use the CURRENT-PERIOD column, NOT year-to-date (YTD), whenever both are shown.
- EMPLOYEE taxes are withheld from the worker (reduce net pay). EMPLOYER taxes are the company's own cost. Keep them separate — never merge them.
- Employer FICA/Social Security/Medicare match is an EMPLOYER tax. Put it in employer_taxes, NOT employee_taxes.
- If a value is not present, use 0 (for amounts) or null (for dates) and set its confidence to 0. NEVER invent a number.
- The identity gross = net + (all employee taxes) + (all deductions) should hold. If it does not, still report what you see and explain in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded payroll register into a proposed balanced payroll JE THROUGH
 * the Core AI gateway (metered, budget-capped per tenant; `orgId` scopes it,
 * `userId` attributes it). Accepts base64-encoded PDF or image data. Never throws
 * for the expected failure cases — returns `{ ok: false, ... }` so callers degrade.
 */
export async function parsePayrollRegister(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseRegisterResult> {
  const { supabase, anthropicApiKey } = deps;
  const { orgId, userId, base64Data, mediaType } = args;
  const startTime = Date.now();

  const isPdf = mediaType === 'application/pdf';
  const isImage = mediaType.startsWith('image/');
  if (!isPdf && !isImage) {
    return { ok: false, error: `Unsupported file type: ${mediaType}. Must be PDF or image.` };
  }

  const contentBlock = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64Data } }
    : {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: base64Data,
        },
      };

  let gw;
  try {
    gw = await runAiGateway(
      { supabase, anthropicApiKey },
      {
        tenant_id: orgId,
        user_id: userId ?? null,
        module: 'BOOKS',
        feature: PAYROLL_REGISTER_EXTRACT_FEATURE,
        model: PAYROLL_REGISTER_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }],
        max_tokens: 3000,
      },
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gateway error' };
  }

  if (gw.status === 'blocked' || gw.result == null) {
    return { ok: false, error: gw.message ?? 'AI request blocked', budgetBlocked: gw.status === 'blocked' };
  }

  const text = extractText(gw.result);
  if (!text) return { ok: false, error: 'Model returned an empty response' };

  const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error('[payroll-register-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const register = normalizeRegisterExtraction(parsed);
  const proposed = buildProposedPayrollJE(register);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? (() => {
          const v = (parsed as { document_note?: unknown }).document_note;
          return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
        })()
      : null;

  return {
    ok: true,
    register,
    proposed,
    model: gw.model_used ?? PAYROLL_REGISTER_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
