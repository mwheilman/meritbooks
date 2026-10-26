/**
 * Customers, vendors, items and classes/departments — "Already in Merit" matching and the
 * person's decisions, recorded on staged_records (match_status / matched_object_id). A
 * person's decision is never overwritten by a re-run. Nothing is created here: new records
 * are created when the open items load (through the existing AR / AP importers, which link
 * by name to the existing record a person chose).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { matchNamed, matchParties, type ExistingNamed, type ExistingParty, type MasterMatch } from '../masters';
import type { StagedDimension, StagedItem, StagedParty } from '../types';
import { plural } from '../format';
import { MigrationError } from './guard';
import { loadStaged, logEvent, type ProjectRow, type StagedRow } from './store';

import { tinFingerprint } from '@/lib/vendors/tin-fingerprint';

type DB = SupabaseClient;

export type MasterKind = 'customer' | 'vendor' | 'item' | 'dimension';

async function existingParties(db: DB, orgId: string, kind: 'customer' | 'vendor'): Promise<ExistingParty[]> {
  const table = kind === 'customer' ? 'customers' : 'vendors';
  const cols: string = kind === 'customer' ? 'id, name, display_name, email, phone, tax_id' : 'id, name, display_name, email, phone';
  const first = await db.schema('core').from(table).select(cols).eq('org_id', orgId).limit(20000);
  const res = first.error ? await db.schema('core').from(table).select('id, name, email, phone').eq('org_id', orgId).limit(20000) : first;
  return ((res.data ?? []) as unknown as Array<{ id: string; name: string; display_name?: string | null; email: string | null; phone: string | null; tax_id?: string | null }>).map((r) => ({
    // H2: compared by the same org-scoped fingerprint the staged rows carry; the plaintext stays here.
    id: r.id, name: r.name, displayName: r.display_name ?? null, email: r.email, phone: r.phone, taxIdHash: tinFingerprint(orgId, r.tax_id ?? null),
  }));
}

async function existingNamed(db: DB, orgId: string, kind: 'item' | 'dimension'): Promise<ExistingNamed[]> {
  if (kind === 'item') {
    const { data } = await db.from('items').select('id, name, code').eq('org_id', orgId).limit(20000);
    return ((data ?? []) as Array<{ id: string; name: string; code: string | null }>).map((r) => ({ id: r.id, name: r.name, code: r.code }));
  }
  const [{ data: d }, { data: c }] = await Promise.all([
    db.from('departments').select('id, name, code').eq('org_id', orgId).limit(5000),
    db.from('classes').select('id, name, code').eq('org_id', orgId).limit(5000),
  ]);
  return [...((d ?? []) as ExistingNamed[]), ...((c ?? []) as ExistingNamed[])];
}

/** Re-run matching for every undecided staged record of a kind. */
export async function runMasterMatching(db: DB, orgId: string, project: ProjectRow, kind: MasterKind): Promise<{ matched: number; proposed: number; fresh: number }> {
  const rows = await loadStaged(db, project.id, [kind]);
  const open = rows.filter((r) => !r.decision_by);
  let matches: MasterMatch[];
  if (kind === 'customer' || kind === 'vendor') {
    const existing = await existingParties(db, orgId, kind);
    matches = matchParties(open.map((r) => { const p = r.payload as unknown as StagedParty; return { stagedId: r.id, name: p.name, email: p.email ?? null, phone: p.phone ?? null, taxIdHash: p.taxIdHash ?? null, address: p.address ?? null }; }), existing);
  } else {
    const existing = await existingNamed(db, orgId, kind);
    matches = matchNamed(open.map((r) => { const p = r.payload as unknown as StagedItem | StagedDimension; return { stagedId: r.id, name: p.name, code: 'sku' in p ? p.sku ?? null : null }; }), existing);
  }
  const writer = serviceWriter();
  // Group identical updates to keep this to a handful of writes.
  const groups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();
  for (const m of matches) {
    const patch = { match_status: m.status, matched_object_id: m.matchedId, match_confidence: Math.round(m.confidence * 1000) / 1000, match_reason: m.reason.slice(0, 300) };
    const key = JSON.stringify(patch);
    const g = groups.get(key);
    if (g) g.ids.push(m.stagedId);
    else groups.set(key, { patch, ids: [m.stagedId] });
  }
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += 200) {
      const { error } = await writer.from('staged_records').update(g.patch).eq('org_id', orgId).in('id', g.ids.slice(i, i + 200));
      if (error) throw new Error(`Could not save the matches: ${error.message}`);
    }
  }
  return { matched: matches.filter((m) => m.status === 'matched').length, proposed: matches.filter((m) => m.status === 'merge_proposed').length, fresh: matches.filter((m) => m.status === 'new').length };
}

export interface MasterView {
  kind: MasterKind;
  total: number;
  matched: number;
  proposed: number;
  fresh: number;
  ignored: number;
  undecided: number;
  rows: Array<{ id: string; name: string; detail: string; status: StagedRow['match_status']; matchedId: string | null; matchedName: string | null; confidence: number | null; reason: string | null; decided: boolean }>;
}

