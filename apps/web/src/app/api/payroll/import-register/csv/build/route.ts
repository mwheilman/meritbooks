export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import { buildProposedPayrollJE, type ProposedPayrollLine } from '@/lib/payroll/register-parse';
import {
  aggregateRows,
  aggregatedToNormalized,
  type ColumnMapping,
  type PayrollFieldTarget,
} from '@/lib/payroll/register-csv';

/**
 * POST /api/payroll/import-register/csv/build — DETERMINISTIC (no-AI) stage 2.
 *
 * Takes the parsed rows + the human-confirmed column mapping (from the `parse`
 * route + mapping UI) and builds the PROPOSED, BALANCED payroll journal entry —
 * summing each mapped column to period totals, normalizing into the SAME
 * `NormalizedRegister` shape the AI path produces, and running it through the shared
 * pure builder (`buildProposedPayrollJE`). Each line is addressed by ROLE with a
 * SUGGESTED account resolved from this tenant's chart (`resolveRole`); an
 * unresolvable role is REPORTED (not fatal) so the human maps it in the review UI.
 *
 * WRITES NOTHING. The confirmed entry posts through the shared, gated confirm route
 * (`POST /api/payroll/import-register/confirm` → `postJournalEntry` /
 * `check_journal_balance()`), which re-validates the balance server-side. No model is
 * called anywhere in this path.
 *
 * Access: gated on `payroll:create` (same as stage 1).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TARGETS: ReadonlySet<string> = new Set<PayrollFieldTarget>([
  'ignore', 'employee', 'gross', 'fed_wh', 'state_wh', 'local_wh', 'fica_ss',
  'fica_medicare', 'fica', 'net', 'employer_tax', 'deduction',
]);

interface BuildBody {
  rows?: unknown;
  mapping?: unknown;
  payDate?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && ISO_DATE.test(v) ? v : null;
}

interface SuggestedLine {
  roleKey: AccountRoleKey;
  side: 'DR' | 'CR';
  cents: number;
  label: string;
  degraded: boolean;
  suggestedAccountId: string | null;
  suggestedAccountNumber: string | null;
  unresolved: boolean;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'payroll', 'create');
  if (!guard.ok) return guard.response;

  let body: BuildBody;
  try {
    body = (await request.json()) as BuildBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  // ── Validate rows ─────────────────────────────────────────────────────────────
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json({ error: 'rows must be a non-empty array', code: 'VALIDATION' }, { status: 422 });
  }
  const rows: string[][] = [];
  for (const r of body.rows) {
    if (!Array.isArray(r)) {
      return NextResponse.json({ error: 'each row must be an array of cells', code: 'VALIDATION' }, { status: 422 });
    }
    rows.push(r.map((c) => (c == null ? '' : String(c))));
  }

  // ── Validate mapping ──────────────────────────────────────────────────────────
  if (!Array.isArray(body.mapping) || body.mapping.length === 0) {
    return NextResponse.json({ error: 'mapping must be a non-empty array', code: 'VALIDATION' }, { status: 422 });
  }
  const mapping: ColumnMapping[] = [];
  for (const raw of body.mapping) {
    if (raw == null || typeof raw !== 'object') {
      return NextResponse.json({ error: 'each mapping entry must be an object', code: 'VALIDATION' }, { status: 422 });
    }
    const m = raw as { header?: unknown; index?: unknown; target?: unknown; label?: unknown };
    const index = typeof m.index === 'number' ? m.index : Number(m.index);
    if (!Number.isInteger(index) || index < 0) {
      return NextResponse.json({ error: 'mapping.index must be a non-negative integer', code: 'VALIDATION' }, { status: 422 });
    }
    const target = typeof m.target === 'string' && VALID_TARGETS.has(m.target) ? (m.target as PayrollFieldTarget) : 'ignore';
    mapping.push({
      header: typeof m.header === 'string' ? m.header : `Column ${index + 1}`,
      index,
      target,
      label: typeof m.label === 'string' ? m.label : undefined,
    });
  }

  // ── Aggregate → normalize → build the balanced proposal (pure) ───────────────
  const agg = aggregateRows(rows, mapping);
  if (agg.grossCents <= 0) {
    return NextResponse.json(
      { error: 'No gross wages found. Map a Gross wages column before building the entry.', code: 'NO_GROSS' },
      { status: 422 },
    );
  }
  const normalized = aggregatedToNormalized(agg, {
    payDate: isoOrNull(body.payDate),
    periodStart: isoOrNull(body.periodStart),
    periodEnd: isoOrNull(body.periodEnd),
  });
  const proposed = buildProposedPayrollJE(normalized);

  // ── Resolve each proposed role → suggested account (degrade + REPORT) ────────
  const uniqueRoles = Array.from(new Set(proposed.lines.map((l) => l.roleKey)));
  const roleToAccount = new Map<AccountRoleKey, { id: string; number: string }>();
  const unresolvedRoles: AccountRoleKey[] = [];
  await Promise.all(
    uniqueRoles.map(async (role) => {
      try {
        const ref = await resolveRole(supabase, orgId, role);
        roleToAccount.set(role, { id: ref.id, number: ref.account_number });
      } catch (e) {
        if (e instanceof PostingError) unresolvedRoles.push(role);
        else throw e;
      }
    }),
  );

  const lines: SuggestedLine[] = proposed.lines.map((l: ProposedPayrollLine) => {
    const acct = roleToAccount.get(l.roleKey) ?? null;
    return {
      roleKey: l.roleKey,
      side: l.side,
      cents: l.cents,
      label: l.label,
      degraded: l.degraded,
      suggestedAccountId: acct?.id ?? null,
      suggestedAccountNumber: acct?.number ?? null,
      unresolved: acct === null,
    };
  });

  return NextResponse.json({
    register: {
      payDate: normalized.payDate,
      periodStart: normalized.periodStart,
      periodEnd: normalized.periodEnd,
      employeeCount: normalized.employeeCount,
      grossCents: normalized.grossCents,
      netCents: normalized.netCents,
      lowConfidenceFields: normalized.lowConfidenceFields,
    },
    lines,
    balance: {
      totalDebitCents: proposed.totalDebitCents,
      totalCreditCents: proposed.totalCreditCents,
      balanced: proposed.balanced,
      imbalanceCents: proposed.imbalanceCents,
      registerFoots: proposed.registerFoots,
      footingDeltaCents: proposed.footingDeltaCents,
    },
    unresolvedRoles,
    meta: { source: 'csv', rowCount: rows.length },
  });
}
