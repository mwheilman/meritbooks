/**
 * The vendor portal's view model (FPB §5.3 / §19.2): what this vendor is asked for, why,
 * where each item stands, and what the last check said. Built on the SERVICE role from a
 * validated token — org + vendor come from the token row, never from the visitor — and it
 * returns only this vendor's own facts plus the asking company's display name.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PortalDocKind } from '@/lib/portal/vendor/tokens';
import { dollars, type RequirementSet, type RuleResult } from './requirements';
import { requirementSetForVendor, SUBMISSION_COLUMNS, type SubmissionRow } from './review';
import { loadVendorFacts } from './store';

type DB = SupabaseClient;

export type PortalItemState = 'needed' | 'received' | 'checked' | 'accepted' | 'rejected' | 'on_file';

export interface PortalCheck {
  label: string;
  word: 'Meets' | "Doesn't meet" | 'Expiring soon' | 'Waiting for review';
  reason: string;
}

export interface PortalItem {
  kind: PortalDocKind;
  label: string;
  why: string;
  /** The requirement in plain words (COI limits, endorsements, holder). */
  asks: string[];
  state: PortalItemState;
  /** What happened last, for the vendor. */
  status: string | null;
  checks: PortalCheck[];
  rejectedReason: string | null;
  submittedAt: string | null;
  /** The vendor may fill the W-9 here. */
  fillHere: boolean;
}

export interface PortalView {
  companyName: string;
  vendorName: string;
  items: PortalItem[];
  renewalDate: string | null;
  allDone: boolean;
}

