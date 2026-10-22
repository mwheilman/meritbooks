import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanSearch, rows } from '@/lib/pm/db';
import { customerNames, vendorNames } from '@/lib/pm/ops/scope';
import { walkSupersession, type CounterMatch, type CounterPart } from './math';
import {
  COUNT_COLS, COUNT_LINE_COLS, ON_HAND_COLS, PARTS_ORDER_COLS, PARTS_ORDER_LINE_COLS, PART_COLS, SPECIAL_ORDER_COLS, TICKET_COLS, TICKET_LINE_COLS,
  type CountLineRow, type CountRow, type PartOnHandRow, type PartRow, type PartsOrderLineRow, type PartsOrderRow, type SpecialOrderRow,
  type TicketLineRow, type TicketRow,
} from './types';

const pm = (db: SupabaseClient) => db.schema('pm');

function numPart(p: PartRow): PartRow {
  return {
    ...p,
    cost_cents: p.cost_cents == null ? null : Number(p.cost_cents),
    list_price_cents: p.list_price_cents == null ? null : Number(p.list_price_cents),
    price_cents: p.price_cents == null ? null : Number(p.price_cents),
    core_charge_cents: Number(p.core_charge_cents),
  };
}

function numOnHand(r: PartOnHandRow): PartOnHandRow {
  return {
    ...r,
    qty_on_hand: Number(r.qty_on_hand), min_qty: r.min_qty == null ? null : Number(r.min_qty), max_qty: r.max_qty == null ? null : Number(r.max_qty),
    qty_on_order: Number(r.qty_on_order), qty_special_order_open: Number(r.qty_special_order_open),
    cost_cents: r.cost_cents == null ? null : Number(r.cost_cents), price_cents: r.price_cents == null ? null : Number(r.price_cents),
    core_charge_cents: Number(r.core_charge_cents), extended_cost_cents: Number(r.extended_cost_cents),
  };
}

export interface Catalog {
  parts: PartRow[];
  onHand: PartOnHandRow[];
  vendors: Record<string, string>;
  capped: boolean;
}

/** The parts catalog with on-hand, bins and min/max per stock location (pm.v_parts_on_hand). */
export async function loadCatalog(db: SupabaseClient, companyIds: ReadonlyArray<string>, q = '', cap = 2000): Promise<Catalog> {
  if (!companyIds.length) return { parts: [], onHand: [], vendors: {}, capped: false };
  const term = cleanSearch(q);
  let pq = pm(db).from('v_parts_masked').select(PART_COLS, { count: 'exact' }).in('location_id', [...companyIds]);
  if (term) pq = pq.or(`part_number.ilike.*${term}*,description.ilike.*${term}*,manufacturer.ilike.*${term}*`);
  const res = await pq.order('part_number').limit(cap);
  const parts = rows<PartRow>(res, 'parts').map(numPart);
  const onHand = parts.length
    ? rows<PartOnHandRow>(await pm(db).from('v_parts_on_hand').select(ON_HAND_COLS).in('location_id', [...companyIds]).limit(10_000), 'on hand').map(numOnHand)
    : [];
  const vendors = await vendorNames(db, parts.map((p) => p.mfr_vendor_id));
  return { parts, onHand, vendors, capped: (res.count ?? 0) > parts.length };
}

export interface CounterSearch {
  matches: Array<CounterMatch & { onHand: PartOnHandRow[]; part: PartRow }>;
  suggestions: Array<{ id: string; part_number: string; manufacturer: string | null; description: string }>;
}

const asCounter = (p: PartRow): CounterPart => ({ id: p.id, part_number: p.part_number, manufacturer: p.manufacturer, description: p.description, status: p.status });

/**
 * A part number keyed at the counter: exact matches (any manufacturer line), each followed to its
 * current number (pm.resolve_part's rule), with on-hand by bin for the part the ticket sells.
 * Prefix suggestions come back when nothing matches exactly.
 */
