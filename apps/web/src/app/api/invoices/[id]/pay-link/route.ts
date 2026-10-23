export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { resolvePayLink } from '@/lib/invoices/pay-link';
import { summarizeOnlineActivity, ONLINE_EVENT_TYPES, type OnlineEvent } from '@/lib/invoices/online-activity';
import { encodeQr, qrSvgPath } from '@/lib/qr/qr-code';

/**
 * GET /api/invoices/[id]/pay-link — the drawer's Pay link panel.
 *
 * Returns the hosted link, whether the customer can really pay online right now (and in
 * which mode — TEST is labelled honestly), why not when they can't, the QR code as an
 * SVG path, and what the customer has done with the link (views, payment attempts,
 * paid online) from invoice_events. Read-only, through the member's RLS client.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  return apiQueryHandler(null, async (_q, ctx) => {
    const { supabase, orgId } = ctx;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const { data: inv } = await supabase
      .from('invoices')
      .select('id, public_token, status, balance_cents, location_id, customer_id, job_id, payment_methods_allowed')
      .eq('org_id', orgId)
      .eq('id', params.id)
      .maybeSingle();
    const row = inv as {
      id: string; public_token: string; status: string; balance_cents: number;
      location_id: string | null; customer_id: string | null; job_id: string | null; payment_methods_allowed: string[] | null;
    } | null;
    if (!row) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    const [link, { data: evRows }] = await Promise.all([
      resolvePayLink(supabase, orgId, { ...row, balance_cents: Number(row.balance_cents ?? 0) }),
      supabase
        .from('invoice_events')
        .select('event_type, created_at, meta')
        .eq('org_id', orgId)
        .eq('invoice_id', row.id)
        .in('event_type', ONLINE_EVENT_TYPES)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    const events = (evRows ?? []) as OnlineEvent[];
    const activity = summarizeOnlineActivity(events);
    const qr = qrSvgPath(encodeQr(link.url, { ecc: 'M' }), { quiet: 2 });

    return NextResponse.json({
      url: link.url,
      payable: link.payable,
      mode: link.mode,
      methods: link.methods,
      code: link.code,
      reason: link.reason,
      qr,
      activity,
      // The 12 most recent customer events, newest first (plain English in the UI).
      timeline: events.slice(0, 12).map((e) => ({
        type: e.event_type,
        at: e.created_at,
        method: typeof e.meta?.method === 'string' ? e.meta.method : null,
        amountCents: typeof e.meta?.amount_cents === 'number' ? e.meta.amount_cents : null,
      })),
    });
  })(req);
}
