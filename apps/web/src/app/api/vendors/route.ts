import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { z } from 'zod';

const vendorQuerySchema = z.object({
  search: z.string().max(200).optional(),
  compliance: z.enum(['all', 'compliant', 'issues']).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  per_page: z.string().regex(/^\d+$/).optional(),
});

export const GET = apiQueryHandler(
  vendorQuerySchema,
  async (params, ctx) => {
    const page = parseInt(params.page ?? '1', 10);
    const perPage = Math.min(parseInt(params.per_page ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    let query = ctx.supabase
      .from('vendors')
      .select(`
        id,
        name,
        display_name,
        default_account_id,
        ai_confidence,
        auto_approve,
        transaction_count,
        ytd_spend_cents,
        is_1099_eligible,
        is_active,
        created_at
      `, { count: 'exact' })
      .eq('is_active', true)
      .order('name', { ascending: true })
      .range(offset, offset + perPage - 1);

    if (params.search && params.search.trim().length > 0) {
      query = query.ilike('name', `%${params.search.trim()}%`);
    }

    const { data: vendors, error, count } = await query;

    if (error) {
      console.error('[vendors] Query error:', error);
      return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
    }

    // Get compliance docs and payment holds for all returned vendors
    const vendorIds = (vendors ?? []).map((v: { id: string }) => v.id);
    let complianceMap: Record<string, { w9: string; glCoi: string; wcCoi: string }> = {};
    let holdSet = new Set<string>();
    let defaultAccountMap: Record<string, { account_number: string; name: string }> = {};

    if (vendorIds.length > 0) {
      const [docsResult, holdsResult, accountsResult] = await Promise.all([
        ctx.supabase
          .from('vendor_compliance_docs')
          .select('vendor_id, doc_type, expiration_date, status')
          .in('vendor_id', vendorIds),
        ctx.supabase
          .from('vendor_payment_holds')
          .select('vendor_id')
          .in('vendor_id', vendorIds),
        ctx.supabase
          .from('accounts')
          .select('id, account_number, name')
          .in('id', (vendors ?? []).map((v: { default_account_id: string | null }) => v.default_account_id).filter(Boolean)),
      ]);

      holdSet = new Set((holdsResult.data ?? []).map((h: { vendor_id: string }) => h.vendor_id));

      for (const a of accountsResult.data ?? []) {
        defaultAccountMap[a.id] = { account_number: a.account_number, name: a.name };
      }

      // Build compliance map
      for (const vid of vendorIds) {
        const docs = (docsResult.data ?? []).filter((d: any) => d.vendor_id === vid);
        const w9 = docs.find((d: any) => d.doc_type === 'W9');
        const glCoi = docs.find((d: any) => d.doc_type === 'GL_COI');
        const wcCoi = docs.find((d: any) => d.doc_type === 'WC_COI');

        const now = new Date();
        complianceMap[vid] = {
          w9: w9?.status === 'CURRENT' ? 'VERIFIED' : w9 ? 'PENDING' : 'MISSING',
          glCoi: glCoi ? (glCoi.expiration_date && new Date(glCoi.expiration_date) < now ? 'EXPIRED' : 'VALID') : 'MISSING',
          wcCoi: wcCoi ? (wcCoi.expiration_date && new Date(wcCoi.expiration_date) < now ? 'EXPIRED' : 'VALID') : 'N/A',
        };
      }
    }

    // Enrich vendor data
    const enrichedVendors = (vendors ?? []).map((v: any) => {
      const compliance = complianceMap[v.id] ?? { w9: 'N/A', glCoi: 'N/A', wcCoi: 'N/A' };
      const defaultAccount = v.default_account_id ? defaultAccountMap[v.default_account_id] : null;
      const hasIssue = compliance.w9 === 'MISSING' || compliance.glCoi === 'EXPIRED' || compliance.glCoi === 'MISSING' || compliance.wcCoi === 'EXPIRED';

      return {
        ...v,
        displayName: v.display_name ?? v.name,
        defaultAccount: defaultAccount ? `${defaultAccount.account_number} · ${defaultAccount.name}` : null,
        compliance,
        hasPaymentHold: holdSet.has(v.id),
        hasComplianceIssue: hasIssue,
      };
    });

    // Filter by compliance status if requested
    let filtered = enrichedVendors;
    if (params.compliance === 'issues') {
      filtered = enrichedVendors.filter((v: any) => v.hasComplianceIssue || v.hasPaymentHold);
    } else if (params.compliance === 'compliant') {
      filtered = enrichedVendors.filter((v: any) => !v.hasComplianceIssue && !v.hasPaymentHold);
    }

    return NextResponse.json({
      data: filtered,
      pagination: { page, per_page: perPage, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / perPage) },
      summary: {
        total: enrichedVendors.length,
        withIssues: enrichedVendors.filter((v: any) => v.hasComplianceIssue || v.hasPaymentHold).length,
        with1099: enrichedVendors.filter((v: any) => v.is_1099_eligible).length,
      },
    });
  }
);
