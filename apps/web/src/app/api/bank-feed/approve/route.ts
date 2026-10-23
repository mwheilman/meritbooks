export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { approveBankTransactionSchema, type ApproveBankTransactionInput } from '@/lib/validations/transactions';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { recordBillPayment } from '@/lib/posting/lifecycle';
import { createAttribution } from '@/lib/services/cost-approval';
import { learnVendorPattern } from '@/lib/services/categorization';
import { logHumanAction } from '@/lib/trust/action-log';
import { requirePermission } from '@/lib/rbac/require-permission';
import { decideVendor, resolveVendorIdByName, type CurrentVendor } from '@/lib/bank/vendor-resolution';
import { serviceWriter, assertOrgRefs, isWriteScopeError } from '@/lib/db/scoped-writer';
import {
  loadFeedTxn,
  loadSplitRows,
  markRuleApplied,
  nextPostingVersion,
  postSplit,
  rowsToLineInputs,
  saveSplitRule,
  validateSplitLines,
  SplitError,
} from '@/lib/bank/splits/service';
import { splitSourceRef } from '@/lib/bank/splits/postings';

/**
 * POST /api/bank-feed/approve
 * Approves a bank/credit-card transaction: posts a JE, updates status, records the vendor pattern, and — when a job is
 * assigned — clears the job cost immediately (gate BANKFEED_CATEGORIZATION: the
 * cash already left) by emitting a CLEARED JOB_COST event through the cost/
 * billing seam. This is the categorization path that replaces the retired
 * standalone Cost Approvals tab for bank/card costs.
 *
 * Splits (FPB-bank-feed-splits, migration 177): when the body carries `splits` — or the
 * line has a saved DRAFT split — the line posts N balanced lines (one JE per company for a
 * cross-company split, with the intercompany due-to/due-from pair). Every posting stamps
 * `source_ref = bankfeed:<txn>:v<n>`; the unique index from migration 064 makes a second,
 * concurrent approve fail instead of double-posting.
 */