export async function counterSearch(db: SupabaseClient, companyId: string, keyed: string): Promise<CounterSearch> {
  const pn = keyed.trim().toUpperCase();
  if (!pn) return { matches: [], suggestions: [] };
  const exact = rows<PartRow>(await pm(db).from('v_parts_masked').select(PART_COLS).eq('location_id', companyId).eq('part_number', pn).limit(10), 'part').map(numPart);
  if (!exact.length) {
    const term = cleanSearch(pn);
    const sug = term
      ? rows<{ id: string; part_number: string; manufacturer: string | null; description: string }>(
          await pm(db).from('parts').select('id, part_number, manufacturer, description').eq('location_id', companyId).or(`part_number.ilike.${term}*,description.ilike.*${term}*`).order('part_number').limit(8),
          'part suggestions',
        )
      : [];
    return { matches: [], suggestions: sug };
  }
  // walk supersession chains (one query per hop; chains are short)
  const byId = new Map<string, PartRow>(exact.map((p) => [p.id, p]));
  let frontier = exact.map((p) => p.superseded_by_part_id).filter((x): x is string => !!x && !byId.has(x));
  for (let hop = 0; hop < 25 && frontier.length; hop++) {
    const next = rows<PartRow>(await pm(db).from('v_parts_masked').select(PART_COLS).in('id', frontier), 'superseding parts').map(numPart);
    for (const p of next) byId.set(p.id, p);
    frontier = next.map((p) => p.superseded_by_part_id).filter((x): x is string => !!x && !byId.has(x));
  }
  const resolved = exact.map((p) => {
    const w = walkSupersession(p.id, byId);
    return { requested: p, resolved: byId.get(w.resolvedId)!, chain: w.chain.map((id) => byId.get(id)?.part_number ?? '?') };
  });
  const ids = [...new Set(resolved.map((r) => r.resolved.id))];
  const onHand = rows<PartOnHandRow>(await pm(db).from('v_parts_on_hand').select(ON_HAND_COLS).in('part_id', ids), 'on hand').map(numOnHand);
  return {
    matches: resolved.map((r) => ({
      requested: asCounter(r.requested), resolved: asCounter(r.resolved), chain: r.chain,
      part: r.resolved, onHand: onHand.filter((o) => o.part_id === r.resolved.id),
    })),
    suggestions: [],
  };
}

export interface TicketDetail {
  ticket: TicketRow;
  lines: Array<TicketLineRow & { part_number: string; manufacturer: string | null; requested_number: string | null; on_hand: number; bin: string | null }>;
  customer: string | null;
}