export async function masterViews(db: DB, orgId: string, project: ProjectRow): Promise<MasterView[]> {
  const rows = await loadStaged(db, project.id, ['customer', 'vendor', 'item', 'dimension']);
  const out: MasterView[] = [];
  for (const kind of ['customer', 'vendor', 'item', 'dimension'] as const) {
    const mine = rows.filter((r) => r.entity === kind);
    if (mine.length === 0) continue;
    const ids = Array.from(new Set(mine.map((r) => r.matched_object_id).filter((x): x is string => !!x)));
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const lookups: Array<PromiseLike<{ data: unknown }>> =
        kind === 'customer' || kind === 'vendor'
          ? [db.schema('core').from(kind === 'customer' ? 'customers' : 'vendors').select('id, name').in('id', ids.slice(0, 500))]
          : kind === 'item'
            ? [db.from('items').select('id, name').in('id', ids.slice(0, 500))]
            : [db.from('departments').select('id, name').in('id', ids.slice(0, 500)), db.from('classes').select('id, name').in('id', ids.slice(0, 500))];
      for (const res of await Promise.all(lookups)) for (const r of ((res.data ?? []) as Array<{ id: string; name: string }>)) names.set(r.id, r.name);
    }
    const order: Record<StagedRow['match_status'], number> = { merge_proposed: 0, conflict: 0, new: 1, matched: 2, ignored: 3 };
    const sorted = [...mine].sort((a, b) => order[a.match_status] - order[b.match_status] || a.display_name.localeCompare(b.display_name));
    out.push({
      kind,
      total: mine.length,
      matched: mine.filter((r) => r.match_status === 'matched').length,
      proposed: mine.filter((r) => r.match_status === 'merge_proposed').length,
      fresh: mine.filter((r) => r.match_status === 'new').length,
      ignored: mine.filter((r) => r.match_status === 'ignored').length,
      undecided: mine.filter((r) => r.match_status === 'merge_proposed' && !r.decision_by).length,
      rows: sorted.slice(0, 400).map((r) => {
        const p = r.payload as Record<string, unknown>;
        const detail = [p.email, p.phone, p.kind, p.sku].filter((x) => typeof x === 'string' && x).join(' · ');
        return { id: r.id, name: r.display_name, detail, status: r.match_status, matchedId: r.matched_object_id, matchedName: r.matched_object_id ? names.get(r.matched_object_id) ?? null : null, confidence: r.match_confidence, reason: r.match_reason, decided: !!r.decision_by };
      }),
    });
  }
  return out;
}

export type MasterDecision =
  | { kind: 'link'; stagedIds: string[] }
  | { kind: 'keep_new'; stagedIds: string[] }
  | { kind: 'ignore'; stagedIds: string[] }
  | { kind: 'accept_all_matches'; entity: MasterKind };

export async function decideMasters(db: DB, orgId: string, project: ProjectRow, userId: string, d: MasterDecision): Promise<{ changed: number }> {
  const rows = await loadStaged(db, project.id, ['customer', 'vendor', 'item', 'dimension']);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const now = new Date().toISOString();
  const writer = serviceWriter();
  let targets: StagedRow[];
  let patch: Record<string, unknown>;
  if (d.kind === 'accept_all_matches') {
    targets = rows.filter((r) => r.entity === d.entity && r.match_status === 'merge_proposed' && r.matched_object_id && !r.decision_by);
    patch = { match_status: 'matched', decision_by: userId, decision_at: now };
  } else {
    targets = d.stagedIds.map((id) => byId.get(id)).filter((r): r is StagedRow => !!r);
    if (targets.length !== d.stagedIds.length) throw new MigrationError('Some of those rows aren’t in this client’s staged data.', 404, 'NOT_FOUND');
    if (d.kind === 'link') {
      const bad = targets.find((r) => !r.matched_object_id);
      if (bad) throw new MigrationError(`${bad.display_name} has no existing record to link to — keep it as new, or ignore it as a duplicate.`, 422, 'NO_MATCH');
      patch = { match_status: 'matched', decision_by: userId, decision_at: now };
    } else if (d.kind === 'keep_new') {
      patch = { match_status: 'new', matched_object_id: null, decision_by: userId, decision_at: now, match_reason: 'Kept as a separate record by a person' };
    } else {
      patch = { match_status: 'ignored', decision_by: userId, decision_at: now, match_reason: 'Ignored — a duplicate within the file' };
    }
  }
  const ids = targets.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await writer.from('staged_records').update(patch).eq('org_id', orgId).eq('project_id', project.id).in('id', ids.slice(i, i + 200));
    if (error) throw new Error(`Could not save: ${error.message}`);
  }
  const verb = d.kind === 'link' || d.kind === 'accept_all_matches' ? 'linked to existing records' : d.kind === 'keep_new' ? 'kept as new' : 'ignored as duplicates';
  if (ids.length > 0) await logEvent(orgId, project, 'master_decided', `${plural(ids.length, 'record')} ${verb}`, { actor: userId });
  return { changed: ids.length };
}
