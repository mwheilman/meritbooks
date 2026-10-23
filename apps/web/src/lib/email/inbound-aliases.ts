/**
 * Inbound aliases (migration 183): routing a message's recipients to companies,
 * listing a tenant's addresses for the UI, and editing an address's sender rules.
 *
 * Routing runs session-less on the service role (the webhook has no user) — it can
 * only ever resolve to the org that OWNS the alias row. Listing/editing take the
 * caller's org explicitly and pin every query to it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InboundAliasPurpose, ResolvedInboundAlias } from './inbound-types';
import { aliasAddress, readInboundConfig, type InboundConfig } from './inbound-config';
import { domainOf, localPartOf, normalizeAddress, uniqueAddresses } from './inbound-normalize';
import { FREEMAIL_DOMAINS, type AliasSenderPolicy, type SenderFacts, type SenderRule } from './inbound-rules';
import { resolveDefaultLocationId } from '@/lib/ap/inbound-intake';

export interface AliasRow {
  id: string;
  org_id: string;
  location_id: string;
  purpose: InboundAliasPurpose;
  local_part: string;
  domain: string | null;
  is_active: boolean;
  sender_rule: SenderRule;
  allowed_domains: string[];
  allowed_senders: string[];
  fwd_confirm_from: string | null;
  fwd_confirm_code: string | null;
  fwd_confirm_url: string | null;
  fwd_confirm_at: string | null;
  fwd_confirm_verified: boolean | null;
  last_received_at: string | null;
  messages_count: number;
  updated_at: string;
}

const ALIAS_COLS =
  'id, org_id, location_id, purpose, local_part, domain, is_active, sender_rule, allowed_domains, allowed_senders, ' +
  'fwd_confirm_from, fwd_confirm_code, fwd_confirm_url, fwd_confirm_at, fwd_confirm_verified, last_received_at, messages_count, updated_at';

/** One recipient that resolved to a company address. */
export interface RoutedAddress {
  resolved: ResolvedInboundAlias;
  /** The alias row (null for the legacy org address). */
  alias: AliasRow | null;
  /** False when the alias is switched off OR its company is inactive. */
  accepting: boolean;
  inactiveReason: string | null;
  policy: AliasSenderPolicy;
  legacy: boolean;
}

const ANY_POLICY: AliasSenderPolicy = { sender_rule: 'any', allowed_domains: [], allowed_senders: [] };

/**
 * The local part to look up for a recipient, or null when the recipient is not on
 * an inbound domain we serve: (a) <alias>@INBOUND_EMAIL_DOMAIN; (b) <hash>+<alias>@…
 * when <hash>@… is the provider's own inbound address (test before DNS).
 */
export function aliasLocalFor(recipient: string, cfg: InboundConfig): { local: string; domain: string | null } | null {
  const addr = normalizeAddress(recipient);
  if (!addr) return null;
  const local = localPartOf(addr);
  const domain = domainOf(addr);
  if (cfg.providerAddress) {
    const plus = local.indexOf('+');
    if (plus > 0 && `${local.slice(0, plus)}@${domain}` === cfg.providerAddress) {
      return { local: local.slice(plus + 1), domain: null };
    }
  }
  if (cfg.domain && domain === cfg.domain) return { local, domain: null };
  // custom (white-label) alias domains are matched by the caller against alias.domain
  return { local, domain };
}

/**
 * Resolve every recipient that is one of our addresses. Order = recipient order;
 * one entry per distinct alias. Unknown recipients are simply absent.
 */
