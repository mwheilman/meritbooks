/**
 * Master data matching for a migration (spec §9.3) — customers, vendors, items and
 * dimensions (classes / departments). Deterministic keys first; nothing is ever created
 * twice and nothing is merged across clients or kinds.
 *
 *   Customer / vendor    tax id (org-scoped keyed fingerprint — never the id itself,
 *                        security review H2) → normalized name + email / phone → name similarity
 *                        Uses Books' duplicate curve (lib/customers/dedupe.ts
 *                        scoreCustomerDuplicates) — the same curve the shared-records
 *                        matcher (migration 1111, core.match_parties) mirrors exactly, so
 *                        "Already in Merit" here agrees with the create screens.
 *   Item / dimension     code → normalized name.
 *
 *   ≥ 0.97  auto-link ("Already in Merit")      matched
 *   0.75–0.96 side-by-side proposal              merge_proposed
 *   below                                        new (created on load)
 *
 * Duplicates INSIDE the dropped file are proposed against their first occurrence
 * ("Same as … in this file") so the person merges them once. PURE.
 */

import { scoreCustomerDuplicates, type CustomerDupInput } from '@/lib/customers/dedupe';
import { normalizePartyName } from './recognize';

export const AUTO_LINK_AT = 0.97;
export const PROPOSE_AT = 0.75;

export interface ExistingParty {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  /** Keyed fingerprint of the tax id (lib/vendors/tin-fingerprint.ts), never the id. */
  taxIdHash: string | null;
}

export interface StagedPartyRef {
  stagedId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Keyed fingerprint of the tax id, never the id. */
  taxIdHash: string | null;
  address: string | null;
}

export type MasterStatus = 'matched' | 'merge_proposed' | 'new';

export interface MasterMatch {
  stagedId: string;
  status: MasterStatus;
  matchedId: string | null;
  matchedName: string | null;
  confidence: number;
  reason: string;
  /** Another staged row in the same file this one duplicates. */
  duplicateOfStagedId: string | null;
}

function toDup(id: string, p: { name: string; displayName?: string | null; email: string | null; phone: string | null; address?: string | null }): CustomerDupInput {
  return {
    id,
    name: p.name,
    displayName: p.displayName ?? null,
    email: p.email,
    phone: p.phone,
    // The tax-id signal is the exact fingerprint compare in scorePair (the curve never sees an id).
    taxId: null,
    addressLine1: p.address ?? null,
    zip: null,
    openArCents: 0,
  };
}

const sameEmail = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '').slice(-10);
const samePhone = (a: string | null, b: string | null) => digits(a).length >= 7 && digits(a) === digits(b);
const taxKey = (s: string | null) => (s ?? '').trim();

/** Score a staged party against an existing master (0..1, null = no signal). */
export function scorePair(s: StagedPartyRef, e: ExistingParty): { confidence: number; reason: string } | null {
  const tS = taxKey(s.taxIdHash);
  const tE = taxKey(e.taxIdHash);
  if (tS.length >= 4 && tS === tE) return { confidence: 0.99, reason: 'Same tax ID' };
  const nS = normalizePartyName(s.name);
  const sameName = nS.length > 0 && [e.name, e.displayName].some((n) => !!n && normalizePartyName(n) === nS);
  if (sameName && (sameEmail(s.email, e.email) || samePhone(s.phone, e.phone))) {
    return { confidence: 0.98, reason: sameEmail(s.email, e.email) ? 'Same name and email' : 'Same name and phone' };
  }
  const sig = scoreCustomerDuplicates(toDup(`s:${s.stagedId}`, s), toDup(`e:${e.id}`, e));
  if (sameName) return { confidence: Math.max(0.92, sig?.confidence ?? 0), reason: 'Same name' };
  if (!sig) return null;
  return { confidence: Math.min(0.96, sig.confidence), reason: sig.reason };
}