export function describeCoiAsks(set: RequirementSet | null): string[] {
  if (!set) return ['A current certificate of insurance showing general liability.'];
  const out: string[] = [];
  const gl = [set.minGlEachOccurrenceCents !== null ? `${dollars(set.minGlEachOccurrenceCents)} each occurrence` : null, set.minGlAggregateCents !== null ? `${dollars(set.minGlAggregateCents)} aggregate` : null].filter(Boolean);
  if (set.coiRequired || gl.length) out.push(`General liability${gl.length ? `: ${gl.join(', ')}` : ''}.`);
  if (set.minAutoCents !== null) out.push(`Auto liability: ${dollars(set.minAutoCents)} combined single limit.`);
  if (set.wcRequired || set.minWcEachAccidentCents !== null) {
    out.push(`Workers' compensation${set.minWcEachAccidentCents !== null ? ` with employer's liability ${dollars(set.minWcEachAccidentCents)} each accident` : ''} (or a state exemption certificate).`);
  }
  if (set.minUmbrellaCents !== null) out.push(`Umbrella / excess: ${dollars(set.minUmbrellaCents)}.`);
  if (set.requireAdditionalInsured) out.push('The certificate holder named as additional insured.');
  if (set.requireWaiverOfSubrogation) out.push('A waiver of subrogation.');
  for (const h of set.certificateHolderNames) out.push(`Certificate holder: ${h}.`);
  return out;
}

const word = (r: RuleResult): PortalCheck['word'] =>
  r.outcome === 'met' ? 'Meets' : r.outcome === 'expiring' || r.outcome === 'grace' ? 'Expiring soon' : r.outcome === 'pending' ? 'Waiting for review' : "Doesn't meet";

/** Pure: one portal item from the latest submission + what's on file. */
export function portalItem(kind: PortalDocKind, latest: SubmissionRow | null, onFile: boolean, set: RequirementSet | null, companyName: string): PortalItem {
  const label = kind === 'W9' ? 'Form W-9' : kind === 'COI' ? 'Certificate of insurance' : 'Banking details';
  const holds = set?.blockPayment ?? true;
  const why =
    kind === 'W9'
      ? `${companyName} needs your W-9 for its tax filings${holds ? ' and before your next payment' : ''}.`
      : kind === 'COI'
        ? `${companyName} needs proof of insurance${holds ? ' before your next payment' : ''}.`
        : `If your banking changed, send a voided check or bank letter. ${companyName} will call you at a number they already have before paying to new details.`;
  const asks = kind === 'COI' ? describeCoiAsks(set) : kind === 'W9' ? ['Your legal name, tax classification, address and taxpayer ID, signed.'] : [];
  const base: PortalItem = { kind, label, why, asks, state: onFile ? 'on_file' : 'needed', status: onFile ? 'We have a current one on file. Send a new one only if it changed.' : null, checks: [], rejectedReason: null, submittedAt: null, fillHere: kind === 'W9' };
  if (!latest || kind === 'BANKING') return base;
  const checks = (latest.rule_results ?? []).map((r) => ({ label: r.label, word: word(r), reason: r.reason }));
  if (latest.status === 'accepted') return { ...base, state: 'accepted', status: `Accepted on ${(latest.reviewed_at ?? latest.updated_at).slice(0, 10)}. Thank you.`, checks, submittedAt: latest.created_at };
  if (latest.status === 'rejected') return { ...base, state: 'rejected', status: 'We could not accept the last one you sent.', checks, rejectedReason: latest.decision_reason, submittedAt: latest.created_at };
  if (latest.status === 'ai_checked') {
    const fails = checks.filter((c) => c.word === "Doesn't meet").length;
    return {
      ...base,
      state: 'checked',
      status: fails
        ? `We read it and ${fails === 1 ? 'one thing does not' : `${fails} things do not`} match what ${companyName} needs. A person will confirm; you can send a corrected one now.`
        : `We read it and it looks right. A person at ${companyName} confirms it next — usually within a business day.`,
      checks,
      submittedAt: latest.created_at,
    };
  }
  if (latest.status === 'received') {
    return {
      ...base,
      state: 'received',
      status: latest.ai_status === 'unavailable' || latest.ai_status === 'failed' || latest.ai_status === 'skipped'
        ? `We received it. A person at ${companyName} will check it.`
        : 'We received it and are reading it now.',
      checks,
      submittedAt: latest.created_at,
    };
  }
  return base;
}

export async function buildPortalView(admin: DB, token: { orgId: string; vendorId: string; requestedDocs: PortalDocKind[] }, now: Date = new Date()): Promise<PortalView> {
  const today = now.toISOString().slice(0, 10);
  const [{ data: org }, { data: vendor }, { data: subs }, set, { facts }] = await Promise.all([
    admin.schema('core').from('organizations').select('name').eq('id', token.orgId).maybeSingle(),
    admin.schema('core').from('vendors').select('name, display_name').eq('org_id', token.orgId).eq('id', token.vendorId).maybeSingle(),
    admin.from('vendor_document_submissions').select(SUBMISSION_COLUMNS).eq('org_id', token.orgId).eq('vendor_id', token.vendorId).neq('status', 'superseded').order('created_at', { ascending: false }).limit(20),
    requirementSetForVendor(admin, token.orgId, token.vendorId).catch(() => null),
    loadVendorFacts(admin, token.orgId, [token.vendorId], today),
  ]);
  const companyName = ((org as { name?: string } | null)?.name ?? '').trim() || 'Your customer';
  const v = vendor as { name?: string; display_name?: string | null } | null;
  const vendorName = (v?.display_name || v?.name || '').trim();
  const rows = (subs ?? []) as SubmissionRow[];
  const f = facts.get(token.vendorId);
  const items = token.requestedDocs.map((k) => {
    const latest = k === 'BANKING' ? null : rows.find((s) => s.doc_kind === k) ?? null;
    const onFile = k === 'W9' ? f?.w9.status === 'valid' : k === 'COI' ? (f?.coverages ?? []).some((c) => c.coverageType === 'GENERAL_LIABILITY' && (!c.expirationDate || c.expirationDate >= today)) : false;
    return portalItem(k, latest, !!onFile, set, companyName);
  });
  const renewal = (f?.coverages ?? []).map((c) => c.expirationDate).filter((d): d is string => !!d && d >= today).sort()[0] ?? null;
  return { companyName, vendorName, items, renewalDate: renewal, allDone: items.filter((i) => i.kind !== 'BANKING').every((i) => i.state === 'accepted' || i.state === 'on_file') };
}
