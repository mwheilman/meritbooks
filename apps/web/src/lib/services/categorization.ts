/**
 * AI transaction categorization (GATE 3) — the inbound auto-coding brain.
 *
 * Given a transaction description + amount, proposes a REAL GL account (plus a
 * likely vendor and department) from the tenant's own data, with a confidence
 * score and reasoning. Routed through the Core AI gateway (metered, budget-
 * capped) and recorded in the AI decision log. Platform-generic — no industry
 * assumptions baked in.
 *
 * Tier 1 (free, deterministic): vendor-pattern match on prior coding.
 * Tier 2 (gateway AI): when no confident pattern exists.
 *
 * Note: the vendor-pattern *learning loop* (writing confirmed codings back to
 * vendor_patterns) is intentionally not wired here — that table predates the
 * core-schema carve and needs a migration to the core model first.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const CATEGORIZE_MODEL = 'claude-sonnet-4-20250514';
export const CATEGORIZE_FEATURE = 'CATEGORIZATION';

export interface CategorySuggestion {
  accountId: string | null;
  accountNumber: string | null;
  accountName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  confidence: number;
  reasoning: string;
  source: 'pattern' | 'ai';
  decisionId: string | null;
}

interface CoaRow { id: string; account_number: string; name: string; account_type: string; account_sub_type: string }

/** Tier 1: match against prior vendor-coding patterns. Defensive — never throws. */
export async function matchVendorPattern(
  supabase: SupabaseClient,
  description: string,
  orgId: string,
): Promise<{ accountId: string; vendorId: string | null; departmentId: string | null; confidence: number; raw: string } | null> {
  try {
    const { data: patterns, error } = await supabase
      .from('vendor_patterns')
      .select('vendor_id, account_id, department_id, normalized_description, raw_description, match_count')
      .eq('org_id', orgId)
      .order('match_count', { ascending: false })
      .limit(100);
    if (error || !patterns?.length) return null;

    const normalized = description.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    let best: (typeof patterns)[number] | null = null;
    let bestScore = 0;
    for (const p of patterns) {
      const pn = String(p.normalized_description ?? '').toLowerCase();
      if (!pn) continue;
      if (normalized.includes(pn) || pn.includes(normalized)) {
        const score = Math.min(pn.length, normalized.length) / Math.max(pn.length, normalized.length);
        if (score > bestScore) { bestScore = score; best = p; }
      }
    }
    if (best && bestScore > 0.6) {
      return {
        accountId: best.account_id as string,
        vendorId: (best.vendor_id as string) ?? null,
        departmentId: (best.department_id as string) ?? null,
        confidence: Math.min(bestScore * 1.1, 0.99),
        raw: String(best.raw_description ?? ''),
      };
    }
  } catch {
    // Stale/absent vendor_patterns table — skip tier 1 silently.
  }
  return null;
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Suggest a category for a transaction. Tier 1 pattern first; if not confident,
 * Tier 2 gateway AI. Writes an ai_decisions record for AI suggestions.
 */
export async function suggestCategory(
  supabase: SupabaseClient,
  anthropicApiKey: string,
  args: { orgId: string; description: string; amountCents: number; locationId: string | null },
): Promise<{ ok: true; suggestion: CategorySuggestion } | { ok: false; error: string; budgetBlocked?: boolean }> {
  const { orgId, description, amountCents, locationId } = args;
  if (!description.trim()) return { ok: false, error: 'Description is empty' };

  // Pull tenant data once (used for mapping + the AI prompt).
  const [{ data: coa }, { data: vendors }, { data: depts }] = await Promise.all([
    supabase.from('accounts').select('id, account_number, name, account_type, account_sub_type')
      .eq('org_id', orgId).eq('is_active', true).eq('approval_status', 'APPROVED').order('account_number'),
    supabase.schema('core').from('vendors').select('id, name').eq('org_id', orgId).limit(500),
    supabase.schema('core').from('departments').select('id, name').eq('org_id', orgId).limit(500),
  ]);

  const accounts = (coa ?? []) as CoaRow[];
  if (accounts.length === 0) return { ok: false, error: 'No approved chart of accounts — seed the COA first' };
  const acctByNumber = new Map(accounts.map((a) => [a.account_number, a]));
  const vendorList = (vendors ?? []) as Array<{ id: string; name: string }>;
  const deptList = (depts ?? []) as Array<{ id: string; name: string }>;
  const vendorByName = new Map(vendorList.map((v) => [v.name.toLowerCase(), v]));
  const deptByName = new Map(deptList.map((d) => [d.name.toLowerCase(), d]));

  // Tier 1: confident pattern match short-circuits the AI.
  const pat = await matchVendorPattern(supabase, description, orgId);
  if (pat && pat.confidence >= 0.85) {
    const a = accounts.find((x) => x.id === pat.accountId);
    return {
      ok: true,
      suggestion: {
        accountId: pat.accountId,
        accountNumber: a?.account_number ?? null,
        accountName: a?.name ?? null,
        vendorId: pat.vendorId,
        vendorName: vendorList.find((v) => v.id === pat.vendorId)?.name ?? null,
        departmentId: pat.departmentId,
        departmentName: deptList.find((d) => d.id === pat.departmentId)?.name ?? null,
        confidence: pat.confidence,
        reasoning: `Matched a prior coding pattern: "${pat.raw}".`,
        source: 'pattern',
        decisionId: null,
      },
    };
  }

  // Tier 2: gateway AI.
  const coaText = accounts.map((a) => `${a.account_number}\t${a.name}\t(${a.account_type}/${a.account_sub_type})`).join('\n');
  const vendText = vendorList.length ? vendorList.map((v) => v.name).join(', ') : '(none on file)';
  const deptText = deptList.length ? deptList.map((d) => d.name).join(', ') : '(none on file)';
  const prompt = `You are an accountant coding an incoming transaction to the general ledger. Choose the single most appropriate account from the chart below, and (if clearly identifiable) the vendor and department.

TRANSACTION:
  Description: """${description}"""
  Amount: $${(amountCents / 100).toFixed(2)}

CHART OF ACCOUNTS (account_number<TAB>name<TAB>(type/sub_type)):
${coaText}

KNOWN VENDORS: ${vendText}
DEPARTMENTS: ${deptText}

RULES:
- Pick the expense/COGS/asset account that best fits the transaction's substance. Use ONLY an account_number from the chart.
- vendor_name: copy an exact name from KNOWN VENDORS if the description clearly matches one, else null.
- department_name: copy an exact name from DEPARTMENTS if clearly implied, else null.
- confidence: 0.0–1.0, honest. Lower it when the description is vague.
- This is advisory; a human will confirm. Explain briefly in "reasoning".

Respond with ONLY this JSON, no markdown:
{"account_number":"...","vendor_name":null,"department_name":null,"confidence":0.0,"reasoning":"..."}`;

  let gw;
  try {
    gw = await runAiGateway(
      { supabase, anthropicApiKey },
      { tenant_id: orgId, user_id: null, module: 'BOOKS', feature: CATEGORIZE_FEATURE, model: CATEGORIZE_MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], max_tokens: 600 },
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gateway error' };
  }
  if (gw.status === 'blocked' || gw.result == null) return { ok: false, error: gw.message ?? 'AI request blocked', budgetBlocked: gw.status === 'blocked' };

  const text = extractText(gw.result);
  if (!text) return { ok: false, error: 'Empty AI response' };

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()); }
  catch { return { ok: false, error: 'Could not parse the AI response' }; }

  const acctNum = String(parsed.account_number ?? '');
  const acct = acctByNumber.get(acctNum) ?? null;
  const vName = parsed.vendor_name ? String(parsed.vendor_name) : null;
  const dName = parsed.department_name ? String(parsed.department_name) : null;
  const vendor = vName ? vendorByName.get(vName.toLowerCase()) ?? null : null;
  const dept = dName ? deptByName.get(dName.toLowerCase()) ?? null : null;
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0)));
  const reasoning = String(parsed.reasoning ?? '');

  // Decision log.
  let decisionId: string | null = null;
  try {
    const { data } = await supabase.from('ai_decisions').insert({
      org_id: orgId, location_id: locationId, feature: CATEGORIZE_FEATURE,
      model_requested: CATEGORIZE_MODEL, model_used: gw.model_used, correlation_id: gw.correlation_id,
      input_summary: `${description} ($${(amountCents / 100).toFixed(2)})`.slice(0, 2000),
      proposed_output: {
        account_number: acctNum, account_name: acct?.name ?? null, account_id: acct?.id ?? null,
        vendor_name: vName, vendor_id: vendor?.id ?? null, department_name: dName, department_id: dept?.id ?? null,
        amount_cents: amountCents, accountResolved: !!acct,
      },
      confidence, reasoning, status: 'PROPOSED',
      tokens_input: gw.tokens.input, tokens_output: gw.tokens.output, cost_cents: gw.cost_cents,
    }).select('id').single();
    decisionId = (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[categorize] decision log failed (non-fatal):', e);
  }

  return {
    ok: true,
    suggestion: {
      accountId: acct?.id ?? null,
      accountNumber: acct ? acctNum : null,
      accountName: acct?.name ?? null,
      vendorId: vendor?.id ?? null,
      vendorName: vendor?.name ?? null,
      departmentId: dept?.id ?? null,
      departmentName: dept?.name ?? null,
      confidence, reasoning, source: 'ai', decisionId,
    },
  };
}