export async function routeRecipients(
  admin: SupabaseClient,
  recipients: string[],
  cfg: InboundConfig = readInboundConfig(),
): Promise<RoutedAddress[]> {
  const addrs = uniqueAddresses(recipients);
  const platformLocals = new Map<string, string>(); // local → recipient
  const customPairs: Array<{ local: string; domain: string; recipient: string }> = [];
  for (const r of addrs) {
    const k = aliasLocalFor(r, cfg);
    if (!k) continue;
    if (k.domain === null) {
      if (!platformLocals.has(k.local)) platformLocals.set(k.local, r);
    } else customPairs.push({ local: k.local, domain: k.domain, recipient: r });
  }

  const rows: Array<{ row: AliasRow; recipient: string }> = [];
  if (platformLocals.size > 0) {
    const { data, error } = await admin
      .schema('core').from('inbound_aliases').select(ALIAS_COLS)
      .is('domain', null)
      .in('local_part', Array.from(platformLocals.keys()));
    if (error) throw new Error(`Alias lookup failed: ${error.message}`);
    for (const row of (data ?? []) as unknown as AliasRow[]) rows.push({ row, recipient: platformLocals.get(row.local_part) ?? row.local_part });
  }
  for (const p of customPairs) {
    const { data } = await admin
      .schema('core').from('inbound_aliases').select(ALIAS_COLS)
      .eq('domain', p.domain).eq('local_part', p.local).limit(1);
    const row = ((data ?? []) as unknown as AliasRow[])[0];
    if (row) rows.push({ row, recipient: p.recipient });
  }

  // Company active? (an inactive company's address stops accepting mail)
  const locIds = Array.from(new Set(rows.map((r) => r.row.location_id)));
  const activeLoc = new Map<string, boolean>();
  if (locIds.length) {
    const { data } = await admin.schema('core').from('locations').select('id, is_active').in('id', locIds);
    for (const l of (data ?? []) as Array<{ id: string; is_active: boolean }>) activeLoc.set(l.id, l.is_active);
  }

  const out: RoutedAddress[] = [];
  const seen = new Set<string>();
  for (const { row, recipient } of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const companyActive = activeLoc.get(row.location_id) !== false;
    out.push({
      resolved: {
        aliasId: row.id,
        orgId: row.org_id,
        locationId: row.location_id,
        purpose: row.purpose,
        address: aliasAddress(row.local_part, row.domain, cfg) || recipient,
      },
      alias: row,
      accepting: row.is_active && companyActive,
      inactiveReason: !row.is_active ? 'This address is switched off.' : companyActive ? null : 'This company is inactive.',
      policy: { sender_rule: row.sender_rule, allowed_domains: row.allowed_domains ?? [], allowed_senders: row.allowed_senders ?? [] },
      legacy: false,
    });
  }

  // Legacy per-organization address (migration 135): only for recipients no alias claimed.
  const claimed = new Set(rows.map((r) => r.recipient));
  const unclaimed = addrs.filter((a) => !claimed.has(a));
  if (unclaimed.length) {
    const { data } = await admin
      .schema('core').from('organizations').select('id, inbound_ap_address')
      .in('inbound_ap_address', unclaimed).limit(5);
    for (const org of (data ?? []) as Array<{ id: string; inbound_ap_address: string }>) {
      const locationId = await resolveDefaultLocationId(admin, org.id);
      if (!locationId) continue;
      out.push({
        resolved: { aliasId: null, orgId: org.id, locationId, purpose: 'ap', address: org.inbound_ap_address },
        alias: null,
        accepting: true,
        inactiveReason: null,
        policy: ANY_POLICY,
        legacy: true,
      });
    }
  }
  return out;
}

/** Emails of active team members + vendors in an org, for the sender rules. */
export async function loadSenderFacts(admin: SupabaseClient, orgId: string): Promise<SenderFacts> {
  const memberEmails = new Set<string>();
  const vendorEmails = new Set<string>();
  const { data: ms } = await admin.schema('core').from('memberships').select('user_id').eq('org_id', orgId).eq('status', 'active').limit(2000);
  const userIds = Array.from(new Set(((ms ?? []) as Array<{ user_id: string | null }>).map((m) => m.user_id).filter((x): x is string => Boolean(x))));
  for (let i = 0; i < userIds.length; i += 200) {
    const { data: us } = await admin.schema('core').from('users').select('id, email').in('id', userIds.slice(i, i + 200));
    for (const u of (us ?? []) as Array<{ email: string | null }>) {
      const e = normalizeAddress(u.email ?? '');
      if (e) memberEmails.add(e);
    }
  }
  const { data: vs } = await admin.schema('core').from('vendors').select('email').eq('org_id', orgId).is('deleted_at', null).limit(5000);
  for (const v of (vs ?? []) as Array<{ email: string | null }>) {
    for (const part of (v.email ?? '').split(/[,;]/)) {
      const e = normalizeAddress(part);
      if (e) vendorEmails.add(e);
    }
  }
  const cardholderEmails = new Set<string>();
  const { data: cs, error: csErr } = await admin.from('card_assignments').select('holder_email').eq('org_id', orgId).eq('active', true).limit(5000);
  if (!csErr) {
    for (const c of (cs ?? []) as Array<{ holder_email: string | null }>) {
      const e = normalizeAddress(c.holder_email ?? '');
      if (e) cardholderEmails.add(e);
    }
  }
  return { memberEmails, vendorEmails, cardholderEmails };
}

