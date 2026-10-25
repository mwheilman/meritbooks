export const dynamic = 'force-dynamic';

/**
 * The no-account trade links (RES-48 / 30 / 57), served under /api/sign/public/ (already public in middleware): a trade partner taps the text-message link and gets a
 * one-screen page — confirm / can't / propose a date for a schedule request, price a bid package line
 * by line, or accept a purchase order. ANON key, no session; every call goes to a token-scoped
 * SECURITY DEFINER function in schema public (migration 1119) that matches sha-256(token) first and
 * reaches nothing else. Plain HTML (no client JavaScript), escaped, no-store, no referrer.
 */
import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { isTokenShape } from '@/lib/esign/token';
import { centsFromDollars, esc, page, trustedClientIp } from '@/lib/residential/public-page';

type Kind = 'trade' | 'bid' | 'po';
const KINDS: ReadonlySet<string> = new Set(['trade', 'bid', 'po']);

function anon() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The caller's address from the platform's trusted value (lib/residential/public-page.ts) — hashed in the database for the per-client rate limit, never stored raw. */
function clientOf(req: NextRequest): string | null {
  return trustedClientIp(req.headers, req.ip ?? null);
}

async function call(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await anon().rpc(fn, args);
  if (r.error) return { ok: false, reason: 'unavailable' };
  return (r.data as Record<string, unknown> | null) ?? { ok: false, reason: 'invalid' };
}

const html = (body: string, status = 200) =>
  new NextResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } });

