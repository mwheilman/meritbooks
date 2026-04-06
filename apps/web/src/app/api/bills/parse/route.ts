export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { parseInvoiceWithAI } from '@/lib/services/bill-parser';

export async function POST(request: Request) {
  const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
  const userId = authResult.userId ?? 'dev-user';
  const supabase = createAdminSupabase();

  // Get API key from environment
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      error: 'ANTHROPIC_API_KEY not configured. Add it to your environment variables.',
      code: 'NO_API_KEY',
    }, { status: 500 });
  }

  // Parse multipart form data
  let base64Data: string;
  let mediaType: string;
  let fileName: string;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    }

    fileName = file.name;
    mediaType = file.type || 'application/octet-stream';

    // Validate file type
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(mediaType)) {
      return NextResponse.json({
        error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`,
        code: 'BAD_FILE_TYPE',
      }, { status: 400 });
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }

    // Convert to base64
    const buffer = await file.arrayBuffer();
    base64Data = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  // Parse with Claude
  const parseResult = await parseInvoiceWithAI(base64Data, mediaType, apiKey);

  if (!parseResult.success || !parseResult.data) {
    return NextResponse.json({
      error: parseResult.error ?? 'Failed to parse invoice',
      code: 'PARSE_FAILED',
    }, { status: 422 });
  }

  const parsed = parseResult.data;

  // ─── Vendor matching ──────────────────────────────────────
  let matchedVendor: { id: string; name: string; confidence: number; paymentTermsDays: number; defaultAccountId: string | null } | null = null;

  if (parsed.vendorName) {
    // Try exact match
    const { data: exactVendors } = await supabase
      .from('vendors')
      .select('id, name, display_name, payment_terms_days, default_account_id')
      .ilike('name', parsed.vendorName)
      .limit(1);

    if (exactVendors && exactVendors.length > 0) {
      const v = exactVendors[0];
      matchedVendor = {
        id: v.id,
        name: v.display_name ?? v.name,
        confidence: 1.0,
        paymentTermsDays: v.payment_terms_days ?? 30,
        defaultAccountId: v.default_account_id,
      };
    } else {
      // Fuzzy match — search by first significant word
      const words = parsed.vendorName.split(/\s+/).filter((w: string) => w.length >= 3);
      for (const word of words) {
        const { data: fuzzyVendors } = await supabase
          .from('vendors')
          .select('id, name, display_name, payment_terms_days, default_account_id')
          .ilike('name', `%${word}%`)
          .limit(3);

        if (fuzzyVendors && fuzzyVendors.length > 0) {
          const v = fuzzyVendors[0];
          matchedVendor = {
            id: v.id,
            name: v.display_name ?? v.name,
            confidence: 0.65,
            paymentTermsDays: v.payment_terms_days ?? 30,
            defaultAccountId: v.default_account_id,
          };
          break;
        }
      }
    }
  }

  // ─── Duplicate detection ──────────────────────────────────
  let duplicateWarning: string | null = null;

  if (parsed.billNumber && matchedVendor) {
    const { data: dupes } = await supabase
      .from('bills')
      .select('id, bill_number, total_cents, bill_date')
      .eq('vendor_id', matchedVendor.id)
      .eq('bill_number', parsed.billNumber)
      .limit(1);

    if (dupes && dupes.length > 0) {
      const dupe = dupes[0];
      duplicateWarning = `Possible duplicate: Bill #${dupe.bill_number} from this vendor already exists (${new Date(dupe.bill_date).toLocaleDateString()}, ${formatCents(dupe.total_cents)})`;
    }
  }

  // Also check by amount + date for same vendor (even without matching bill number)
  if (!duplicateWarning && matchedVendor && parsed.totalCents > 0 && parsed.billDate) {
    const { data: amountDupes } = await supabase
      .from('bills')
      .select('id, bill_number, total_cents, bill_date')
      .eq('vendor_id', matchedVendor.id)
      .eq('total_cents', parsed.totalCents)
      .eq('bill_date', parsed.billDate)
      .limit(1);

    if (amountDupes && amountDupes.length > 0) {
      duplicateWarning = `Possible duplicate: A bill from this vendor for the same amount on the same date already exists`;
    }
  }

  // ─── GL account suggestion ────────────────────────────────
  let suggestedAccountId: string | null = null;
  let suggestedAccountLabel: string | null = null;

  if (matchedVendor?.defaultAccountId) {
    const { data: acct } = await supabase
      .from('accounts')
      .select('id, account_number, name')
      .eq('id', matchedVendor.defaultAccountId)
      .single();

    if (acct) {
      suggestedAccountId = acct.id;
      suggestedAccountLabel = `${acct.account_number} · ${acct.name}`;
    }
  }

  // ─── Log to AI audit ──────────────────────────────────────
  const { data: org } = await supabase.from('organizations').select('id').limit(1).single();

  if (org) {
    await supabase.from('ai_audit_log').insert({
      org_id: org.id,
      feature: 'BILL_PARSE',
      model_version: parsed.aiModel,
      prompt_summary: `Parse invoice: ${fileName}`,
      output_summary: `Vendor: ${parsed.vendorName}, Total: ${parsed.totalCents}, Lines: ${parsed.lines.length}`,
      confidence: parsed.totalConfidence,
      processing_time_ms: parsed.parseTimeMs,
      user_id: userId,
    }).then(() => {}); // Fire and forget
  }

  return NextResponse.json({
    parsed: {
      vendorName: parsed.vendorName,
      vendorNameConfidence: parsed.vendorNameConfidence,
      billNumber: parsed.billNumber,
      billNumberConfidence: parsed.billNumberConfidence,
      billDate: parsed.billDate,
      billDateConfidence: parsed.billDateConfidence,
      dueDate: parsed.dueDate,
      dueDateConfidence: parsed.dueDateConfidence,
      subtotalCents: parsed.subtotalCents,
      taxCents: parsed.taxCents,
      totalCents: parsed.totalCents,
      totalConfidence: parsed.totalConfidence,
      lines: parsed.lines,
      notes: parsed.rawText,
      parseTimeMs: parsed.parseTimeMs,
    },
    vendor: matchedVendor,
    suggestedAccount: suggestedAccountId ? { id: suggestedAccountId, label: suggestedAccountLabel } : null,
    duplicateWarning,
  });
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
