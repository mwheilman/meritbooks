export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

// GET — list accounts with hierarchy from live DB
export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const status = searchParams.get('approval_status'); // PENDING, APPROVED, REJECTED
  const accountType = searchParams.get('account_type');

  let query = supabase
    .from('accounts')
    .select(`
      id,
      account_number,
      name,
      account_type,
      is_active,
      is_control_account,
      is_company_specific,
      is_bank_account,
      is_credit_card,
      approval_status,
      requested_by,
      approved_by,
      approved_at,
      require_department,
      require_class,
      require_item,
      created_at,
      account_groups!inner(
        name,
        display_order,
        account_sub_types!inner(
          name,
          display_order,
          account_types!inner(
            name,
            normal_balance,
            display_order
          )
        )
      )
    `)
    .order('account_number');

  if (locationId) {
    query = query.or(`is_company_specific.eq.false,company_location_id.eq.${locationId}`);
  }
  if (status) {
    query = query.eq('approval_status', status);
  }
  if (accountType) {
    query = query.eq('account_type', accountType);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[accounts] Query error:', error);
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  // Count by approval status
  const pendingCount = (data ?? []).filter((a: Record<string, unknown>) => a.approval_status === 'PENDING').length;
  const approvedCount = (data ?? []).filter((a: Record<string, unknown>) => a.approval_status === 'APPROVED').length;

  const accounts = (data ?? []).map((a: Record<string, unknown>) => {
    const group = a.account_groups as unknown as Record<string, unknown>;
    const subType = group?.account_sub_types as unknown as Record<string, unknown>;
    const acctType = subType?.account_types as unknown as Record<string, unknown>;
    return {
      id: a.id,
      accountNumber: a.account_number,
      name: a.name,
      accountType: a.account_type,
      groupName: group?.name ?? '',
      subTypeName: subType?.name ?? '',
      typeName: acctType?.name ?? '',
      normalBalance: acctType?.normal_balance ?? 'DEBIT',
      isActive: a.is_active,
      isControlAccount: a.is_control_account,
      isCompanySpecific: a.is_company_specific,
      isBankAccount: a.is_bank_account,
      isCreditCard: a.is_credit_card,
      approvalStatus: a.approval_status,
      requestedBy: a.requested_by,
      approvedBy: a.approved_by,
      approvedAt: a.approved_at,
      requireDepartment: a.require_department,
      requireClass: a.require_class,
      requireItem: a.require_item,
      createdAt: a.created_at,
    };
  });

  return NextResponse.json({
    data: accounts,
    counts: { pending: pendingCount, approved: approvedCount, total: (data ?? []).length },
  });
}

// POST — request a new account (goes through approval workflow)
const requestSchema = z.object({
  account_number: z.string().regex(/^\d{4,5}$/, 'Account number must be 4-5 digits'),
  name: z.string().min(2).max(200),
  account_type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPEX', 'OTHER']),
  account_group_id: z.string().uuid(),
  is_company_specific: z.boolean().default(false),
  company_location_id: z.string().uuid().optional(),
  require_department: z.boolean().default(false),
  require_class: z.boolean().default(false),
  require_item: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const supabase = createAdminSupabase();

  let body: z.infer<typeof requestSchema>;
  try {
    const raw = await request.json();
    const result = requestSchema.safeParse(raw);
    if (!result.success) {
      return NextResponse.json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      }, { status: 422 });
    }
    body = result.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  // Check for duplicate account number
  const { data: existing } = await supabase
    .from('accounts')
    .select('id')
    .eq('account_number', body.account_number)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({
      error: `Account number ${body.account_number} already exists`,
      code: 'DUPLICATE',
    }, { status: 409 });
  }

  // Get org_id from any location (accounts are org-level)
  const { data: orgRow } = await supabase
    .from('locations')
    .select('org_id')
    .limit(1)
    .single();

  if (!orgRow) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 404 });
  }

  const { data: account, error: insertError } = await supabase
    .from('accounts')
    .insert({
      org_id: orgRow.org_id,
      account_number: body.account_number,
      name: body.name,
      account_type: body.account_type,
      account_group_id: body.account_group_id,
      is_company_specific: body.is_company_specific,
      company_location_id: body.company_location_id ?? null,
      require_department: body.require_department,
      require_class: body.require_class,
      require_item: body.require_item,
      approval_status: 'PENDING',
      requested_by: userId,
      is_active: false, // Not active until approved
    })
    .select('id, account_number, name, approval_status')
    .single();

  if (insertError) {
    console.error('[accounts POST] Insert error:', insertError);
    return NextResponse.json({
      error: `Failed to create account: ${insertError.message}`,
      code: 'INSERT_ERROR',
    }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    account,
    message: 'Account requested — pending approval from CFO or Controller.',
  }, { status: 201 });
}

// PATCH — approve or reject an account request
export async function PATCH(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const supabase = createAdminSupabase();

  const body = await request.json();
  const { account_id, action } = body as { account_id: string; action: 'approve' | 'reject' };

  if (!account_id || !['approve', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'account_id and action (approve|reject) required', code: 'VALIDATION_ERROR' }, { status: 422 });
  }

  const updates: Record<string, unknown> = action === 'approve'
    ? { approval_status: 'APPROVED', approved_by: userId, approved_at: new Date().toISOString(), is_active: true }
    : { approval_status: 'REJECTED' };

  const { error: updateError } = await supabase
    .from('accounts')
    .update(updates)
    .eq('id', account_id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message, code: 'UPDATE_ERROR' }, { status: 500 });
  }

  return NextResponse.json({ success: true, action });
}
