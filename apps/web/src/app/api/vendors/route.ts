import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@/lib/supabase/server';

interface VendorInput {
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
  default_account_id?: string;
  default_department_id?: string;
  is_1099?: boolean;
  tax_id?: string;
  notes?: string;
  website?: string;
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
    const is1099 = searchParams.get('is_1099');
    const hasPaymentHold = searchParams.get('has_payment_hold');

    // Get org
    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .limit(1)
      .single();

    if (!org) {
      return NextResponse.json({ vendors: [], total: 0 });
    }

    let query = supabase
      .from('vendors')
      .select('*, vendor_compliance_docs(id, doc_type, status, expiration_date), vendor_payment_holds(id, hold_type, reason, override_type, created_at)', { count: 'exact' })
      .eq('org_id', org.id)
      .is('deleted_at', null);

    if (search) {
      query = query.or(`name.ilike.%${search}%,display_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    if (is1099 === 'true') {
      query = query.eq('is_1099', true);
    }

    const validSortColumns = ['name', 'created_at', 'is_1099', 'payment_terms'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'name';
    query = query.order(sortColumn, { ascending: sortDir });

    const offset = (page - 1) * perPage;
    query = query.range(offset, offset + perPage - 1);

    const { data: vendors, count, error } = await query;

    if (error) {
      console.error('Vendor list error:', error);
      return NextResponse.json({ error: 'Failed to fetch vendors' }, { status: 500 });
    }

    // Compute compliance status per vendor
    const enriched = (vendors ?? []).map((v: Record<string, unknown>) => {
      const docs = (v.vendor_compliance_docs ?? []) as Array<{
        doc_type: string;
        status: string;
        expiration_date: string | null;
      }>;
      const holds = (v.vendor_payment_holds ?? []) as Array<{
        hold_type: string;
        override_type: string | null;
      }>;

      const w9 = docs.find((d) => d.doc_type === 'W9');
      const glCoi = docs.find((d) => d.doc_type === 'GL_COI');
      const wcCoi = docs.find((d) => d.doc_type === 'WC_COI');

      const now = new Date();
      const isExpired = (doc: typeof w9) => {
        if (!doc) return true;
        if (doc.status !== 'ACTIVE') return true;
        if (doc.expiration_date && new Date(doc.expiration_date) < now) return true;
        return false;
      };

      const complianceStatus = {
        w9: w9 ? (isExpired(w9) ? 'expired' : 'valid') : 'missing',
        glCoi: glCoi ? (isExpired(glCoi) ? 'expired' : 'valid') : 'missing',
        wcCoi: wcCoi ? (isExpired(wcCoi) ? 'expired' : 'valid') : 'missing',
        hasActiveHold: holds.some((h) => !h.override_type),
      };

      // Remove nested arrays from response for cleanliness
      const { vendor_compliance_docs: _docs, vendor_payment_holds: _holds, ...rest } = v;
      return { ...rest, compliance: complianceStatus };
    });

    // Filter by payment hold after enrichment
    let result = enriched;
    if (hasPaymentHold === 'true') {
      result = result.filter((v: { compliance: { hasActiveHold: boolean } }) => v.compliance.hasActiveHold);
    }

    return NextResponse.json({
      vendors: result,
      total: count ?? 0,
      page,
      perPage,
      totalPages: Math.ceil((count ?? 0) / perPage),
    });
  } catch (error) {
    console.error('GET /api/vendors error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as VendorInput;
    const supabase = await createClient();

    // Get org
    const { data: org } = await supabase
      .from('organizations')
      .select('id')
      .limit(1)
      .single();

    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 400 });
    }

    // Validate required fields
    if (!body.name || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'Vendor name is required' }, { status: 400 });
    }

    const trimmedName = body.name.trim();

    // Duplicate detection — fuzzy match on name
    const { data: existing } = await supabase
      .from('vendors')
      .select('id, name')
      .eq('org_id', org.id)
      .is('deleted_at', null)
      .ilike('name', `%${trimmedName}%`)
      .limit(5);

    const duplicates = (existing ?? []).filter((v: { name: string }) => {
      const similarity = computeSimilarity(v.name.toLowerCase(), trimmedName.toLowerCase());
      return similarity > 0.8;
    });

    if (duplicates.length > 0) {
      return NextResponse.json({
        error: 'Potential duplicate vendor detected',
        duplicates: duplicates.map((d: { id: string; name: string }) => ({ id: d.id, name: d.name })),
        message: `Similar vendor(s) already exist: ${duplicates.map((d: { name: string }) => d.name).join(', ')}. Set force=true to create anyway.`,
      }, { status: 409 });
    }

    // Create vendor
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
      default_account_id: body.default_account_id || null,
      default_department_id: body.default_department_id || null,
      is_1099: body.is_1099 ?? false,
      tax_id: body.tax_id?.trim() || null,
      notes: body.notes?.trim() || null,
      website: body.website?.trim() || null,
      ai_confidence: 0,
      auto_approve: false,
      created_by: userId,
    };

    const { data: vendor, error } = await supabase
      .from('vendors')
      .insert(insertData)
      .select('*')
      .single();

    if (error) {
      console.error('Vendor create error:', error);
      return NextResponse.json({ error: 'Failed to create vendor', detail: error.message }, { status: 500 });
    }

    return NextResponse.json({ vendor }, { status: 201 });
  } catch (error) {
    console.error('POST /api/vendors error:', error);
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
    const { id, ...updates } = body as { id: string } & Partial<VendorInput>;

    if (!id) {
      return NextResponse.json({ error: 'Vendor ID required' }, { status: 400 });
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
    if (updates.default_account_id !== undefined) updateData.default_account_id = updates.default_account_id;
    if (updates.default_department_id !== undefined) updateData.default_department_id = updates.default_department_id;
    if (updates.is_1099 !== undefined) updateData.is_1099 = updates.is_1099;
    if (updates.tax_id !== undefined) updateData.tax_id = updates.tax_id?.trim();
    if (updates.notes !== undefined) updateData.notes = updates.notes?.trim();
    if (updates.website !== undefined) updateData.website = updates.website?.trim();

    updateData.updated_at = new Date().toISOString();

    const { data: vendor, error } = await supabase
      .from('vendors')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('Vendor update error:', error);
      return NextResponse.json({ error: 'Failed to update vendor' }, { status: 500 });
    }

    return NextResponse.json({ vendor });
  } catch (error) {
    console.error('PATCH /api/vendors error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Simple string similarity using Levenshtein-based approach
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;

  const costs: number[] = [];
  for (let i = 0; i <= longer.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= shorter.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (longer.charAt(i - 1) !== shorter.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[shorter.length] = lastValue;
  }

  return (longer.length - costs[shorter.length]) / longer.length;
}
