export const dynamic = 'force-dynamic';

/**
 * Homeowner self-booking (RES-10): the no-account page behind a company's booking link. ANON key,
 * no session; it calls only public.wc_booking_slots / public.wc_self_book (migration 1124), which
 * match sha-256(token) first and return open start times only (no rep names, no addresses). Plain
 * HTML, escaped, no-store, no referrer. The request lands on the calendar as REQUESTED until staff
 * put it on a rep. Middleware must list /api/residential/public-book/(.*) as public (lead).
 */
import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { isTokenShape } from '@/lib/esign/token';
import { serverKey } from '@/lib/fieldservice/public-db';
import { verifyChallenge } from '@/lib/fieldservice/widget-guard';
import { esc, page, trustedClientIp } from '@/lib/residential/public-page';

function anon() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The keyed hash secret: WC_BOOKING_IP_SECRET, else FS_WIDGET_FORM_SECRET. Production without one fails closed. */
function ipSecret(): string | null {
  const s = process.env.WC_BOOKING_IP_SECRET || process.env.FS_WIDGET_FORM_SECRET || null;
  if (s) return s;
  return process.env.NODE_ENV === 'production' ? null : 'wc-book-dev-only';
}

/** HMAC-SHA256 of the platform-vouched client IP (the database keeps the keyed hash only; null when the platform gave none). */
function clientHash(req: NextRequest, secret: string): string | null {
  const ip = trustedClientIp(req.headers, req.ip ?? null);
  return ip ? createHmac('sha256', secret).update(`wc-book:${ip}`).digest('hex') : null;
}

const unavailable = () => html(page('Online booking unavailable', '<p>Online booking is not set up right now. Call the office to book a visit.</p>'), 503);

const SITE_KEY = () => process.env.NEXT_PUBLIC_FS_TURNSTILE_SITE_KEY || null;

const html = (body: string, status = 200) =>
  new NextResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } });

interface SlotsAnswer { label: string; company: string | null; day: string; minutes: number; times: string[] }

function days(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

async function render(token: string, day: string | null, flash: string | null): Promise<NextResponse> {
  const action = `/api/residential/public-book/${encodeURIComponent(token)}`;
  const pick = day ?? days(1)[0]!;
  const r = await anon().rpc('wc_booking_slots', { p_server_key: serverKey(), p_token: token, p_day: pick });
  if (r.error && /FS_WIDGET_(NOT_SET_UP|KEY)/.test(r.error.message)) return unavailable();
  if (r.error) return html(page('Link unavailable', '<p>This booking link is not valid. Call the office to book a visit.</p>'), 410);
  const s = r.data as SlotsAnswer;
  const dayLinks = days(10).map((d) => `<a href="${action}?day=${d}" style="margin-right:10px">${d === pick ? `<b>${esc(dayLabel(d))}</b>` : esc(dayLabel(d))}</a>`).join(' ');
  const times = s.times.length
    ? s.times.map((t) => `<label><input type="radio" name="starts_at" value="${esc(t)}" required> ${esc(timeLabel(t))}</label>`).join('')
    : '<p>No open times that day. Pick another day.</p>';
  return html(page(`${s.label}${s.company ? ` — ${s.company}` : ''}`, `${flash ? `<p class="ok">${esc(flash)}</p>` : ''}
    <p>${dayLinks}</p>
    <form method="post" action="${action}"><input type="hidden" name="day" value="${esc(pick)}">
      <p><b>${esc(dayLabel(pick))}</b> · about ${esc(s.minutes)} minutes</p>${times}
      <label>Your name <input name="name" required maxlength="200"></label>
      <label>Mobile phone <input name="phone" inputmode="tel" maxlength="40"></label>
      <label>Email <input name="email" type="email" maxlength="254"></label>
      <label>Street address <input name="address" maxlength="500"></label>
      <label>ZIP <input name="zip" inputmode="numeric" maxlength="12"></label>
      <label>What would you like done? <textarea name="notes" maxlength="4000"></textarea></label>
      ${SITE_KEY() ? `<div class="cf-turnstile" data-sitekey="${esc(SITE_KEY())}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}
      <button class="primary">Request this time</button></form>`));
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  if (!isTokenShape(params.token)) return html(page('Link unavailable', '<p>This booking link is not valid.</p>'), 404);
  const day = req.nextUrl.searchParams.get('day');
  return render(params.token, day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null, null);
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  if (!isTokenShape(params.token)) return html(page('Link unavailable', '<p>This booking link is not valid.</p>'), 404);
  const secret = ipSecret();
  if (!secret || !serverKey()) return unavailable();
  const form = await req.formData();
  const s = (k: string) => String(form.get(k) ?? '').trim();
  // Turnstile once FS_TURNSTILE_SECRET is set (fails closed then); the per-client limit is in the database
  const ip = trustedClientIp(req.headers, req.ip ?? null);
  const challenge = await verifyChallenge(s('cf-turnstile-response'), ip, { secret: process.env.FS_TURNSTILE_SECRET ?? null, url: process.env.FS_TURNSTILE_VERIFY_URL ?? null },
    (url, init) => fetch(url, init));
  if (!challenge.ok) return render(params.token, s('day') || null, 'Please complete the check below and try again.');
  const r = await anon().rpc('wc_self_book', { p_token: params.token, p_starts_at: s('starts_at'), p_name: s('name'), p_phone: s('phone') || null, p_email: s('email') || null,
    p_address: s('address') || null, p_zip: s('zip') || null, p_notes: s('notes') || null, p_ip_hash: clientHash(req, secret), p_server_key: serverKey() });
  if (r.error) {
    const msg = /RATE_LIMITED/.test(r.error.message) ? 'Too many requests right now. Try again later or call the office.'
      : (r.error.message.split(':').slice(1).join(':').trim() || 'That time could not be requested.');
    return render(params.token, s('day') || null, msg);
  }
  return html(page('Request received', `<p class="ok">Thanks, ${esc(s('name'))}. We have your request for ${esc(dayLabel(s('day')))} at ${esc(timeLabel(s('starts_at')))}. The office will confirm by text or email.</p>`));
}
