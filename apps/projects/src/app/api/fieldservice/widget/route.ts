import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { errorResponse } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { fsErrorCopy } from '@/lib/fieldservice/errors';
import { checkFormToken, clientIp, honeypotTripped, issueFormToken, verifyChallenge } from '@/lib/fieldservice/widget-guard';

/**
 * PUBLIC online booking widget (FS-09) — no sign-in; the token in the request IS the scope.
 * Uses the anon key (RLS client, never the service role): the only things anon may execute are
 * public.fs_widget_availability / public.fs_widget_book (migration 1117), which resolve the token
 * hash to one company, honour the same capacity rules as CSRs (REQUEST rows hold the slot until
 * they expire) and never create a job — a CSR converts the request.
 *
 * Front door (security review): honeypot field, a signed 3 s – 2 h form token from the availability
 * call, and a Turnstile challenge once FS_TURNSTILE_SECRET is set. The database enforces the hard
 * limits (daily / per-phone / per-IP counters keyed on the IP seen here, lead time, hold expiry) and
 * fails closed: it refuses any caller not presenting FS_WIDGET_SERVER_KEY, whose sha256 Merit ops
 * registers in pm.fs_widget_server_keys — until then the widget answers "isn't set up yet".
 * Needs middleware: '/api/fieldservice/widget(.*)' in isPublicRoute (shared file — requested).
 */

const Token = z.string().min(24).max(200).regex(/^[A-Za-z0-9_-]+$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const BookBody = z.object({
  token: Token,
  bookingJobTypeId: z.string().uuid(),
  arrivalWindowId: z.string().uuid(),
  serviceDay: Day,
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(10).max(40),
  email: z.string().trim().email().max(254).nullish(),
  zip: z.string().trim().regex(/^\d{5}$/).nullish(),
  address: z.string().trim().max(200).nullish(),
  summary: z.string().trim().max(500).nullish(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
  formToken: z.string().max(80).nullish(),
  challengeToken: z.string().max(4096).nullish(),
  website: z.unknown().optional(),
});

const serverKey = () => process.env.FS_WIDGET_SERVER_KEY || null;
const formSecret = () => process.env.FS_WIDGET_FORM_SECRET || process.env.FS_WIDGET_SERVER_KEY || null;

function anon() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

function fail(e: { message?: string | null; code?: string | null }): NextResponse {
  const copy = fsErrorCopy(e);
  if (copy) return NextResponse.json({ error: copy.error, code: copy.code }, { status: copy.status, headers: CORS });
  return NextResponse.json({ error: 'Online booking is unavailable right now. Please call us.', code: 'UNAVAILABLE' }, { status: 503, headers: CORS });
}

/** Bots get one plain answer, never which check tripped. */
function refuse(): NextResponse {
  return NextResponse.json({ error: 'We could not take that request online. Please try again, or call us.', code: 'WIDGET_REFUSED' }, { status: 422, headers: CORS });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const token = Token.safeParse(req.nextUrl.searchParams.get('token') ?? '');
    if (!token.success) throw new HttpError(404, 'This booking link is not active. Please call us.', 'FS_WIDGET_UNKNOWN');
    const from = req.nextUrl.searchParams.get('from');
    const r = await anon().rpc('fs_widget_availability', {
      p_token: token.data, p_from: from && Day.safeParse(from).success ? from : null, p_days: null,
      p_client_ip: clientIp(req.headers), p_server_key: serverKey(),
    });
    if (r.error) return fail(r.error);
    const body = {
      ...(r.data as Record<string, unknown>),
      formToken: issueFormToken(Date.now(), formSecret()),
      challenge: { provider: 'turnstile', siteKey: process.env.NEXT_PUBLIC_FS_TURNSTILE_SITE_KEY || null, required: !!process.env.FS_TURNSTILE_SECRET },
    };
    return NextResponse.json(body, { headers: { ...CORS, 'cache-control': 'no-store' } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const raw: unknown = await req.json().catch(() => null);
    const b = BookBody.safeParse(raw);
    if (!b.success) return NextResponse.json({ error: 'Add your name, phone and a time from the list.', code: 'VALIDATION' }, { status: 422, headers: CORS });
    if (honeypotTripped(b.data.website)) return refuse();
    if (!checkFormToken(b.data.formToken, Date.now(), formSecret()).ok) return refuse();
    const ip = clientIp(req.headers);
    const challenge = await verifyChallenge(b.data.challengeToken, ip, { secret: process.env.FS_TURNSTILE_SECRET, url: process.env.FS_TURNSTILE_VERIFY_URL }, (url, init) => fetch(url, init));
    if (!challenge.ok) return refuse();
    const r = await anon().rpc('fs_widget_book', {
      p_token: b.data.token, p_booking_job_type: b.data.bookingJobTypeId, p_arrival_window: b.data.arrivalWindowId, p_service_day: b.data.serviceDay,
      p_name: b.data.name, p_phone: b.data.phone, p_email: b.data.email ?? null, p_zip: b.data.zip ?? null, p_address: b.data.address ?? null,
      p_summary: b.data.summary ?? null, p_request_id: b.data.requestId ?? null, p_client_ip: ip, p_server_key: serverKey(),
    });
    if (r.error) return fail(r.error);
    return NextResponse.json(r.data, { headers: CORS });
  } catch (e) {
    return errorResponse(e);
  }
}