export async function loadTicket(db: SupabaseClient, ticketId: string): Promise<TicketDetail | null> {
  const t = await pm(db).from('parts_tickets').select(TICKET_COLS).eq('id', ticketId).maybeSingle();
  if (t.error || !t.data) return null;
  const ticket = { ...(t.data as TicketRow), tax_rate_estimate: (t.data as TicketRow).tax_rate_estimate == null ? null : Number((t.data as TicketRow).tax_rate_estimate) };
  const lines = rows<TicketLineRow>(await pm(db).from('v_parts_ticket_lines_masked').select(TICKET_LINE_COLS).eq('ticket_id', ticketId).order('sort').order('line_no'), 'ticket lines')
    .map((l) => ({ ...l, qty_requested: Number(l.qty_requested), qty_filled: Number(l.qty_filled), qty_special_order: Number(l.qty_special_order), unit_price_cents: Number(l.unit_price_cents), unit_cost_cents: l.unit_cost_cents == null ? null : Number(l.unit_cost_cents), core_charge_cents: Number(l.core_charge_cents), amount_cents: Number(l.amount_cents) }));
  const partIds = [...new Set(lines.flatMap((l) => [l.part_id, l.requested_part_id]).filter((x): x is string => !!x))];
  const parts = partIds.length ? rows<{ id: string; part_number: string; manufacturer: string | null }>(await pm(db).from('parts').select('id, part_number, manufacturer').in('id', partIds), 'parts') : [];
  const onHand = partIds.length ? rows<PartOnHandRow>(await pm(db).from('v_parts_on_hand').select(ON_HAND_COLS).in('part_id', partIds).eq('stock_location_id', ticket.stock_location_id), 'on hand').map(numOnHand) : [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const customer = ticket.customer_id ? (await customerNames(db, [ticket.customer_id]))[ticket.customer_id] ?? null : null;
  return {
    ticket,
    lines: lines.map((l) => {
      const oh = onHand.find((o) => o.part_id === l.part_id);
      return { ...l, part_number: byId.get(l.part_id)?.part_number ?? '?', manufacturer: byId.get(l.part_id)?.manufacturer ?? null, requested_number: l.requested_part_id ? byId.get(l.requested_part_id)?.part_number ?? null : null, on_hand: oh?.qty_on_hand ?? 0, bin: oh?.bin ?? null };
    }),
    customer,
  };
}

/** Open tickets (to resume) and the last week's closed ones. */
export async function loadTickets(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<{ tickets: TicketRow[]; customers: Record<string, string> }> {
  if (!companyIds.length) return { tickets: [], customers: {} };
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const tickets = rows<TicketRow>(
    await pm(db).from('parts_tickets').select(TICKET_COLS).in('location_id', [...companyIds]).or(`status.eq.OPEN,closed_at.gte."${since}"`).order('created_at', { ascending: false }).limit(200),
    'counter tickets',
  );
  return { tickets, customers: await customerNames(db, tickets.map((t) => t.customer_id)) };
}

export interface SpecialOrderList {
  orders: SpecialOrderRow[];
  parts: Record<string, { part_number: string; description: string }>;
  customers: Record<string, string>;
  vendors: Record<string, string>;
  ros: Record<string, string>;
  deals: Record<string, string>;
}

export async function loadSpecialOrders(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<SpecialOrderList> {
  const empty: SpecialOrderList = { orders: [], parts: {}, customers: {}, vendors: {}, ros: {}, deals: {} };
  if (!companyIds.length) return empty;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const orders = rows<SpecialOrderRow>(
    await pm(db).from('parts_special_orders').select(SPECIAL_ORDER_COLS).in('location_id', [...companyIds])
      .or(`status.in.(REQUESTED,ORDERED,RECEIVED,NOTIFIED),updated_at.gte."${since}"`).order('created_at', { ascending: false }).limit(500),
    'special orders',
  ).map((o) => ({ ...o, qty: Number(o.qty) }));
  if (!orders.length) return empty;
  const partIds = [...new Set(orders.map((o) => o.part_id))];
  const woIds = [...new Set(orders.map((o) => o.work_order_id).filter((x): x is string => !!x))];
  const dealIds = [...new Set(orders.map((o) => o.deal_id).filter((x): x is string => !!x))];
  const [parts, customers, vendors, ros, deals] = await Promise.all([
    rows<{ id: string; part_number: string; description: string }>(await pm(db).from('parts').select('id, part_number, description').in('id', partIds), 'parts'),
    customerNames(db, orders.map((o) => o.customer_id)),
    vendorNames(db, orders.map((o) => o.vendor_id)),
    woIds.length ? rows<{ id: string; number: string | null }>(await pm(db).from('work_orders').select('id, number').in('id', woIds), 'repair orders') : Promise.resolve([] as Array<{ id: string; number: string | null }>),
    dealIds.length ? rows<{ id: string; number: string }>(await pm(db).from('dealer_deals').select('id, number').in('id', dealIds), 'deals') : Promise.resolve([] as Array<{ id: string; number: string }>),
  ]);
  return {
    orders,
    parts: Object.fromEntries(parts.map((p) => [p.id, { part_number: p.part_number, description: p.description }])),
    customers, vendors,
    ros: Object.fromEntries(ros.map((r) => [r.id, r.number ?? 'RO'])),
    deals: Object.fromEntries(deals.map((d) => [d.id, d.number])),
  };
}

export interface PartsOrderList {
  orders: PartsOrderRow[];
  lines: PartsOrderLineRow[];
  parts: Record<string, { part_number: string; description: string }>;
  vendors: Record<string, string>;
}

export async function loadPartsOrders(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<PartsOrderList> {
  if (!companyIds.length) return { orders: [], lines: [], parts: {}, vendors: {} };
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const orders = rows<PartsOrderRow>(
    await pm(db).from('parts_orders').select(PARTS_ORDER_COLS).in('location_id', [...companyIds]).or(`status.in.(DRAFT,SUBMITTED,PARTIAL),created_at.gte."${since}"`).order('created_at', { ascending: false }).limit(200),
    'parts orders',
  );
  const ids = orders.map((o) => o.id);
  const lines = ids.length
    ? rows<PartsOrderLineRow>(await pm(db).from('v_parts_order_lines_masked').select(PARTS_ORDER_LINE_COLS).in('order_id', ids).order('line_no'), 'order lines').map((l) => ({ ...l, qty_ordered: Number(l.qty_ordered), qty_received: Number(l.qty_received), unit_cost_cents: l.unit_cost_cents == null ? null : Number(l.unit_cost_cents) }))
    : [];
  const partIds = [...new Set(lines.map((l) => l.part_id))];
  const [parts, vendors] = await Promise.all([
    partIds.length ? rows<{ id: string; part_number: string; description: string }>(await pm(db).from('parts').select('id, part_number, description').in('id', partIds), 'parts') : Promise.resolve([] as Array<{ id: string; part_number: string; description: string }>),
    vendorNames(db, orders.map((o) => o.vendor_id)),
  ]);
  return { orders, lines, parts: Object.fromEntries(parts.map((p) => [p.id, { part_number: p.part_number, description: p.description }])), vendors };
}

export interface CountList {
  counts: CountRow[];
  lines: Array<CountLineRow & { part_number: string; description: string; bin: string | null }>;
}

/** Counts (the open one with its lines first). */
export async function loadCounts(db: SupabaseClient, companyIds: ReadonlyArray<string>): Promise<CountList> {
  if (!companyIds.length) return { counts: [], lines: [] };
  const counts = rows<CountRow>(await pm(db).from('parts_counts').select(COUNT_COLS).in('location_id', [...companyIds]).order('started_at', { ascending: false }).limit(50), 'counts');
  const open = counts.filter((c) => c.status === 'OPEN').map((c) => c.id);
  if (!open.length) return { counts, lines: [] };
  const lines = rows<CountLineRow>(await pm(db).from('parts_count_lines').select(COUNT_LINE_COLS).in('count_id', open).limit(5000), 'count lines')
    .map((l) => ({ ...l, expected_qty: Number(l.expected_qty), counted_qty: l.counted_qty == null ? null : Number(l.counted_qty), variance_qty: l.variance_qty == null ? null : Number(l.variance_qty) }));
  const partIds = [...new Set(lines.map((l) => l.part_id))];
  const parts = partIds.length ? rows<{ id: string; part_number: string; description: string; item_id: string }>(await pm(db).from('parts').select('id, part_number, description, item_id').in('id', partIds.slice(0, 5000)), 'parts') : [];
  const bins = partIds.length ? rows<{ part_id: string; stock_location_id: string; bin: string | null }>(await pm(db).from('v_parts_on_hand').select('part_id, stock_location_id, bin').in('part_id', partIds.slice(0, 5000)), 'bins') : [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const countLoc = new Map(counts.map((c) => [c.id, c.stock_location_id]));
  return {
    counts,
    lines: lines.map((l) => ({
      ...l,
      part_number: byId.get(l.part_id)?.part_number ?? '?',
      description: byId.get(l.part_id)?.description ?? '',
      bin: bins.find((b) => b.part_id === l.part_id && b.stock_location_id === countLoc.get(l.count_id))?.bin ?? null,
    })).sort((a, b) => (a.bin ?? '~').localeCompare(b.bin ?? '~') || a.part_number.localeCompare(b.part_number)),
  };
}
