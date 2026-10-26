/**
 * "Match accounts" — run the cascade for a client against the firm's mapping memory,
 * store one row per source account, take a person's decisions (one, bulk "Accept all
 * Ready", a different target, "request an account"), and write every accepted answer
 * back into the firm's memory so the NEXT client gets it pre-filled.
 *
 * AI (optional, explicit): the existing CONVERSION_MAP gateway call proposes targets for
 * the accounts nothing else matched — names and numbers only, never a balance.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { PostingError, resolveRole, type AccountRoleKey } from '@/lib/posting/account-roles';
import { proposeMapping } from '@/lib/onboarding/mapping-ai';
import { runCascade, bandTotals, typeGuard, bandFor, type AiSuggestion } from '../mapping/cascade';
import { CROSSWALK_ROLES } from '../mapping/crosswalk';
import { FAMILY_LABEL, familyFor, recomputeRule, ruleKeysFor } from '../mapping/memory';
import { mergeSourceAccounts } from '../source-accounts';
import { inferAccountType } from '../recognize';
import type { MappingBand, MappingRuleRef, MappingTarget, MeritAccountType, StagedAccount, StagedTbLine, TypeGuard } from '../types';
import { plural } from '../format';
import { MigrationError } from './guard';
import { loadSources, loadStaged, logEvent, patchProject, type ProjectRow } from './store';

type DB = SupabaseClient;

export interface MappingRow {
  id: string;
  source_account_key: string;
  source_number: string | null;
  source_name: string;
  source_type: string | null;
  detail_type: string | null;
  balance_cents: number;
  target_account_id: string | null;
  proposal_source: string;
  rule_id: string | null;
  confidence: number;
  band: MappingBand;
  type_guard: TypeGuard;
  type_reason: string | null;
  conflict: boolean;
  reason: string | null;
  status: 'proposed' | 'accepted' | 'needs_account';
  decided_by: string | null;
  decided_at: string | null;
  /** Our reading of the source account's MeritBooks type (for the type guard on screen). */
  merit_type: MeritAccountType | null;
}

const MAP_COLS = 'id, source_account_key, source_number, source_name, source_type, detail_type, balance_cents, target_account_id, proposal_source, rule_id, confidence, band, type_guard, type_reason, conflict, reason, status, decided_by, decided_at';