/**
 * Best-effort: a vendor in the org whose email (or non-freemail domain) matches the sender.
 * Callers MUST only use this for a VERIFIED sender (email.auth.verified) — a forged From
 * must never be matched to a vendor.
 */
export async function vendorForSender(
  admin: SupabaseClient,
  orgId: string,
  fromAddress: string,
): Promise<{ id: string; name: string; defaultAccountId: string | null } | null> {
  const from = normalizeAddress(fromAddress);
  if (!from) return null;
  const { data } = await admin.schema('core').from('vendors').select('id, name, display_name, email, default_account_id').eq('org_id', orgId).is('deleted_at', null).limit(5000);
  const rows = (data ?? []) as Array<{ id: string; name: string; display_name: string | null; email: string | null; default_account_id: string | null }>;
  const exact = rows.find((r) => (r.email ?? '').split(/[,;]/).some((e) => normalizeAddress(e) === from));
  if (exact) return { id: exact.id, name: exact.display_name ?? exact.name, defaultAccountId: exact.default_account_id };
  const d = domainOf(from);
  if (!d || FREEMAIL_DOMAINS.has(d)) return null;
  const byDomain = rows.filter((r) => (r.email ?? '').split(/[,;]/).some((e) => domainOf(e) === d));
  return byDomain.length === 1
    ? { id: byDomain[0].id, name: byDomain[0].display_name ?? byDomain[0].name, defaultAccountId: byDomain[0].default_account_id }
    : null;
}

// ── Listing / editing (authenticated routes) ────────────────────────────────

export interface AliasView {
  id: string;
  locationId: string;
  companyName: string;
  companyActive: boolean;
  purpose: InboundAliasPurpose;
  address: string;
  isActive: boolean;
  senderRule: SenderRule;
  allowedDomains: string[];
  allowedSenders: string[];
  lastReceivedAt: string | null;
  messagesCount: number;
  forwardingConfirmation: {
    requestedBy: string | null;
    code: string | null;
    url: string | null;
    receivedAt: string | null;
    authenticated: boolean;
  } | null;
}

/**
 * The Gmail forwarding code / link confirms a mailbox forwards INTO this address — only
 * someone who can manage the address may see it. Others see that one is waiting.
 */
export function redactForwarding(view: AliasView): AliasView {
  if (!view.forwardingConfirmation) return view;
  return { ...view, forwardingConfirmation: { ...view.forwardingConfirmation, code: null, url: null } };
}

export function toAliasView(row: AliasRow, company: { name: string; is_active: boolean } | undefined, cfg: InboundConfig): AliasView {
  return {
    id: row.id,
    locationId: row.location_id,
    companyName: company?.name ?? 'Unknown company',
    companyActive: company?.is_active !== false,
    purpose: row.purpose,
    address: aliasAddress(row.local_part, row.domain, cfg),
    isActive: row.is_active,
    senderRule: row.sender_rule,
    allowedDomains: row.allowed_domains ?? [],
    allowedSenders: row.allowed_senders ?? [],
    lastReceivedAt: row.last_received_at,
    messagesCount: row.messages_count,
    forwardingConfirmation:
      row.fwd_confirm_at
        ? { requestedBy: row.fwd_confirm_from, code: row.fwd_confirm_code, url: row.fwd_confirm_url, receivedAt: row.fwd_confirm_at, authenticated: row.fwd_confirm_verified === true }
        : null,
  };
}

