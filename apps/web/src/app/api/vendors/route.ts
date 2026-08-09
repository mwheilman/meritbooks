import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

// VendorInput is the shape the UI form sends. Several of these are API-level
// fields that do NOT map 1:1 onto columns of `core.vendors` (the live table) —
// they are translated at the route boundary below:
//   is_1099        -> is_1099_eligible (boolean column)
//   payment_terms  -> payment_terms_days (integer column; see TERMS_TO_DAYS)
//   tax_id, notes, country -> NO column exists (see "NEEDS CENTRAL" in the
//     handoff). tax_id/notes/country are accepted but not persisted, so the
//     route stops 500ing; tax_id/notes round-trip back as null.
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

// core.vendors stores terms as an integer day count (payment_terms_days), but
// the UI speaks in term codes. This mapping is lossy: '2_10_NET_30' (a 2%
// early-pay discount) collapses to 30 days. See "NEEDS CENTRAL".
const TERMS_TO_DAYS: Record<string, number> = {
  DUE_ON_RECEIPT: 0,
  NET_10: 10,
  NET_15: 15,
  NET_30: 30,
  NET_45: 45,
  NET_60: 60,
  NET_90: 90,
  '2_10_NET_30': 30,
};

function termsToDays(code: string | undefined | null): number {
  if (!code) return 30;
  return TERMS_TO_DAYS[code] ?? 30;
}

function daysToTerms(days: number | null | undefined): string {
  const d = Number(days ?? 30);
  const match = Object.entries(TERMS_TO_DAYS).find(
    ([code, val]) => code !== '2_10_NET_30' && val === d,
  );
  return match ? match[0] : `NET_${d}`;
}

