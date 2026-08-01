export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';
import { getTierPolicy, scoreToTier, type Tier } from '@/lib/trust/score-tier';
import { compositeMatchScore } from '@/lib/services/reconciliation-match';

/**
 * GET /api/reconciliation/autopilot
 *
 * The reconciliation autopilot's read model. Two modes:
 *
 *   • No params  → { accounts, detail: null }
 *     Lightweight list of the org's bank accounts to drive the account picker.
 *
 *   • ?bank_account_id=&fiscal_period_id=  → { accounts, detail }
 *     Full reconciliation for one account/period:
 *       - matched (cleared): bank_transactions that are POSTED to the GL, with
 *         their journal entry number — these have hit the book.
 *       - unmatched (uncleared): statement lines not yet posted. For each, the
 *         AI proposes the best match (an open bill it would settle, or a vendor/AI
 *         pattern) scored with the documented composite (Vendor 40% + Amount 40%
 *         + Date 20%), then run through scoreToTier → auto / review / escalate.
 *       - summary: statement balance (from bank_reconciliations, if the statement
 *         form was run) vs GL cash cleared balance vs difference, plus running
 *         cleared / uncleared totals and tier tallies.
 *
 * READ-ONLY. Every query runs through the RLS-scoped client, so the database
 * enforces org isolation; this route never filters org_id by hand except where
 * a redundant guard makes intent explicit. Cross-schema (core) entities are
 * stitched in JS via fetchCoreMap — PostgREST cannot embed core↔public.
 */

interface BankAccountRow {
  id: string;
  account_name: string;
  account_mask: string | null;
  account_type: string;
  current_balance_cents: number | string | null;
  account_id: string; // GL cash account
  location_id: string;
}

interface TxnRow {
  id: string;
  description: string | null;
  amount_cents: number | string;
  transaction_date: string;
  status: string;
  gl_entry_id: string | null;
  match_type: string | null;
  matched_bill_id: string | null;
  match_confidence: number | string | null;
  ai_vendor_id: string | null;
  ai_confidence: number | string | null;
  ai_reasoning: string | null;
  final_vendor_id: string | null;
}

interface BillRow {
  id: string;
  bill_number: string | null;
  total_cents: number | string;
  amount_paid_cents: number | string;
  balance_cents: number | string;
  bill_date: string;
  due_date: string;
  vendor_id: string;
  status: string;
}