/**
 * Every address in the org (optionally one company), with company names. Companies
 * that somehow lack addresses (trigger failure) get them now (service role).
 */
export async function listAliases(
  admin: SupabaseClient,
  orgId: string,
  opts: { locationIds?: string[] | null; cfg?: InboundConfig } = {},
): Promise<AliasView[]> {
  const cfg = opts.cfg ?? readInboundConfig();
  let locQ = admin.schema('core').from('locations').select('id, name, is_active').eq('org_id', orgId);
  if (opts.locationIds && opts.locationIds.length) locQ = locQ.in('id', opts.locationIds);
  const { data: locs, error: locErr } = await locQ.order('name');
  if (locErr) throw new Error(locErr.message);
  const companies = new Map(((locs ?? []) as Array<{ id: string; name: string; is_active: boolean }>).map((l) => [l.id, l]));
  if (companies.size === 0) return [];

  const fetchRows = async (): Promise<AliasRow[]> => {
    const { data, error } = await admin.schema('core').from('inbound_aliases').select(ALIAS_COLS)
      .eq('org_id', orgId).in('location_id', Array.from(companies.keys()));
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as AliasRow[];
  };
  let rows = await fetchRows();
  const have = new Map<string, number>();
  for (const r of rows) have.set(r.location_id, (have.get(r.location_id) ?? 0) + 1);
  const missing = Array.from(companies.keys()).filter((id) => (have.get(id) ?? 0) < 2);
  if (missing.length) {
    for (const id of missing) await admin.schema('core').rpc('ensure_inbound_aliases', { p_location: id });
    rows = await fetchRows();
  }
  const order = (r: AliasRow) => `${companies.get(r.location_id)?.name ?? ''}\u0000${r.purpose === 'ap' ? 0 : 1}`;
  return rows.sort((a, b) => order(a).localeCompare(order(b))).map((r) => toAliasView(r, companies.get(r.location_id), cfg));
}

export async function getAlias(admin: SupabaseClient, orgId: string, aliasId: string): Promise<AliasRow | null> {
  const { data, error } = await admin.schema('core').from('inbound_aliases').select(ALIAS_COLS).eq('org_id', orgId).eq('id', aliasId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as AliasRow | null) ?? null;
}

export interface AliasPatch {
  is_active?: boolean;
  sender_rule?: SenderRule;
  allowed_domains?: string[];
  allowed_senders?: string[];
  /** Clear the captured Gmail forwarding confirmation. */
  dismiss_forwarding?: boolean;
  /** Append one sender to allowed_senders (from the log's "Allow this sender"). */
  allow_sender?: string;
}

/** Apply a patch to one alias in `orgId` (service role, org pinned). Returns the new row. */
export async function updateAlias(
  admin: SupabaseClient,
  orgId: string,
  aliasId: string,
  patch: AliasPatch,
  actor: string,
): Promise<AliasRow | null> {
  const current = await getAlias(admin, orgId, aliasId);
  if (!current) return null;
  const next: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: actor };
  if (patch.is_active !== undefined) next.is_active = patch.is_active;
  if (patch.sender_rule !== undefined) next.sender_rule = patch.sender_rule;
  if (patch.allowed_domains !== undefined) next.allowed_domains = Array.from(new Set(patch.allowed_domains));
  if (patch.allowed_senders !== undefined) next.allowed_senders = Array.from(new Set(patch.allowed_senders.map(normalizeAddress).filter(Boolean)));
  if (patch.allow_sender) {
    const s = normalizeAddress(patch.allow_sender);
    const base = (next.allowed_senders as string[] | undefined) ?? current.allowed_senders ?? [];
    if (s) next.allowed_senders = Array.from(new Set([...base, s]));
  }
  if (patch.dismiss_forwarding) {
    Object.assign(next, { fwd_confirm_from: null, fwd_confirm_code: null, fwd_confirm_url: null, fwd_confirm_at: null, fwd_confirm_verified: null });
  }
  const { data, error } = await admin.schema('core').from('inbound_aliases').update(next).eq('org_id', orgId).eq('id', aliasId).select(ALIAS_COLS).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as AliasRow | null) ?? null;
}