// Surface the API-shaped fields the UI expects on top of the raw DB row so the
// response contract stays stable even though the underlying columns differ.
function withApiFields(v: Record<string, unknown>): Record<string, unknown> {
  // Never surface the raw encrypted TIN to the client. Strip it from the spread
  // and expose only a boolean gap flag for the 1099 chip.
  const { tin_encrypted, ...rest } = v;
  const tinPresent = typeof tin_encrypted === 'string' && tin_encrypted.trim().length > 0;
  return {
    ...rest,
    is_1099: !!v.is_1099_eligible,
    payment_terms: daysToTerms(v.payment_terms_days as number | null),
    tax_id: null, // no plaintext TIN column on core.vendors (tin_encrypted is not surfaced)
    notes: null, // no notes column on core.vendors
    // 1099 chip signal: eligible vendor with no TIN on file — a January-chase gap.
    missing_tin: !!v.is_1099_eligible && !tinPresent,
  };
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireAuthedContext();
    if (ctx instanceof NextResponse) return ctx;
    const { supabase, orgId } = ctx;
    if (!orgId) return NextResponse.json({ vendors: [], total: 0 });

    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search') ?? '';
    const page = parseInt(searchParams.get('page') ?? '1', 10);
    const perPage = parseInt(searchParams.get('per_page') ?? '50', 10);
    const sortBy = searchParams.get('sort_by') ?? 'name';
    const sortDir = searchParams.get('sort_dir') === 'desc' ? false : true;
    const is1099 = searchParams.get('is_1099');
    const hasPaymentHold = searchParams.get('has_payment_hold');

    // NOTE: no PostgREST embed on vendor_compliance_docs / vendor_payment_holds
    // here — vendors now lives in `core` while those child tables are in
    // `public`, and PostgREST cannot embed across schemas (it 500s). We fetch
    // the child rows separately (below) and stitch them in JS.
    let query = supabase
      .schema('core').from('vendors')
      .select('*', { count: 'exact' })
      .eq('org_id', orgId)
      .is('deleted_at', null);

    if (search) {
      query = query.or(`name.ilike.%${search}%,display_name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    if (is1099 === 'true') {
      query = query.eq('is_1099_eligible', true);
    }

    // Map API-level sort keys onto the real column names on core.vendors.
    const sortAliases: Record<string, string> = {
      name: 'name',
      created_at: 'created_at',
      is_1099: 'is_1099_eligible',
      payment_terms: 'payment_terms_days',
    };
    const sortColumn = sortAliases[sortBy] ?? 'name';
    query = query.order(sortColumn, { ascending: sortDir });

    const offset = (page - 1) * perPage;
    query = query.range(offset, offset + perPage - 1);

    const { data: vendors, count, error } = await query;

    if (error) {
      console.error('Vendor list error:', error);
      return NextResponse.json({ error: 'Failed to fetch vendors' }, { status: 500 });
    }

    // Fetch compliance docs + payment holds for the vendors on this page
    // (public schema) and group them by vendor_id. Empty page → skip the calls.
    const vendorIds = (vendors ?? []).map((v: Record<string, unknown>) => v.id as string);

    const docsByVendor = new Map<string, Array<{ doc_type: string; status: string; expiration_date: string | null }>>();
    const holdsByVendor = new Map<string, Array<{ hold_type: string; start_date: string | null; end_date: string | null }>>();
    // YTD spend (billed, ex-voided) per vendor for the list spend column.
    const ytdSpendByVendor = new Map<string, number>();

    if (vendorIds.length > 0) {
      const yearStart = `${new Date().getFullYear()}-01-01`;
      const { data: spendBills } = await supabase
        .from('bills')
        .select('vendor_id, total_cents, status, bill_date')
        .eq('org_id', orgId)
        .in('vendor_id', vendorIds)
        .neq('status', 'VOIDED')
        .gte('bill_date', yearStart);
      for (const b of (spendBills ?? []) as Array<{ vendor_id: string; total_cents: number | string }>) {
        const cur = ytdSpendByVendor.get(b.vendor_id) ?? 0;
        ytdSpendByVendor.set(b.vendor_id, cur + (Number(b.total_cents) || 0));
      }

      const [{ data: docs }, { data: holds }] = await Promise.all([
        supabase
          .from('vendor_compliance_docs')
          .select('vendor_id, doc_type, status, expiration_date')
          .eq('org_id', orgId)
          .in('vendor_id', vendorIds),
        supabase
          .from('vendor_payment_holds')
          .select('vendor_id, hold_type, reason, start_date, end_date, created_at')
          .eq('org_id', orgId)
          .in('vendor_id', vendorIds),
      ]);

      for (const d of docs ?? []) {
        const arr = docsByVendor.get(d.vendor_id as string) ?? [];
        arr.push(d as { doc_type: string; status: string; expiration_date: string | null });
        docsByVendor.set(d.vendor_id as string, arr);
      }
      for (const h of holds ?? []) {
        const arr = holdsByVendor.get(h.vendor_id as string) ?? [];
        arr.push(h as { hold_type: string; start_date: string | null; end_date: string | null });
        holdsByVendor.set(h.vendor_id as string, arr);
      }
    }

    // Compute compliance status per vendor
    const enriched = (vendors ?? []).map((v: Record<string, unknown>) => {
      const docs = docsByVendor.get(v.id as string) ?? [];
      const holds = holdsByVendor.get(v.id as string) ?? [];

      const w9 = docs.find((d) => d.doc_type === 'W9');
      const glCoi = docs.find((d) => d.doc_type === 'GL_COI');
      const wcCoi = docs.find((d) => d.doc_type === 'WC_COI');

      const now = new Date();
      const isExpired = (doc: typeof w9) => {
        if (!doc) return true;
        // vendor_compliance_docs.status enum is MISSING | PENDING | VALID | EXPIRED.
        if (doc.status !== 'VALID') return true;
        if (doc.expiration_date && new Date(doc.expiration_date) < now) return true;
        return false;
      };

      // A hold is currently in effect if its window covers today: started on/before
      // now (or no start) and not yet ended (end_date null = permanent, else future).
      const holdInEffect = (h: { start_date: string | null; end_date: string | null }) => {
        if (h.start_date && new Date(h.start_date) > now) return false;
        if (h.end_date && new Date(h.end_date) < now) return false;
        return true;
      };

      const complianceStatus = {
        w9: w9 ? (isExpired(w9) ? 'expired' : 'valid') : 'missing',
        glCoi: glCoi ? (isExpired(glCoi) ? 'expired' : 'valid') : 'missing',
        wcCoi: wcCoi ? (isExpired(wcCoi) ? 'expired' : 'valid') : 'missing',
        hasActiveHold: holds.some(holdInEffect),
      };

      return {
        ...withApiFields(v),
        compliance: complianceStatus,
        ytd_spend_cents: ytdSpendByVendor.get(v.id as string) ?? 0,
      };
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
    const ctx = await requireAuthedContext();
    if (ctx instanceof NextResponse) return ctx;
    const { supabase, orgId, userId } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    const body = (await req.json()) as VendorInput;

    // Validate required fields
    if (!body.name || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'Vendor name is required' }, { status: 400 });
    }

    const trimmedName = body.name.trim();

    // Duplicate detection — fuzzy match on name
    const { data: existing } = await supabase
      .schema('core').from('vendors')
      .select('id, name')
      .eq('org_id', orgId)
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

    // Create vendor. Only columns that exist on core.vendors are written;
    // is_1099/payment_terms are translated, and tax_id/notes/country are
    // dropped (no column — see "NEEDS CENTRAL" in the handoff).
    const insertData = {
      org_id: orgId,
      name: trimmedName,
      display_name: body.display_name?.trim() || trimmedName,
      email: body.email?.trim().toLowerCase() || null,
      phone: body.phone?.trim() || null,
      address_line1: body.address_line1?.trim() || null,
      address_line2: body.address_line2?.trim() || null,
      city: body.city?.trim() || null,
      state: body.state?.trim()?.toUpperCase() || null,
      zip: body.zip?.trim() || null,
      payment_terms_days: termsToDays(body.payment_terms),
      default_account_id: body.default_account_id || null,
      default_department_id: body.default_department_id || null,
      is_1099_eligible: body.is_1099 ?? false,
      website: body.website?.trim() || null,
      ai_confidence: 0,
      auto_approve: false,
      created_by: userId,
    };

    const { data: vendor, error } = await supabase
      .schema('core').from('vendors')
      .insert(insertData)
      .select('*')
      .single();

    if (error) {
      console.error('Vendor create error:', error);
      return NextResponse.json({ error: 'Failed to create vendor', detail: error.message }, { status: 500 });
    }

    return NextResponse.json({ vendor: withApiFields(vendor as Record<string, unknown>) }, { status: 201 });
  } catch (error) {
    console.error('POST /api/vendors error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await requireAuthedContext();
    if (ctx instanceof NextResponse) return ctx;
    const { supabase } = ctx;

    const body = await req.json();
    const { id, ...updates } = body as { id: string } & Partial<VendorInput>;

    if (!id) {
      return NextResponse.json({ error: 'Vendor ID required' }, { status: 400 });
    }

    // Only real core.vendors columns are updated. is_1099/payment_terms are
    // translated; country/tax_id/notes have no column and are ignored (see
    // "NEEDS CENTRAL").
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
    if (updates.payment_terms !== undefined) updateData.payment_terms_days = termsToDays(updates.payment_terms);
    if (updates.default_account_id !== undefined) updateData.default_account_id = updates.default_account_id;
    if (updates.default_department_id !== undefined) updateData.default_department_id = updates.default_department_id;
    if (updates.is_1099 !== undefined) updateData.is_1099_eligible = updates.is_1099;
    if (updates.website !== undefined) updateData.website = updates.website?.trim();

    updateData.updated_at = new Date().toISOString();

    const { data: vendor, error } = await supabase
      .schema('core').from('vendors')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (error) {
      console.error('Vendor update error:', error);
      return NextResponse.json({ error: 'Failed to update vendor' }, { status: 500 });
    }

    return NextResponse.json({ vendor: withApiFields(vendor as Record<string, unknown>) });
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