/** Match every staged customer (or vendor) to existing masters and to each other. */
export function matchParties(staged: ReadonlyArray<StagedPartyRef>, existing: ReadonlyArray<ExistingParty>): MasterMatch[] {
  // Index existing by normalized name / email / phone / tax id for a cheap candidate pass.
  const byName = new Map<string, ExistingParty[]>();
  const byEmail = new Map<string, ExistingParty[]>();
  const byPhone = new Map<string, ExistingParty[]>();
  const byTax = new Map<string, ExistingParty[]>();
  const push = (m: Map<string, ExistingParty[]>, k: string, e: ExistingParty) => {
    if (!k) return;
    const l = m.get(k);
    if (l) l.push(e);
    else m.set(k, [e]);
  };
  const tokens = new Map<string, ExistingParty[]>();
  for (const e of existing) {
    for (const n of [e.name, e.displayName]) if (n) push(byName, normalizePartyName(n), e);
    push(byEmail, (e.email ?? '').trim().toLowerCase(), e);
    if (digits(e.phone).length >= 7) push(byPhone, digits(e.phone), e);
    if (taxKey(e.taxIdHash).length >= 4) push(byTax, taxKey(e.taxIdHash), e);
    const first = normalizePartyName(e.name).split(' ')[0] ?? '';
    if (first.length >= 3) push(tokens, first, e);
  }

  const seen = new Map<string, string>(); // in-file key → first staged id
  const out: MasterMatch[] = [];
  for (const s of staged) {
    const nS = normalizePartyName(s.name);
    const keys = [
      nS ? `n:${nS}` : '',
      s.email ? `e:${s.email.trim().toLowerCase()}` : '',
      digits(s.phone).length >= 7 ? `p:${digits(s.phone)}` : '',
      taxKey(s.taxIdHash).length >= 4 ? `t:${taxKey(s.taxIdHash)}` : '',
    ].filter(Boolean);
    const dupOf = keys.map((k) => seen.get(k)).find((v): v is string => !!v) ?? null;
    for (const k of keys) if (!seen.has(k)) seen.set(k, s.stagedId);

    const cands = new Set<ExistingParty>([
      ...(byName.get(nS) ?? []),
      ...(byEmail.get((s.email ?? '').trim().toLowerCase()) ?? []),
      ...(byPhone.get(digits(s.phone)) ?? []),
      ...(byTax.get(taxKey(s.taxIdHash)) ?? []),
      ...(tokens.get(nS.split(' ')[0] ?? '') ?? []),
    ]);
    let best: { e: ExistingParty; confidence: number; reason: string } | null = null;
    for (const e of cands) {
      const sc = scorePair(s, e);
      if (sc && (!best || sc.confidence > best.confidence)) best = { e, ...sc };
    }

    if (best && best.confidence >= AUTO_LINK_AT) {
      out.push({ stagedId: s.stagedId, status: 'matched', matchedId: best.e.id, matchedName: best.e.name, confidence: best.confidence, reason: `Already in Merit · ${best.reason}`, duplicateOfStagedId: dupOf });
    } else if (best && best.confidence >= PROPOSE_AT) {
      out.push({ stagedId: s.stagedId, status: 'merge_proposed', matchedId: best.e.id, matchedName: best.e.name, confidence: best.confidence, reason: `Looks like ${best.e.name} · ${best.reason}`, duplicateOfStagedId: dupOf });
    } else if (dupOf) {
      out.push({ stagedId: s.stagedId, status: 'merge_proposed', matchedId: null, matchedName: null, confidence: 0.9, reason: 'Same as another row in this file', duplicateOfStagedId: dupOf });
    } else {
      out.push({ stagedId: s.stagedId, status: 'new', matchedId: null, matchedName: null, confidence: 0, reason: 'New — not in Merit yet', duplicateOfStagedId: null });
    }
  }
  return out;
}

export interface ExistingNamed {
  id: string;
  name: string;
  code: string | null;
}

/** Items / classes / departments: code first, then normalized name. */
export function matchNamed(
  staged: ReadonlyArray<{ stagedId: string; name: string; code: string | null }>,
  existing: ReadonlyArray<ExistingNamed>,
): MasterMatch[] {
  const byCode = new Map<string, ExistingNamed>();
  const byName = new Map<string, ExistingNamed>();
  for (const e of existing) {
    if (e.code) byCode.set(e.code.trim().toLowerCase(), e);
    byName.set(normalizePartyName(e.name), e);
  }
  const seen = new Map<string, string>();
  return staged.map((s) => {
    const k = normalizePartyName(s.name);
    const dupOf = seen.get(k) ?? null;
    if (!seen.has(k)) seen.set(k, s.stagedId);
    const code = s.code?.trim().toLowerCase();
    const hit = (code ? byCode.get(code) : undefined) ?? byName.get(k);
    if (hit) {
      const viaCode = !!code && byCode.get(code) === hit;
      return { stagedId: s.stagedId, status: 'matched' as const, matchedId: hit.id, matchedName: hit.name, confidence: viaCode ? 0.99 : 0.97, reason: `Already in Merit · same ${viaCode ? 'code' : 'name'}`, duplicateOfStagedId: dupOf };
    }
    if (dupOf) return { stagedId: s.stagedId, status: 'merge_proposed' as const, matchedId: null, matchedName: null, confidence: 0.9, reason: 'Same as another row in this file', duplicateOfStagedId: dupOf };
    return { stagedId: s.stagedId, status: 'new' as const, matchedId: null, matchedName: null, confidence: 0, reason: 'New — not in Merit yet', duplicateOfStagedId: null };
  });
}
