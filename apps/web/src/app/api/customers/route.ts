import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@/lib/supabase/server';

interface CustomerInput {
  name: string;
  display_name?: string;
  email?: string;
  phone?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  payment_terms?: string;
  credit_limit_cents?: number;
  tax_exempt?: boolean;
  tax_id?: string;
  notes?: string;
  website?: string;
  contact_first_name?: string;
  contact_last_name?: string;
  is_portfolio_company?: boolean;
  location_id?: string;
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = await createClient();
    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search') ?? '';
    const page = parseInt(searchParams.get('page') ?? '1', 10);
    const perPage = parseInt(searchParams.get('per_page') ?? '50', 10);
    const sortBy = searchParams.get('sort_by') ?? 'name';
    const sortDir = searchParams.get('sort_dir') === 'desc' ? false : true;

    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .limit(1)
      .single();

    if (!org) {
      return NextResponse.json({ customers: [], total: 0 });
    }

    let query = supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .eq('org_id', org.id)
      .is('deleted_at', null);

    if (search) {
      query = query.or(`name.ilike.%${search}%,display_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const validSortColumns = ['name', 'created_at', 'payment_terms'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'name';
    query = query.order(sortColumn, { ascending: sortDir });

    const offset = (page - 1) * perPage;
    query = query.range(offset, offset + perPage - 1);

    const { data: customers, count, error } = await query;

    if (error) {
      console.error('Customer list error:', error);
      return NextResponse.json({ error: 'Failed to fetch customers' }, { status: 500 });
    }

    // Get AR summary per customer if we have invoice data
    const customerIds = (customers ?? []).map((c: { id: string }) => c.id);
    let arSummary: Record<string, { totalOutstanding: number; overdueCount: number }> = {};

    if (customerIds.length > 0) {
      const { data: invoices } = await supabase
        .from('invoices')
        .select('customer_id, total_amount_cents, balance_due_cents, due_date, status')
        .in('customer_id', customerIds)
        .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE']);

      if (invoices) {
        const now = new Date();
        for (const inv of invoices as Array<{
          customer_id: string;
          balance_due_cents: number;
          due_date: string;
        }>) {
          if (!arSummary[inv.customer_id]) {
            arSummary[inv.customer_id] = { totalOutstanding: 0, overdueCount: 0 };
          }
          arSummary[inv.customer_id].totalOutstanding += inv.balance_due_cents || 0;
          if (new Date(inv.due_date) < now) {
            arSummary[inv.customer_id].overdueCount += 1;
          }
        }
      }
    }

    const enriched = (customers ?? []).map((c: Record<string, unknown>) => ({
      ...c,
      ar: arSummary[c.id as string] ?? { totalOutstanding: 0, overdueCount: 0 },
    }));

    return NextResponse.json({
      customers: enriched,
      total: count ?? 0,
      page,
      perPage,
      totalPages: Math.ceil((count ?? 0) / perPage),
    });
  } catch (error) {
    console.error('GET /api/customers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as CustomerInput;
    const supabase = await createClient();

    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .limit(1)
      .single();

    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 400 });
    }

    if (!body.name || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'Customer name is required' }, { status: 400 });
    }

    const trimmedName = body.name.trim();

    // Duplicate detection
    const { data: existing } = await supabase
      .from('customers')
      .select('id, name')
      .eq('org_id', org.id)
      .is('deleted_at', null)
      .ilike('name', `%${trimmedName}%`)
      .limit(5);

    const duplicates = (existing ?? []).filter((c: { name: string }) => {
      return c.name.toLowerCase() === trimmedName.toLowerCase();
    });

    if (duplicates.length > 0) {
      return NextResponse.json({
        error: 'Duplicate customer detected',
        duplicates: duplicates.map((d: { id: string; name: string }) => ({ id: d.id, name: d.name })),
      }, { status: 409 });
    }

    const insertData = {
      org_id: org.id,
      name: trimmedName,
      display_name: body.display_name?.trim() || trimmedName,
      email: body.email?.trim().toLowerCase() || null,
      phone: body.phone?.trim() || null,
      address_line1: body.address_line1?.trim() || null,
      address_line2: body.address_line2?.trim() || null,
      city: body.city?.trim() || null,
      state: body.state?.trim()?.toUpperCase() || null,
      zip: body.zip?.trim() || null,
      country: body.country?.trim() || 'US',
      payment_terms: body.payment_terms || 'NET_30',
      credit_limit_cents: body.credit_limit_cents ?? null,
      tax_exempt: body.tax_exempt ?? false,
      tax_id: body.tax_id?.trim() || null,
      notes: body.notes?.trim() || null,
      website: body.website?.trim() || null,
      contact_first_name: body.contact_first_name?.trim() || null,
      contact_last_name: body.contact_last_name?.trim() || null,
      is_portfolio_company: body.is_portfolio_company ?? false,
      location_id: body.location_id || null,
      created_by: userId,
    };

    const { data: customer, error } = await supabase
      .from('customers')
      .insert(insertData)
      .select('*')
      .single();

    if (error) {
      console.error('Customer create error:', error);
      return NextResponse.json({ error: 'Failed to create customer', detail: error.message }, { status: 500 });
    }

    return NextResponse.json({ customer }, { status: 201 });
  } catch (error) {
    console.error('POST /api/customers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { id, ...updates } = body as { id: string } & Partial<CustomerInput>;

    if (!id) {
      return NextResponse.json({ error: 'Customer ID required' }, { status: 400 });
    }

    const supabase = await createClient();

    const updateData: Record<string, unknown> = {};
    if (updates.name !== undefined) updateData.name = updates.name.trim();
    if (updates.display_name !== undefined) updateData.display_name = updates.display_name.trim();
    if (updates.email !== undefined) updateData.email = updates.email.trim().toLowerCase();
    if (updates.phone !== undefined) updateData.phone = updates.phone.trim();
    if (updates.address_line1 !== undefined) updateData.address_line1 = updates.address_line1.trim();
    if (updates.address_line2 !== undefined) updateData.address_line2 = updates.address_line2.trim();
    if (updates.city !== undefined) updateData.city = updates.city.trim();
    if (updates.state !== undefined) updateData.state = updates.state.trim().toUpperCase();
    if (updates.zip !== undefined) updateData.zip = updates.zip.trim();
    if (updates.country !== undefined) updateData.country = updates.country.trim();
    if (updates.payment_terms !== undefined) updateData.payment_terms = updates.payment_terms;
    if (updates.credit_limit_cents !== undefined) updateData.credit_limit_cents = updates.credit_limit_cents;
    if (updates.tax_exempt !== undefined) updateData.tax_exempt = updates.tax_exempt;
    if (updates.tax_id !== undefined) updateData.tax_id = updates.tax_id?.trim();
    if (updates.notes !== undefined) updateData.notes = updates.notes?.trim();
    if (updates.website !== undefined) updateData.website = updates.website?.trim();
    if (updates.contact_first_name !== undefined) updateData.contact_first_name = updates.contact_first_name?.trim();
    if (updates.contact_last_name !== undefined) updateData.contact_last_name = updates.contact_last_name?.trim();

    updateData.updated_at = new Date().toISOString();

    const { data: customer, error } = await supabase
      .from('customers')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('Customer update error:', error);
      return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 });
    }

    return NextResponse.json({ customer });
  } catch (error) {
    console.error('PATCH /api/customers error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