const usd = (c: unknown) => (typeof c === 'number' ? `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');

function gone(reason: unknown): NextResponse {
  if (reason === 'rate_limited') {
    const r = html(page('Too many tries', '<p>This link was opened too many times in the last hour. Wait a while and try again, or call the office.</p>'), 429);
    r.headers.set('retry-after', '3600');
    return r;
  }
  const msg = reason === 'expired' ? 'This link has expired or was replaced. Ask the office to send a new one.'
    : reason === 'closed' ? 'Bidding on this package is closed.' : reason === 'unavailable' ? 'We could not open this right now. Try again in a minute.' : 'This link is not valid.';
  return html(page('Link unavailable', `<p>${esc(msg)}</p>`), reason === 'unavailable' ? 503 : 410);
}

async function render(kind: Kind, token: string, flash: string | null, client: string | null): Promise<NextResponse> {
  const action = `/api/sign/public/trade-link/${kind}/${encodeURIComponent(token)}`;
  const note = flash ? `<p class="ok">${esc(flash)}</p>` : '';
  if (kind === 'trade') {
    const v = await call('res_trade_respond', { p_token: token, p_response: 'VIEW', p_client: client });
    if (!v.ok) return gone(v.reason);
    const when = v.start_on ? new Date(`${String(v.start_on)}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'date to be set';
    return html(page(`${String(v.task)} — ${when}`, `${note}
      <dl><dt>Job</dt><dd>${esc(v.job)}</dd><dt>Address</dt><dd>${esc(v.address) || '—'}</dd><dt>Status</dt><dd>${esc(String(v.status).toLowerCase())}</dd>
      ${v.scope ? `<dt>Scope</dt><dd>${esc(v.scope)}</dd>` : ''}</dl>
      <form method="post" action="${action}"><input type="hidden" name="response" value="CONFIRM"><button class="primary">Confirm ${esc(when)}</button></form>
      <form method="post" action="${action}"><input type="hidden" name="response" value="PROPOSE"><label>Propose another start <input type="date" name="date" required></label>
        <label>Note <input name="note" maxlength="500"></label><button>Propose this date</button></form>
      <form method="post" action="${action}"><input type="hidden" name="response" value="DECLINE"><label>Why can't you make it? <input name="note" maxlength="500" required></label><button>I can't make it</button></form>`));
  }
  if (kind === 'bid') {
    const v = await call('res_bid_portal', { p_token: token, p_action: 'view', p_payload: {}, p_client: client });
    if (!v.ok) return gone(v.reason);
    const open = v.open === true;
    const lines = Array.isArray(v.lines) ? (v.lines as Array<Record<string, unknown>>) : [];
    const rows = lines.map((l) => `<tr><td>${esc(l.description)}<br><small>${esc(l.qty)} ${esc(l.uom)}</small></td>
      <td><input name="line:${esc(l.id)}" inputmode="decimal" placeholder="0.00" value="${typeof l.amount_cents === 'number' ? (l.amount_cents / 100).toFixed(2) : ''}" aria-label="Price for ${esc(l.description)}"></td>
      <td><label><input type="checkbox" name="excl:${esc(l.id)}" ${l.included === false ? 'checked' : ''}> Not included</label></td></tr>`).join('');
    return html(page(`Bid: ${String(v.package)}`, `${note}<p>${esc(v.job)}${v.due_at ? ` · due ${esc(String(v.due_at).slice(0, 10))}` : ''}</p>${v.scope ? `<p>${esc(v.scope)}</p>` : ''}
      ${!open ? '<p class="ok">Bidding on this package is closed. The prices you sent are below.</p>' : v.status === 'INVITED' ? `<form method="post" action="${action}"><input type="hidden" name="action" value="open"><button>Let the office know I'm pricing this</button></form>` : ''}
      ${open ? `<form method="post" action="${action}"><input type="hidden" name="action" value="submit"><table>`: '<table>'}<thead><tr><th>Line</th><th>Your price</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      ${open ? `<label>Exclusions / clarifications <textarea name="exclusions" maxlength="4000">${esc(v.exclusions)}</textarea></label><button class="primary">Submit bid</button></form>
      <form method="post" action="${action}"><input type="hidden" name="action" value="decline"><button>Decline to bid</button></form>` : ''}`));
  }
  const v = await call('res_po_accept', { p_token: token, p_action: 'view', p_name: null, p_client: client });
  if (!v.ok) return gone(v.reason);
  const lines = Array.isArray(v.lines) ? (v.lines as Array<Record<string, unknown>>) : [];
  const accepted = v.accepted_at ? `<p class="ok">Accepted by ${esc(v.accepted_name)} on ${esc(String(v.accepted_at).slice(0, 10))}.</p>` : '';
  return html(page(`${String(v.number)} — ${String(v.title ?? '')}`, `${note}${accepted}<p>${esc(v.job)}</p>${v.description ? `<p>${esc(v.description)}</p>` : ''}
    <table><thead><tr><th>Line</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.qty)} ${esc(l.uom)}</td><td>${usd(l.amount_cents)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="2">Total</th><th>${usd(v.total_cents)}</th></tr></tfoot></table>
    ${v.accepted_at ? '' : `<form method="post" action="${action}"><label>Your name <input name="name" required minlength="2" maxlength="120"></label><button class="primary">Accept this order</button></form>`}`));
}

/** GET only reads (a view never changes a record — security review LOW). */
export async function GET(req: NextRequest, { params }: { params: { kind: string; token: string } }) {
  if (!KINDS.has(params.kind) || !isTokenShape(params.token)) return gone('invalid');
  return render(params.kind as Kind, params.token, null, clientOf(req));
}

export async function POST(req: NextRequest, { params }: { params: { kind: string; token: string } }) {
  if (!KINDS.has(params.kind) || !isTokenShape(params.token)) return gone('invalid');
  const form = await req.formData().catch(() => null);
  if (!form) return gone('invalid');
  const s = (k: string, max = 500) => { const v = form.get(k); return typeof v === 'string' ? v.trim().slice(0, max) : ''; };
  const token = params.token;
  const client = clientOf(req);
  let flash = '';
  if (params.kind === 'trade') {
    const response = s('response', 10).toUpperCase();
    if (!['CONFIRM', 'DECLINE', 'PROPOSE'].includes(response)) return gone('invalid');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(s('date', 10)) ? s('date', 10) : null;
    const r = await call('res_trade_respond', { p_token: token, p_response: response, p_proposed_on: date, p_note: s('note') || null, p_client: client });
    if (!r.ok) return r.reason === 'date' ? render('trade', token, 'Pick a date from today on.', client) : gone(r.reason);
    flash = response === 'CONFIRM' ? 'Confirmed — thank you. The office has it.' : response === 'PROPOSE' ? 'Your date was sent to the office.' : 'Sent. The office will reschedule.';
  } else if (params.kind === 'bid') {
    const act = s('action', 10);
    if (act === 'open') {
      const r = await call('res_bid_portal', { p_token: token, p_action: 'open', p_payload: {}, p_client: client });
      if (!r.ok) return gone(r.reason);
      flash = 'Thanks — the office knows you are pricing it.';
    } else if (act === 'decline') {
      const r = await call('res_bid_portal', { p_token: token, p_action: 'decline', p_payload: { notes: s('notes', 2000) || null }, p_client: client });
      if (!r.ok) return gone(r.reason);
      flash = 'You declined this bid.';
    } else {
      const prices: Array<{ line_id: string; amount_cents: number | null; included: boolean }> = [];
      for (const [k, v] of form.entries()) {
        if (!k.startsWith('line:') || typeof v !== 'string') continue;
        const id = k.slice(5);
        const excluded = form.get(`excl:${id}`) != null;
        const cents = centsFromDollars(v);
        if (cents === undefined) return render('bid', token, 'Prices are dollars and cents, like 1250.00.', client);
        prices.push({ line_id: id, amount_cents: excluded ? null : cents, included: !excluded && cents !== null });
      }
      const r = await call('res_bid_portal', { p_token: token, p_action: 'submit', p_payload: { prices, exclusions: s('exclusions', 4000) || null }, p_client: client });
      if (!r.ok) return r.reason === 'closed' || r.reason === 'expired' || r.reason === 'rate_limited' ? gone(r.reason) : render('bid', token, 'Check the prices and try again.', client);
      flash = `Bid submitted: ${usd(r.total_cents)}.`;
    }
  } else {
    const name = s('name', 120);
    if (name.length < 2) return render('po', token, 'Type your name to accept.', client);
    const r = await call('res_po_accept', { p_token: token, p_action: 'accept', p_name: name, p_client: client });
    if (!r.ok) return gone(r.reason);
    flash = 'Accepted. Thank you.';
  }
  return render(params.kind as Kind, token, flash, client);
}