export async function loadTargets(db: DB, orgId: string): Promise<MappingTarget[]> {
  const { data, error } = await db.from('accounts').select('id, account_number, name, account_type, is_active').eq('org_id', orgId).eq('is_active', true).order('account_number').limit(5000);
  if (error) throw new Error(`Could not load the chart of accounts: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; account_number: string; name: string; account_type: string | null }>).map((a) => ({ id: a.id, number: String(a.account_number), name: a.name, type: (a.account_type as MeritAccountType | null) ?? null }));
}

/** The firm's active mapping set for this client's ledger family (created on first use). */
export async function ensureMappingSet(db: DB, orgId: string, project: ProjectRow, userId: string): Promise<{ id: string; name: string; family: string }> {
  const sources = await loadSources(db, project.id);
  const ledger = sources.find((s) => s.role === 'ledger_source' && s.status !== 'archived');
  const family = familyFor(ledger?.system_id);
  const { data } = await db.from('mapping_sets').select('id, name, source_family').eq('org_id', orgId).eq('source_family', family).eq('status', 'active').maybeSingle();
  type SetRow = { id: string; name: string; source_family: string };
  let set: SetRow | null = (data as SetRow | null) ?? null;
  if (!set) {
    const name = `Firm standard · ${FAMILY_LABEL[family]}`;
    const { data: made, error } = await serviceWriter().from('mapping_sets').insert({ org_id: orgId, name, source_family: family, created_by: userId }).select('id, name, source_family').single();
    if (error) {
      // Lost a race to another client's first match — read the winner.
      const { data: again } = await serviceWriter().from('mapping_sets').select('id, name, source_family').eq('org_id', orgId).eq('source_family', family).eq('status', 'active').maybeSingle();
      if (!again) throw new Error(`Could not create the mapping set: ${error.message}`);
      set = again as SetRow;
    } else set = made as SetRow;
  }
  if (project.mapping_set_id !== set!.id) await patchProject(orgId, project.id, { mapping_set_id: set!.id });
  return { id: set!.id, name: set!.name, family: set!.source_family };
}

async function loadRules(db: DB, setId: string): Promise<MappingRuleRef[]> {
  const { data } = await db.from('mapping_rules').select('id, match_kind, match_value, target_account_id, evidence_count, conflict').eq('mapping_set_id', setId).limit(20000);
  return ((data ?? []) as Array<{ id: string; match_kind: 'exact_number' | 'normalized_name'; match_value: string; target_account_id: string; evidence_count: number; conflict: boolean }>).map((r) => ({
    id: r.id, matchKind: r.match_kind, matchValue: r.match_value, targetAccountId: r.target_account_id, evidenceCount: r.evidence_count, conflict: r.conflict,
  }));
}

async function roleTargets(db: DB, orgId: string, locationId: string, targets: MappingTarget[]): Promise<{ map: Map<string, string>; re: string | null }> {
  const byNumber = new Map(targets.map((t) => [t.number, t.id]));
  const map = new Map<string, string>();
  const roles: AccountRoleKey[] = [...CROSSWALK_ROLES, 'RETAINED_EARNINGS'];
  for (const role of roles) {
    try {
      const ref = await resolveRole(db, orgId, role, locationId);
      const id = byNumber.get(ref.account_number);
      if (id) map.set(role, id);
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
    }
  }
  return { map, re: map.get('RETAINED_EARNINGS') ?? null };
}

export async function loadMappings(db: DB, projectId: string): Promise<MappingRow[]> {
  const { data, error } = await db.from('client_mappings').select(MAP_COLS).eq('project_id', projectId).limit(20000);
  if (error) throw new Error(`Could not load the matches: ${error.message}`);
  return ((data ?? []) as unknown as MappingRow[]).map((m) => ({ ...m, balance_cents: Number(m.balance_cents ?? 0), confidence: Number(m.confidence ?? 0), merit_type: inferAccountType({ number: m.source_number, name: m.source_name, sourceType: m.source_type, detailType: m.detail_type }) })).sort((a, b) => Math.abs(b.balance_cents) - Math.abs(a.balance_cents) || a.source_account_key.localeCompare(b.source_account_key));
}

/** Run (or re-run) the cascade. A person's accepted answer always survives a re-run. */
export async function runMapping(db: DB, orgId: string, project: ProjectRow, userId: string, opts: { useAi?: boolean } = {}): Promise<{ proposed: number; aiUsed: boolean; aiError: string | null }> {
  const staged = await loadStaged(db, project.id, ['account', 'tb_line']);
  const accounts = mergeSourceAccounts(
    staged.filter((r) => r.entity === 'account').map((r) => r.payload as unknown as StagedAccount),
    staged.filter((r) => r.entity === 'tb_line').map((r) => r.payload as unknown as StagedTbLine),
  );
  if (accounts.length === 0) throw new MigrationError('Drop the trial balance (or the chart of accounts) first — there is nothing to match yet.', 409, 'NO_ACCOUNTS');
  const targets = await loadTargets(db, orgId);
  if (targets.length === 0) throw new MigrationError('The MeritBooks chart of accounts is empty. Set up the chart first.', 409, 'NO_CHART');
  const set = await ensureMappingSet(db, orgId, project, userId);
  const [rules, roles, existing] = await Promise.all([loadRules(db, set.id), roleTargets(db, orgId, project.location_id, targets), loadMappings(db, project.id)]);
  const sources = accounts.map((a) => ({ key: a.key, number: a.number, name: a.name, type: a.type, sourceType: a.sourceType, detailType: a.detailType, balanceCents: a.balanceCents }));

  let proposals = runCascade({ sources, targets, rules, roleTargets: roles.map, retainedEarningsTargetId: roles.re, chartStrategy: project.chart_strategy });
  let aiUsed = false;
  let aiError: string | null = null;
  if (opts.useAi) {
    const unmatched = proposals.filter((p) => p.source === 'unmapped').map((p) => sources.find((s) => s.key === p.key)!).filter(Boolean);
    if (unmatched.length > 0) {
      const res = await proposeMapping(createAdminSupabase(), {
        orgId,
        userId,
        apiKey: getAnthropicApiKey(),
        sourceAccounts: unmatched.map((s) => ({ sourceAccount: s.key, sourceName: s.name })),
        targets: targets.map((t) => ({ accountNumber: t.number, name: t.name, accountType: t.type })),
      });
      aiUsed = res.aiUsed;
      aiError = res.aiError;
      const byNum = new Map(targets.map((t) => [t.number, t.id]));
      const ai = new Map<string, AiSuggestion>();
      for (const [key, m] of Object.entries(res.mapping)) {
        if (m.source !== 'ai' || !m.targetAccountNumber) continue;
        const id = byNum.get(m.targetAccountNumber);
        if (id) ai.set(key, { targetAccountId: id, confidence: m.confidence ?? 0.6, reasoning: m.reasoning ?? null });
      }
      proposals = runCascade({ sources, targets, rules, roleTargets: roles.map, retainedEarningsTargetId: roles.re, chartStrategy: project.chart_strategy, ai });
    }
  }

  const prev = new Map(existing.map((m) => [m.source_account_key, m]));
  const srcByKey = new Map(accounts.map((a) => [a.key, a]));
  const now = new Date().toISOString();
  const rows = proposals.map((p) => {
    const a = srcByKey.get(p.key)!;
    const old = prev.get(p.key);
    const base = {
      org_id: orgId,
      location_id: project.location_id,
      project_id: project.id,
      source_account_key: p.key.slice(0, 200),
      source_number: a.number,
      source_name: a.name.slice(0, 300),
      source_type: a.sourceType,
      detail_type: a.detailType,
      balance_cents: a.balanceCents,
      updated_at: now,
    };
    if (old && old.status !== 'proposed') {
      // Keep the person's decision; refresh the balance and the guard against the kept target.
      return { ...base, target_account_id: old.target_account_id, proposal_source: old.proposal_source, rule_id: old.rule_id, confidence: old.confidence, band: old.band, type_guard: old.type_guard, type_reason: old.type_reason, conflict: old.conflict, reason: old.reason, status: old.status, decided_by: old.decided_by, decided_at: old.decided_at };
    }
    return { ...base, target_account_id: p.targetAccountId, proposal_source: p.source, rule_id: p.ruleId, confidence: p.confidence, band: p.band, type_guard: p.typeGuard, type_reason: null, conflict: p.conflict, reason: p.reason.slice(0, 1000), status: 'proposed', decided_by: null, decided_at: null };
  });
  const writer = serviceWriter();
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await writer.from('client_mappings').upsert(rows.slice(i, i + 500), { onConflict: 'project_id,source_account_key' });
    if (error) throw new Error(`Could not save the matches: ${error.message}`);
  }
  const keep = new Set(rows.map((r) => r.source_account_key));
  const stale = existing.filter((m) => !keep.has(m.source_account_key) && m.status === 'proposed').map((m) => m.id);
  if (stale.length > 0) await writer.from('client_mappings').delete().eq('org_id', orgId).in('id', stale);
  const totals = bandTotals(proposals.map((p) => ({ band: p.band, balanceCents: srcByKey.get(p.key)?.balanceCents ?? 0 })));
  await logEvent(orgId, project, 'mapping_proposed', `Matched ${plural(rows.length, 'account')}: ${totals.ready.count} Ready · ${totals.check.count} Check · ${totals.decide.count} Decide${aiUsed ? ' (AI helped on the rest)' : ''}`, { system: true, actor: userId });
  return { proposed: rows.length, aiUsed, aiError };
}

// ── Decisions ────────────────────────────────────────────────────────────────

export type MappingDecision =
  | { kind: 'accept'; keys: string[] }
  | { kind: 'accept_ready' }
  | { kind: 'set'; key: string; targetAccountId: string; reason: string | null }
  | { kind: 'request_account'; key: string; note: string | null }
  | { kind: 'reopen'; key: string };

/** Write the accepted answers into the firm's memory (rules + this client's evidence), then recompute each rule. */
async function remember(db: DB, orgId: string, project: ProjectRow, userId: string, accepted: ReadonlyArray<{ number: string | null; name: string; type: string | null; targetAccountId: string }>): Promise<void> {
  if (accepted.length === 0 || !project.mapping_set_id) return;
  const writer = serviceWriter();
  const now = new Date().toISOString();
  for (const a of accepted) {
    for (const k of ruleKeysFor({ number: a.number, name: a.name })) {
      const { data: ruleRow } = await writer
        .from('mapping_rules')
        .upsert(
          { org_id: orgId, mapping_set_id: project.mapping_set_id, match_kind: k.matchKind, match_value: k.matchValue, source_label: `${a.number ? `${a.number} ` : ''}${a.name}`.slice(0, 300), source_account_type: a.type, target_account_id: a.targetAccountId, evidence_count: 0, created_by: userId },
          { onConflict: 'mapping_set_id,match_kind,match_value', ignoreDuplicates: true },
        )
        .select('id');
      let ruleId = ((ruleRow ?? [])[0] as { id: string } | undefined)?.id;
      if (!ruleId) {
        const { data: r } = await writer.from('mapping_rules').select('id').eq('mapping_set_id', project.mapping_set_id).eq('match_kind', k.matchKind).eq('match_value', k.matchValue).maybeSingle();
        ruleId = (r as { id: string } | null)?.id;
      }
      if (!ruleId) continue;
      await writer.from('mapping_rule_evidence').upsert(
        { org_id: orgId, location_id: project.location_id, rule_id: ruleId, project_id: project.id, target_account_id: a.targetAccountId, decided_by: userId, decided_at: now },
        { onConflict: 'rule_id,location_id' },
      );
      const [{ data: ev }, { data: rule }] = await Promise.all([
        writer.from('mapping_rule_evidence').select('location_id, target_account_id, decided_at').eq('rule_id', ruleId),
        writer.from('mapping_rules').select('settled_by, target_account_id').eq('id', ruleId).single(),
      ]);
      const settled = (rule as { settled_by: string | null; target_account_id: string } | null)?.settled_by ? (rule as { target_account_id: string }).target_account_id : null;
      const st = recomputeRule(((ev ?? []) as Array<{ location_id: string; target_account_id: string; decided_at: string }>).map((e) => ({ locationId: e.location_id, targetAccountId: e.target_account_id, decidedAt: e.decided_at })), settled);
      // A settled rule stays settled: other clients' different answers no longer flag it.
      if (st) await writer.from('mapping_rules').update({ target_account_id: st.targetAccountId, evidence_count: st.evidenceCount, conflict: settled ? false : st.conflict, updated_at: now }).eq('id', ruleId);
    }
  }
}

export async function decideMapping(db: DB, orgId: string, project: ProjectRow, userId: string, d: MappingDecision): Promise<{ changed: number; message: string }> {
  const rows = await loadMappings(db, project.id);
  const byKey = new Map(rows.map((r) => [r.source_account_key, r]));
  const targets = await loadTargets(db, orgId);
  const tById = new Map(targets.map((t) => [t.id, t]));
  const writer = serviceWriter();
  const now = new Date().toISOString();
  const accepted: Array<{ number: string | null; name: string; type: string | null; targetAccountId: string }> = [];

  const srcType = (r: MappingRow) => r.merit_type;

  if (d.kind === 'accept' || d.kind === 'accept_ready') {
    const pick = d.kind === 'accept_ready' ? rows.filter((r) => r.status === 'proposed' && r.band === 'ready' && r.target_account_id) : d.keys.map((k) => byKey.get(k)).filter((r): r is MappingRow => !!r && !!r.target_account_id && r.status !== 'accepted');
    const blocked = pick.filter((r) => r.type_guard === 'block');
    if (blocked.length > 0) throw new MigrationError(`${plural(blocked.length, 'match')} cross account types (for example ${blocked[0].source_name}). Open each and give a reason.`, 422, 'TYPE_GUARD');
    for (let i = 0; i < pick.length; i += 200) {
      const ids = pick.slice(i, i + 200).map((r) => r.id);
      const { error } = await writer.from('client_mappings').update({ status: 'accepted', decided_by: userId, decided_at: now, updated_at: now }).eq('org_id', orgId).in('id', ids);
      if (error) throw new Error(`Could not accept: ${error.message}`);
    }
    for (const r of pick) accepted.push({ number: r.source_number, name: r.source_name, type: r.source_type, targetAccountId: r.target_account_id! });
    await remember(db, orgId, project, userId, accepted);
    await logEvent(orgId, project, 'mapping_decided', `Accepted ${plural(pick.length, 'match', 'matches')}${d.kind === 'accept_ready' ? ' (all Ready)' : ''}`, { actor: userId });
    return { changed: pick.length, message: `Accepted ${plural(pick.length, 'match', 'matches')}. Your team’s memory now proposes them on the next client.` };
  }

  const r = byKey.get(d.key);
  if (!r) throw new MigrationError('That account isn’t in this client’s chart.', 404, 'NOT_FOUND');

  if (d.kind === 'set') {
    const t = tById.get(d.targetAccountId);
    if (!t) throw new MigrationError('Pick an account from the MeritBooks chart.', 422, 'BAD_TARGET');
    const guard = typeGuard(srcType(r), t.type);
    const reason = (d.reason ?? '').trim();
    if (guard === 'block' && reason.length < 10) throw new MigrationError(`That moves a ${(r.source_type ?? 'source').toLowerCase()} account onto a ${(t.type ?? '').toLowerCase()} account. Give the reason in a sentence — it prints on the certificate.`, 422, 'TYPE_GUARD');
    const { error } = await writer
      .from('client_mappings')
      .update({ target_account_id: t.id, proposal_source: r.target_account_id === t.id ? r.proposal_source : 'human', confidence: 1, band: bandFor(1, guard), type_guard: guard, type_reason: guard === 'ok' ? null : reason || null, reason: r.target_account_id === t.id ? r.reason : 'Chosen by a person', status: 'accepted', decided_by: userId, decided_at: now, updated_at: now })
      .eq('org_id', orgId)
      .eq('id', r.id);
    if (error) throw new Error(`Could not save: ${error.message}`);
    await remember(db, orgId, project, userId, [{ number: r.source_number, name: r.source_name, type: r.source_type, targetAccountId: t.id }]);
    await logEvent(orgId, project, 'mapping_decided', `${r.source_name} → ${t.number} ${t.name}${reason ? ` (${reason})` : ''}`, { actor: userId });
    return { changed: 1, message: `${r.source_name} → ${t.number} ${t.name}` };
  }
  if (d.kind === 'request_account') {
    const { error } = await writer.from('client_mappings').update({ status: 'needs_account', reason: `Account requested${d.note ? `: ${d.note.slice(0, 300)}` : ''}`, decided_by: userId, decided_at: now, updated_at: now }).eq('org_id', orgId).eq('id', r.id);
    if (error) throw new Error(`Could not save: ${error.message}`);
    await logEvent(orgId, project, 'mapping_decided', `New account requested for ${r.source_name}`, { actor: userId });
    return { changed: 1, message: `Requested a new account for ${r.source_name}. The controller adds it on the chart of accounts; then match it here.` };
  }
  // reopen
  const { error } = await writer.from('client_mappings').update({ status: 'proposed', decided_by: null, decided_at: null, updated_at: now }).eq('org_id', orgId).eq('id', r.id);
  if (error) throw new Error(`Could not reopen: ${error.message}`);
  return { changed: 1, message: `${r.source_name} reopened.` };
}

// ── The firm's memory (library + settle) ─────────────────────────────────────

export interface RuleView {
  id: string;
  matchKind: string;
  matchValue: string;
  sourceLabel: string | null;
  target: { id: string; number: string; name: string } | null;
  evidenceCount: number;
  conflict: boolean;
  settledBy: string | null;
  /** Each visible client's answer (only clients in the caller's scope). */
  evidence: Array<{ locationId: string; clientName: string; target: { id: string; number: string; name: string } | null; decidedAt: string }>;
}

export async function loadRuleLibrary(db: DB, orgId: string, setId: string | null): Promise<{ sets: Array<{ id: string; name: string; family: string; rules: number; conflicts: number }>; rules: RuleView[]; targets: MappingTarget[] }> {
  const { data: sets } = await db.from('mapping_sets').select('id, name, source_family').eq('org_id', orgId).eq('status', 'active');
  const setRows = (sets ?? []) as Array<{ id: string; name: string; source_family: string }>;
  const chosen = setId ?? setRows[0]?.id ?? null;
  const targets = await loadTargets(db, orgId);
  const tById = new Map(targets.map((t) => [t.id, t]));
  const { data: allRules } = await db.from('mapping_rules').select('id, mapping_set_id, conflict').eq('org_id', orgId).limit(50000);
  const ruleStats = (allRules ?? []) as Array<{ mapping_set_id: string; conflict: boolean }>;
  const out = setRows.map((s) => ({ id: s.id, name: s.name, family: s.source_family, rules: ruleStats.filter((r) => r.mapping_set_id === s.id).length, conflicts: ruleStats.filter((r) => r.mapping_set_id === s.id && r.conflict).length }));
  if (!chosen) return { sets: out, rules: [], targets };
  const { data: rules } = await db.from('mapping_rules').select('id, match_kind, match_value, source_label, target_account_id, evidence_count, conflict, settled_by').eq('mapping_set_id', chosen).order('conflict', { ascending: false }).order('evidence_count', { ascending: false }).limit(2000);
  const ruleRows = (rules ?? []) as Array<{ id: string; match_kind: string; match_value: string; source_label: string | null; target_account_id: string; evidence_count: number; conflict: boolean; settled_by: string | null }>;
  const ids = ruleRows.map((r) => r.id);
  const evidence: Array<{ rule_id: string; location_id: string; target_account_id: string; decided_at: string }> = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data: ev } = await db.from('mapping_rule_evidence').select('rule_id, location_id, target_account_id, decided_at').in('rule_id', ids.slice(i, i + 200));
    evidence.push(...((ev ?? []) as typeof evidence));
  }
  const { data: locs } = await db.schema('core').from('locations').select('id, name').eq('org_id', orgId).limit(2000);
  const nameOf = new Map(((locs ?? []) as Array<{ id: string; name: string }>).map((l) => [l.id, l.name]));
  const ref = (id: string) => { const t = tById.get(id); return t ? { id: t.id, number: t.number, name: t.name } : null; };
  return {
    sets: out,
    targets,
    rules: ruleRows.map((r) => ({
      id: r.id,
      matchKind: r.match_kind,
      matchValue: r.match_value,
      sourceLabel: r.source_label,
      target: ref(r.target_account_id),
      evidenceCount: r.evidence_count,
      conflict: r.conflict,
      settledBy: r.settled_by,
      evidence: evidence.filter((e) => e.rule_id === r.id).map((e) => ({ locationId: e.location_id, clientName: nameOf.get(e.location_id) ?? 'A client', target: ref(e.target_account_id), decidedAt: e.decided_at })),
    })),
  };
}

/** The accounting manager settles a rule once for every client (chart_of_accounts:approve). */
export async function settleRule(db: DB, orgId: string, userId: string, ruleId: string, targetAccountId: string): Promise<void> {
  const targets = await loadTargets(db, orgId);
  if (!targets.some((t) => t.id === targetAccountId)) throw new MigrationError('Pick an account from the MeritBooks chart.', 422, 'BAD_TARGET');
  const { data: rule } = await db.from('mapping_rules').select('id').eq('org_id', orgId).eq('id', ruleId).maybeSingle();
  if (!rule) throw new MigrationError('That rule was not found.', 404, 'NOT_FOUND');
  const writer = serviceWriter();
  const { data: ev } = await writer.from('mapping_rule_evidence').select('location_id, target_account_id, decided_at').eq('rule_id', ruleId);
  const st = recomputeRule(((ev ?? []) as Array<{ location_id: string; target_account_id: string; decided_at: string }>).map((e) => ({ locationId: e.location_id, targetAccountId: e.target_account_id, decidedAt: e.decided_at })), targetAccountId);
  const now = new Date().toISOString();
  const { error } = await writer.from('mapping_rules').update({ target_account_id: targetAccountId, settled_by: userId, settled_at: now, evidence_count: st?.evidenceCount ?? 0, conflict: false, updated_at: now }).eq('org_id', orgId).eq('id', ruleId);
  if (error) throw new Error(`Could not settle the rule: ${error.message}`);
}

export { bandTotals };
