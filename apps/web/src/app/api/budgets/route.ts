export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import { budgetCtx, budgetError, ensureDraftTarget, findDraftTarget } from '@/lib/budgets/route-support';
import { assertEditable, closedPeriods, writeCells } from '@/lib/budgets/service/lines';
import { loadAccounts, loadLines, logEvent } from '@/lib/budgets/service/data';
import { canSeeDepartment } from '@/lib/budgets/scope';
import { fetchAll } from '@/lib/supabase/fetch-all';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── GET: Budget entries pivoted by account (periods as columns) ──────────
// SECURITY (H6): budgetCtx (org pin + client scope + budget view) and the department scope — a
// department owner reads only departments they own; company-level lines (department NULL) are
// finance's. Reads AS THE USER (RLS). Mig 189: the classic grid shows the company-year's open
// DRAFT (what a save changes) when there is one, else the published budget; `source=published`
// forces the published budget (e.g. "copy last year").
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  if (!locationId || !UUID.test(locationId)) {
    return NextResponse.json({ error: 'Pick a company (location_id).', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const fiscalYear = parseInt(searchParams.get('fiscal_year') ?? String(new Date().getFullYear()), 10);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) {
    return NextResponse.json({ error: 'Pick a fiscal year.', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const deptRaw = searchParams.get('department_id'); // null/absent => company-level (dept IS NULL)
  const departmentId = deptRaw && deptRaw !== 'null' ? deptRaw : null;
  if (departmentId && !UUID.test(departmentId)) {
    return NextResponse.json({ error: 'Invalid department.', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const forcePublished = searchParams.get('source') === 'published';

  const b = await budgetCtx(ctx, locationId);
  if (b instanceof NextResponse) return b;
  if (!canSeeDepartment(b.access, departmentId)) {
    return NextResponse.json({ error: 'That department’s budget isn’t yours to see.', code: 'BUDGET_SCOPE' }, { status: 403 });
  }

  try {
    const { byId } = await loadAccounts(b.reader, b.orgId);
    const draft = forcePublished ? null : await findDraftTarget(b, locationId, fiscalYear);
    let cells: Array<{ accountId: string; periodNumber: number; amountCents: number }>;
    if (draft) {
      cells = (await loadLines(b.reader, draft.id, departmentId)).map((l) => ({ accountId: l.accountId, periodNumber: l.periodNumber, amountCents: l.amountCents }));
    } else {
      const { data, error } = await fetchAll<Record<string, unknown>>(() => {
        let q = b.reader.from('budgets').select('account_id, period_number, amount_cents')
          .eq('location_id', locationId).eq('fiscal_year', fiscalYear);
        q = departmentId ? q.eq('department_id', departmentId) : q.is('department_id', null);
        return q;
      }, { label: 'budgets grid', orderBy: 'id' });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      cells = (data ?? []).map((r) => ({ accountId: String(r.account_id), periodNumber: Number(r.period_number), amountCents: Number(r.amount_cents) }));
    }

    // Pivot: group by account, periods (1..13) as columns.
    const accountMap = new Map<string, {
      accountId: string;
      accountNumber: string;
      accountName: string;
      accountType: string;
      periods: Record<number, number>;
      totalCents: number;
    }>();
    for (const c of cells) {
      const acct = byId.get(c.accountId);
      if (!acct) continue;
      const existing = accountMap.get(c.accountId);
      if (existing) {
        existing.periods[c.periodNumber] = (existing.periods[c.periodNumber] ?? 0) + c.amountCents;
        existing.totalCents += c.amountCents;
      } else {
        accountMap.set(c.accountId, {
          accountId: c.accountId,
          accountNumber: acct.number,
          accountName: acct.name,
          accountType: acct.type,
          periods: { [c.periodNumber]: c.amountCents },
          totalCents: c.amountCents,
        });
      }
    }

    return NextResponse.json({
      fiscalYear,
      source: draft ? 'DRAFT' : 'PUBLISHED',
      version: draft ? { id: draft.id, label: draft.label, status: draft.status } : null,
      closedPeriods: await closedPeriods(b, locationId, fiscalYear),
      accounts: Array.from(accountMap.values()).sort((x, y) => x.accountNumber.localeCompare(y.accountNumber)),
    });
  } catch (e) {
    return budgetError(e, 'budgets GET');
  }
}

// ─── POST: Bulk create/update (save the whole grid) ───────────────────────
const entrySchema = z.object({
  account_id: z.string().uuid(),
  period_number: z.number().int().min(1).max(13),
  amount_cents: z.number().int(),
});

const bulkSchema = z.object({
  location_id: z.string().uuid(),
  fiscal_year: z.number().int().min(2020).max(2040),
  department_id: z.string().uuid().optional().nullable(),
  entries: z.array(entrySchema).min(1),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });

  try {
    const raw = await request.json();
    const result = bulkSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
    }
    const body = result.data;
    // Mig 189: budgets is the PUBLISHED budget (member read-only). Writes land in the company-year's
    // newest draft (else a new draft copied from the published budget); it publishes on approval.
    const b = await budgetCtx(ctx, body.location_id);
    if (b instanceof NextResponse) return b;
    const version = await ensureDraftTarget(b, body.location_id, body.fiscal_year);
    await assertEditable(b, version, body.department_id ?? null);
    const saved = await writeCells(
      b, version, body.department_id ?? null,
      body.entries.map((e) => ({ accountId: e.account_id, periodNumber: e.period_number, amountCents: e.amount_cents })),
      'MANUAL',
    );
    if (saved > 0) await logEvent(b, { locationId: version.locationId, versionId: version.id, kind: 'LINES_SAVED', meta: { department_id: body.department_id ?? null, cells: saved, source: 'classic-grid' } });
    return NextResponse.json({ saved: body.entries.length, changed: saved, versionId: version.id, versionLabel: version.label, published: false }, { status: 201 });
  } catch (error) {
    return budgetError(error, 'budgets POST');
  }
}

// ─── PATCH: update a single budget cell (inline grid edit) ────────────────
const cellSchema = z.object({
  location_id: z.string().uuid(),
  fiscal_year: z.number().int().min(2020).max(2040),
  account_id: z.string().uuid(),
  period_number: z.number().int().min(1).max(13),
  amount_cents: z.number().int(),
  department_id: z.string().uuid().optional().nullable(),
});

export async function PATCH(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });

  try {
    const raw = await request.json();
    const result = cellSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({ error: 'Validation failed', details: result.error.issues }, { status: 422 });
    }
    const cell = result.data;
    const b = await budgetCtx(ctx, cell.location_id);
    if (b instanceof NextResponse) return b;
    const version = await ensureDraftTarget(b, cell.location_id, cell.fiscal_year);
    await assertEditable(b, version, cell.department_id ?? null);
    await writeCells(b, version, cell.department_id ?? null, [{ accountId: cell.account_id, periodNumber: cell.period_number, amountCents: cell.amount_cents }], 'MANUAL');
    return NextResponse.json({ ok: true, versionId: version.id, versionLabel: version.label, published: false });
  } catch (error) {
    return budgetError(error, 'budgets PATCH');
  }
}