const OPEN_BILL_STATUSES = ['APPROVED', 'PARTIALLY_PAID', 'PENDING'] as const;
const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const bankAccountId = searchParams.get('bank_account_id');
  const fiscalPeriodId = searchParams.get('fiscal_period_id');

  // ── Account list (always) ───────────────────────────────────────────────────
  const { data: accountsRaw, error: acctErr } = await supabase
    .from('bank_accounts')
    .select('id, account_name, account_mask, account_type, current_balance_cents, account_id, location_id')
    .eq('is_active', true)
    .order('account_name', { ascending: true });
  if (acctErr) {
    console.error('[recon/autopilot] accounts query failed:', acctErr.message);
    return NextResponse.json({ error: 'Failed to load bank accounts' }, { status: 500 });
  }
  const accounts = (accountsRaw ?? []) as BankAccountRow[];

  const acctLocMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase,
    'locations',
    'id, name, short_code',
    accounts.map((a) => a.location_id),
  );

  const accountList = accounts.map((a) => {
    const loc = acctLocMap.get(a.location_id) ?? null;
    return {
      id: a.id,
      accountName: a.account_name,
      accountMask: a.account_mask ?? '',
      accountType: a.account_type,
      currentBalanceCents: num(a.current_balance_cents),
      locationId: a.location_id,
      locationName: loc?.name ?? '',
      locationCode: loc?.short_code ?? '',
    };
  });

  if (!bankAccountId || !fiscalPeriodId) {
    return NextResponse.json({ accounts: accountList, detail: null });
  }

  const account = accounts.find((a) => a.id === bankAccountId);
  if (!account) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });

  // ── Period ──────────────────────────────────────────────────────────────────
  const { data: period, error: pErr } = await supabase
    .from('fiscal_periods')
    .select('id, period_year, period_month, start_date, end_date, status')
    .eq('org_id', orgId)
    .eq('id', fiscalPeriodId)
    .single();
  if (pErr || !period) return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 });

  // ── Statement lines within the period window ─────────────────────────────────
  const { data: txnsRaw, error: txnErr } = await supabase
    .from('bank_transactions')
    .select(
      'id, description, amount_cents, transaction_date, status, gl_entry_id, match_type, matched_bill_id, match_confidence, ai_vendor_id, ai_confidence, ai_reasoning, final_vendor_id',
    )
    .eq('bank_account_id', bankAccountId)
    .gte('transaction_date', period.start_date)
    .lte('transaction_date', period.end_date)
    .order('transaction_date', { ascending: true });
  if (txnErr) {
    console.error('[recon/autopilot] transactions query failed:', txnErr.message);
    return NextResponse.json({ error: 'Failed to load transactions' }, { status: 500 });
  }
  const txns = (txnsRaw ?? []) as TxnRow[];

  const cleared = txns.filter((t) => t.status === 'POSTED' && t.gl_entry_id);
  const uncleared = txns.filter((t) => !(t.status === 'POSTED' && t.gl_entry_id));

  // ── GL cash balance through period end (the book side) ───────────────────────
  const { data: postedEntries } = await supabase
    .from('gl_entries')
    .select('id')
    .eq('org_id', orgId)
    .eq('location_id', account.location_id)
    .eq('status', 'POSTED')
    .lte('entry_date', period.end_date);
  const postedIds = (postedEntries ?? []).map((e) => (e as { id: string }).id);

  let glCashBalanceCents = 0;
  if (postedIds.length > 0) {
    // Chunk the IN() list defensively for accounts with long histories.
    for (let i = 0; i < postedIds.length; i += 500) {
      const slice = postedIds.slice(i, i + 500);
      const { data: lines } = await supabase
        .from('gl_entry_lines')
        .select('debit_cents, credit_cents')
        .eq('account_id', account.account_id)
        .in('gl_entry_id', slice);
      for (const l of lines ?? []) {
        glCashBalanceCents += num((l as { debit_cents: number }).debit_cents) - num((l as { credit_cents: number }).credit_cents);
      }
    }
  }

  // ── GL entry numbers for the cleared rows ────────────────────────────────────
  const glEntryMap = new Map<string, { entryNumber: string; entryDate: string }>();
  const clearedGlIds = cleared.map((t) => t.gl_entry_id).filter((x): x is string => !!x);
  if (clearedGlIds.length > 0) {
    const { data: glEntries } = await supabase
      .from('gl_entries')
      .select('id, entry_number, entry_date')
      .in('id', clearedGlIds);
    for (const e of glEntries ?? []) {
      const row = e as { id: string; entry_number: string; entry_date: string };
      glEntryMap.set(row.id, { entryNumber: row.entry_number, entryDate: row.entry_date });
    }
  }

  // ── Open bills for this location (outflow settlement candidates) ─────────────
  const { data: billsRaw } = await supabase
    .from('bills')
    .select('id, bill_number, total_cents, amount_paid_cents, balance_cents, bill_date, due_date, vendor_id, status')
    .eq('location_id', account.location_id)
    .in('status', OPEN_BILL_STATUSES as unknown as string[])
    .gt('balance_cents', 0)
    .limit(500);
  const bills = (billsRaw ?? []) as BillRow[];

  // Vendor names: bills + AI-suggested vendors on uncleared lines (core.vendors).
  const vendorIds = [
    ...bills.map((b) => b.vendor_id),
    ...uncleared.map((t) => t.ai_vendor_id),
    ...uncleared.map((t) => t.final_vendor_id),
  ];
  const vendorMap = await fetchCoreMap<{ id: string; name: string }>(
    supabase,
    'vendors',
    'id, name',
    vendorIds,
  );

  const policy = await getTierPolicy(supabase, orgId);

  // ── Build proposals for uncleared lines ──────────────────────────────────────
  const tierTally: Record<Tier, number> = { auto: 0, review: 0, escalate: 0 };
  const MIN_BILL_SCORE = 0.4; // below this a bill "match" is noise, not a proposal

  const unmatched = uncleared.map((t) => {
    const amountCents = num(t.amount_cents);
    const absCents = Math.abs(amountCents);
    const isOutflow = amountCents < 0;

    // Candidate 1 — best open bill (outflows only).
    let bestBill: { bill: BillRow; score: number; breakdown: ReturnType<typeof compositeMatchScore> } | null = null;
    if (isOutflow) {
      for (const bill of bills) {
        const candidateCents = num(bill.balance_cents) || num(bill.total_cents);
        const vendorName = vendorMap.get(bill.vendor_id)?.name ?? '';
        const breakdown = compositeMatchScore({
          txnText: t.description,
          txnAmountCents: absCents,
          txnDate: t.transaction_date,
          candidateText: vendorName,
          candidateAmountCents: candidateCents,
          candidateDate: bill.due_date || bill.bill_date,
        });
        if (!bestBill || breakdown.score > bestBill.score) {
          bestBill = { bill, score: breakdown.score, breakdown };
        }
      }
    }

    // Candidate 2 — AI/vendor pattern suggestion already on the row.
    const patternConfidence = t.ai_confidence != null ? num(t.ai_confidence) : 0;
    const patternVendor = t.ai_vendor_id ? vendorMap.get(t.ai_vendor_id)?.name ?? null : null;

    // Choose the stronger candidate.
    type Proposal = {
      candidateType: 'bill' | 'pattern' | 'none';
      candidateId: string | null;
      candidateLabel: string;
      confidence: number;
      breakdown: { vendor: number; amount: number; date: number } | null;
      reason: string;
    };

    let proposal: Proposal;
    const billQualifies = bestBill && bestBill.score >= MIN_BILL_SCORE;

    if (billQualifies && bestBill && bestBill.score >= patternConfidence) {
      const vendorName = vendorMap.get(bestBill.bill.vendor_id)?.name ?? 'Vendor';
      proposal = {
        candidateType: 'bill',
        candidateId: bestBill.bill.id,
        candidateLabel: `${vendorName}${bestBill.bill.bill_number ? ` · ${bestBill.bill.bill_number}` : ''}`,
        confidence: bestBill.score,
        breakdown: {
          vendor: bestBill.breakdown.vendorScore,
          amount: bestBill.breakdown.amountScore,
          date: bestBill.breakdown.dateScore,
        },
        reason: bestBill.breakdown.explanation,
      };
    } else if (patternConfidence > 0) {
      proposal = {
        candidateType: 'pattern',
        candidateId: t.ai_vendor_id,
        candidateLabel: patternVendor ?? 'AI category suggestion',
        confidence: patternConfidence,
        breakdown: null,
        reason: t.ai_reasoning ?? 'AI vendor/category pattern suggestion from the bank feed.',
      };
    } else {
      proposal = {
        candidateType: 'none',
        candidateId: null,
        candidateLabel: 'No confident match',
        confidence: 0,
        breakdown: null,
        reason: 'No open bill or learned pattern scored high enough — needs a human.',
      };
    }

    const { tier, reason: tierReason } = scoreToTier(
      { confidence: proposal.confidence, amountCents: absCents },
      policy,
    );
    tierTally[tier] += 1;

    const persisted = t.matched_bill_id || (t.match_type && t.match_type !== 'NONE')
      ? {
          matched: true,
          type: t.match_type,
          billId: t.matched_bill_id,
          confidence: t.match_confidence != null ? num(t.match_confidence) : null,
        }
      : null;

    return {
      id: t.id,
      description: t.description ?? 'Bank transaction',
      amountCents,
      absCents,
      isOutflow,
      transactionDate: t.transaction_date,
      status: t.status,
      persisted,
      proposal: { ...proposal, tier, tierReason },
    };
  });

  const matched = cleared.map((t) => {
    const gl = t.gl_entry_id ? glEntryMap.get(t.gl_entry_id) ?? null : null;
    return {
      id: t.id,
      description: t.description ?? 'Bank transaction',
      amountCents: num(t.amount_cents),
      transactionDate: t.transaction_date,
      glEntryId: t.gl_entry_id,
      glEntryNumber: gl?.entryNumber ?? null,
    };
  });

  // ── Statement balance from the statement-reconciliation form, if run ─────────
  const { data: rec } = await supabase
    .from('bank_reconciliations')
    .select('statement_ending_balance_cents, adjusted_bank_balance_cents, difference_cents, is_reconciled, created_at')
    .eq('bank_account_id', bankAccountId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const statementBalanceCents =
    rec && rec.statement_ending_balance_cents != null ? num(rec.statement_ending_balance_cents) : null;
  const differenceCents = statementBalanceCents != null ? glCashBalanceCents - statementBalanceCents : null;

  const clearedAmountCents = matched.reduce((s, m) => s + m.amountCents, 0);
  const unclearedAmountCents = unmatched.reduce((s, u) => s + u.amountCents, 0);

  const loc = acctLocMap.get(account.location_id) ?? null;

  return NextResponse.json({
    accounts: accountList,
    detail: {
      account: {
        id: account.id,
        accountName: account.account_name,
        accountMask: account.account_mask ?? '',
        accountType: account.account_type,
        locationId: account.location_id,
        locationName: loc?.name ?? '',
        locationCode: loc?.short_code ?? '',
      },
      period: {
        id: period.id,
        year: period.period_year,
        month: period.period_month,
        startDate: period.start_date,
        endDate: period.end_date,
        status: period.status,
      },
      summary: {
        glCashBalanceCents,
        statementBalanceCents,
        differenceCents,
        isReconciled: rec?.is_reconciled ?? false,
        clearedCount: matched.length,
        clearedAmountCents,
        unclearedCount: unmatched.length,
        unclearedAmountCents,
        autoCount: tierTally.auto,
        reviewCount: tierTally.review,
        escalateCount: tierTally.escalate,
      },
      matched,
      unmatched,
    },
  });
}