export const POST = apiHandler(
  approveBankTransactionSchema,
  async (body: ApproveBankTransactionInput, ctx) => {
    // Canonical org id — the token's org_id claim (a real core.organizations.id),
    // which RLS also enforces. No lookup needed.
    const orgId = ctx.orgId ?? '';

    // Authorize — approving posts a journal entry to the GL (and may settle a
    // matched bill). Gate on bank_feed:approve.
    const guard = await requirePermission(ctx.userId, 'bank_feed', 'approve');
    if (!guard.ok) return guard.response;

    const { data: txn, error: txnErr } = await ctx.supabase
      .from('bank_transactions')
      .select('*, bank_accounts(location_id, account_id)')
      .eq('id', body.transaction_id)
      .single();

    if (txnErr || !txn) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }
    if (txn.status === 'POSTED') {
      return NextResponse.json({ error: 'Transaction already posted' }, { status: 400 });
    }

    const bankAccount = txn.bank_accounts as { location_id: string; account_id: string };
    const locationId = bankAccount.location_id;
    const cashAccountId = bankAccount.account_id;
    const isOutflow = txn.amount_cents < 0;
    const absCents = Math.abs(txn.amount_cents);

    // If this outflow settles an existing bill, clear Accounts Payable rather
    // than booking a fresh expense — the bill was already expensed at approval,
    // so re-expensing the bank line would double-count (audit gap 3).
    if (body.splits && body.splits.length > 0 && isOutflow && txn.match_type === 'BILL_PAYMENT' && txn.matched_bill_id) {
      return NextResponse.json(
        { error: 'This line pays a bill, so it settles Accounts Payable and cannot be split. Unmatch the bill to split it.' },
        { status: 400 },
      );
    }
    if (isOutflow && txn.match_type === 'BILL_PAYMENT' && txn.matched_bill_id) {
      try {
        const res = await recordBillPayment(ctx.supabase, {
          orgId,
          billId: txn.matched_bill_id as string,
          amountCents: absCents,
          paymentDate: txn.transaction_date,
          method: 'OTHER',
          cashAccountId, // post the cash side to the actual bank account
          bankTransactionId: txn.id,
          createdBy: null,
        });
        // bank_transactions is SELECT-only for members (migration 172): service-role write after
        // the permission check, org pinned; the row was read through the member client above
        // (RLS proved org + client scope).
        await serviceWriter()
          .from('bank_transactions')
          .update({
            status: 'POSTED',
            match_type: 'BILL_PAYMENT',
            matched_bill_id: txn.matched_bill_id,
            approved_at: new Date().toISOString(),
            gl_entry_id: res.gl_entry_id,
          })
          .eq('id', body.transaction_id)
          .eq('org_id', orgId);
        if (ctx.orgId) {
          await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
            action: 'bankfeed.approve',
            subjectTable: 'bank_transactions',
            subjectId: txn.id as string,
            summary: 'Approved & posted bank transaction (settled bill)',
            locationId,
          });
        }
        return NextResponse.json(
          { success: true, settled_bill: true, bill_payment_id: res.payment_id, transaction_id: body.transaction_id },
          { status: 200 }
        );
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Bill settlement failed' },
          { status: 400 }
        );
      }
    }

    // Resolve the payee the reviewer typed (audit 06 §5 bug 1: the edit was
    // previously never sent, so a corrected vendor name was silently lost).
    let vendorId: string | null = body.vendor_id ?? null;
    {
      const suggestedId = (body.vendor_id ?? (txn.ai_vendor_id as string | null)) || null;
      let current: CurrentVendor | null = null;
      if (suggestedId) {
        const { data: v } = await ctx.supabase
          .schema('core')
          .from('vendors')
          .select('id, name, display_name')
          .eq('id', suggestedId)
          .maybeSingle();
        current = (v as CurrentVendor | null) ?? null;
      }
      const decision = decideVendor(body.vendor_name, body.vendor_id, current);
      if (decision.kind === 'keep') {
        vendorId = decision.vendorId;
      } else {
        if (!orgId) {
          return NextResponse.json({ error: 'No organization on request; cannot resolve vendor' }, { status: 400 });
        }
        try {
          vendorId = (await resolveVendorIdByName(ctx.supabase, orgId, decision.name, ctx.userId, {
            // A NEW vendor is a master-data create: gate it like the Vendors page.
            mayCreate: async () => {
              const g = await requirePermission(ctx.userId, 'vendors', 'create');
              return g.ok && g.orgId === orgId;
            },
          })).id;
        } catch (e) {
          return NextResponse.json({ error: e instanceof Error ? e.message : 'Vendor resolution failed' }, { status: 400 });
        }
      }
    }
    // The payee is written to the feed line (final_vendor_id) by the service role on both
    // the plain and the split path: a vendor id from the body must be in this org.
    try {
      await assertOrgRefs(orgId, [{ schema: 'core', table: 'vendors', ids: [vendorId], label: 'vendor' }], { caller: ctx.supabase });
    } catch (e) {
      if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
      throw e;
    }
    const note = body.notes?.trim() || null;
    const memo = note ? `Bank feed: ${txn.description} — ${note}` : `Bank feed: ${txn.description}`;

    // ── Split path: explicit lines, else a saved draft split ──────────────────
    let splitRuleId = body.split_rule_id ?? null;
    let splitLines = body.splits && body.splits.length > 0 ? body.splits : null;
    if (!splitLines) {
      const draft = await loadSplitRows(ctx.supabase, orgId, txn.id as string);
      if (draft.length > 0 && draft.every((r) => r.status === 'DRAFT')) {
        splitLines = rowsToLineInputs(draft);
        splitRuleId = splitRuleId ?? draft[0].split_rule_id;
      }
    }
    if (splitLines) {
      const feedTxn = await loadFeedTxn(ctx.supabase, orgId, txn.id as string);
      if (!feedTxn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      try {
        const resolved = await validateSplitLines(ctx.supabase, orgId, feedTxn, splitLines);
        const res = await postSplit(ctx.supabase, { orgId, txn: feedTxn, lines: resolved, memo, vendorId, splitRuleId });

        // Seam: one CLEARED JOB_COST attribution per job line, in that line's company.
        for (const j of res.jobLines) {
          try {
            await createAttribution(ctx.supabase, {
              orgId,
              locationId: j.line.locationId,
              jobId: j.line.jobId as string,
              departmentId: j.line.departmentId ?? null,
              costType: 'MATERIALS',
              amountCents: j.line.amountCents,
              occurredOn: txn.transaction_date,
              gate: 'BANKFEED_CATEGORIZATION',
              sourceType: 'BANK_TXN',
              // Versioned per posting so a re-post after reversal is a new cost, not the voided one.
              sourceRef: `${txn.id}:v${res.version}:${j.line.lineNo}`,
              glEntryId: j.glEntryId,
            });
          } catch (e) {
            console.error('[bank-feed/approve] split JOB_COST emit failed (non-fatal)', e);
          }
        }

        let rememberedRule: { id: string; name: string } | null = null;
        if (body.remember_split) {
          let vendorName: string | null = body.vendor_name?.trim() || null;
          if (!vendorName && vendorId) {
            const { data: v } = await ctx.supabase.schema('core').from('vendors').select('name, display_name').eq('id', vendorId).maybeSingle();
            const vr = v as { name: string; display_name: string | null } | null;
            vendorName = vr?.display_name ?? vr?.name ?? null;
          }
          rememberedRule = await saveSplitRule(ctx.supabase, { orgId, txn: feedTxn, vendorId, vendorName, lines: resolved, userId: ctx.userId });
        } else if (splitRuleId) {
          await markRuleApplied(ctx.supabase, orgId, splitRuleId).catch(() => undefined);
        }

        if (vendorId) {
          await learnVendorPattern(ctx.supabase, {
            orgId,
            description: txn.description,
            accountId: res.dominant.accountId,
            vendorId,
            departmentId: res.dominant.locationId === locationId ? res.dominant.departmentId ?? null : null,
            classId: res.dominant.classId ?? null,
            locationId,
          });
          await ctx.supabase.rpc('increment_vendor_stats', { p_vendor_id: vendorId, p_amount_cents: absCents });
        }
        if (ctx.orgId) {
          const companies = new Set(resolved.map((l) => l.locationId)).size;
          await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
            action: 'bankfeed.approve',
            subjectTable: 'bank_transactions',
            subjectId: txn.id as string,
            summary: `Approved & posted split bank transaction (${resolved.length} lines${companies > 1 ? `, ${companies} companies` : ''}): ${res.entries.map((e) => e.entry_number).join(', ')}`,
            locationId,
          });
        }
        return NextResponse.json({
          success: true,
          split: true,
          entry_number: res.entries.map((e) => e.entry_number).join(', '),
          entries: res.entries,
          remembered_rule: rememberedRule,
          transaction_id: body.transaction_id,
        }, { status: 200 });
      } catch (e) {
        if (e instanceof SplitError) return NextResponse.json({ error: e.message }, { status: e.status });
        throw e;
      }
    }

    if (!body.account_id) {
      return NextResponse.json({ error: 'GL account is required' }, { status: 400 });
    }
    const accountId = body.account_id;

    // Every id this plain post writes through the service role (GL line account and
    // dimensions, the feed line's final_* columns, the job cost row) must belong to this
    // org — FKs never check the tenant. Same gate the split path runs in validateSplitLines.
    try {
      await assertOrgRefs(
        orgId,
        [
          { table: 'accounts', ids: [accountId], label: 'GL account' },
          { schema: 'core', table: 'departments', ids: [body.department_id], label: 'department' },
          { table: 'classes', ids: [body.class_id], label: 'class' },
          { schema: 'core', table: 'jobs', ids: [body.job_id], label: 'job' },
        ],
        { caller: ctx.supabase },
      );
    } catch (e) {
      if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
      throw e;
    }

    // Periods are a product of setup, not auto-created here (suite contract Rule F):
    // postJournalEntry rejects a missing/closed period with a clear error.
    const lines = isOutflow
      ? [
          { account_id: accountId, debit_cents: absCents, credit_cents: 0, location_id: locationId, department_id: body.department_id ?? undefined, class_id: body.class_id ?? undefined },
          { account_id: cashAccountId, debit_cents: 0, credit_cents: absCents, location_id: locationId },
        ]
      : [
          { account_id: cashAccountId, debit_cents: absCents, credit_cents: 0, location_id: locationId },
          { account_id: accountId, debit_cents: 0, credit_cents: absCents, location_id: locationId, department_id: body.department_id ?? undefined, class_id: body.class_id ?? undefined },
        ];

    const legacyFeed = await loadFeedTxn(ctx.supabase, orgId, txn.id as string);
    const legacyVersion = legacyFeed ? await nextPostingVersion(ctx.supabase, orgId, legacyFeed) : 1;
    const jeResult = await postJournalEntry(ctx.supabase, {
      org_id: orgId,
      location_id: locationId,
      entry_date: txn.transaction_date,
      entry_type: 'STANDARD',
      memo,
      source_module: 'BANK_FEED',
      source_id: txn.id,
      // Idempotency (migration 064 unique index): a concurrent second approve fails here.
      source_ref: splitSourceRef(txn.id as string, legacyVersion, locationId, locationId),
      created_by: null, // Clerk user id is text; gl_entries.created_by is uuid (nullable per migration 018). No core.users mapping yet.
      lines,
    });

    if (!jeResult.success) {
      if (/uq_gl_entries_org_source_type|duplicate key/i.test(jeResult.error ?? '')) {
        return NextResponse.json({ error: 'This transaction is already being posted.' }, { status: 409 });
      }
      return NextResponse.json({ error: jeResult.error }, { status: 400 });
    }

    await serviceWriter()
      .from('bank_transactions')
      .update({
        status: 'POSTED',
        final_account_id: accountId,
        final_vendor_id: vendorId,
        final_department_id: body.department_id,
        final_class_id: body.class_id,
        final_job_id: body.job_id ?? null,
        approved_by: null, // uuid column; Clerk text id has no uuid mapping yet
        approved_at: new Date().toISOString(),
        gl_entry_id: jeResult.entry_id,
      })
      .eq('id', body.transaction_id)
      .eq('org_id', orgId);

    // Job-tagged categorization → clear the cost now (cash already spent).
    if (body.job_id && jeResult.entry_id) {
      const { data: expenseLine } = await ctx.supabase
        .from('gl_entry_lines')
        .select('id')
        .eq('gl_entry_id', jeResult.entry_id)
        .eq('account_id', accountId)
        .single();

      const glLineId = (expenseLine as { id: string } | null)?.id ?? null;

      if (glLineId) {
        // gl_entry_lines is SELECT-only for members (migration 171); the line was just
        // posted by this request (org + client scope checked in postJournalEntry).
        await serviceWriter().from('gl_entry_lines').update({ job_id: body.job_id }).eq('id', glLineId).eq('org_id', orgId);
        // job_cost_entries is service-role-only for writes (migration 172); the job id comes
        // from the request body, so verify it belongs to this org (FKs never check the tenant).
        // (body.job_id was verified in-org — core.jobs — before the post above.)
        await serviceWriter().from('job_cost_entries').insert({
          org_id: orgId,
          job_id: body.job_id,
          gl_entry_line_id: glLineId,
          amount_cents: absCents,
          description: `Bank feed: ${txn.description}`,
          entry_date: txn.transaction_date,
        });
      }

      // Seam: emit a CLEARED JOB_COST event (gate BANKFEED_CATEGORIZATION).
      try {
        await createAttribution(ctx.supabase, {
          orgId,
          locationId,
          jobId: body.job_id,
          departmentId: body.department_id ?? null,
          costType: 'MATERIALS',
          amountCents: absCents,
          occurredOn: txn.transaction_date,
          gate: 'BANKFEED_CATEGORIZATION',
          sourceType: 'BANK_TXN',
          // First posting keeps the historical ref; a re-post after reversal is a new cost.
          sourceRef: legacyVersion > 1 ? `${txn.id}:v${legacyVersion}` : txn.id,
          glEntryId: jeResult.entry_id,
        });
      } catch (e) {
        console.error('[bank-feed/approve] JOB_COST emit failed (non-fatal)', e);
      }
    }

    // Vendor pattern learning. Routed through learnVendorPattern so it upserts on
    // the (org_id, normalized_description) key migration 040 introduced — a raw
    // upsert on the old (org_id, vendor_id, normalized_description) target would
    // now collide with that index when two vendors share a description.
    if (vendorId) {
      await learnVendorPattern(ctx.supabase, {
        orgId,
        description: txn.description,
        accountId,
        vendorId,
        departmentId: body.department_id ?? null,
        classId: body.class_id ?? null,
        locationId,
      });

      await ctx.supabase.rpc('increment_vendor_stats', {
        p_vendor_id: vendorId,
        p_amount_cents: absCents,
      });
    }

    if (ctx.orgId) {
      await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
        action: 'bankfeed.approve',
        subjectTable: 'bank_transactions',
        subjectId: txn.id as string,
        summary: 'Approved & posted bank transaction',
        locationId,
      });
    }

    return NextResponse.json({
      success: true,
      entry_number: jeResult.entry_number,
      transaction_id: body.transaction_id,
    }, { status: 200 });
  }
);
