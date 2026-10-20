/**
 * describePlan(): the "Here's your workspace" preview cards, in the pack's own words.
 * Copy rules (Merit voice): plain, specific, numbers where they help; no hype words.
 */
import type { CostType, GuardName, ModuleKey, PlanJobType, WorkspacePlan } from './types';
import { MODULES } from './types';
import {
  BILLING_MODE_LABELS, COST_TYPE_LABELS, MODULE_LABELS, REV_REC_HINT_LABELS, ROLE_HINT_LABELS,
} from './constants';
import { DEFAULT_VOCAB, t, tLower } from './vocab';

export type PreviewSection =
  | 'job_types' | 'stages' | 'billing' | 'cost_codes' | 'modules' | 'vocabulary' | 'price_book'
  | 'kpis' | 'books' | 'sample_job';

export interface PreviewCard {
  section: PreviewSection;
  title: string;
  summary: string;
  items: string[];
}

const COST_TYPE_SINGULAR: Record<CostType, string> = {
  LABOR: 'Labor',
  MATERIALS: 'Material',
  SUBCONTRACTOR: 'Subcontractor',
  EQUIPMENT: 'Equipment',
  OTHER: 'Other',
};

export function formatCents(cents: number): string {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

function list(words: string[]): string {
  if (words.length <= 1) return words.join('');
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function orList(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/** Module label in the pack's words where a vocabulary key covers it. */
function moduleLabel(m: ModuleKey, v: Record<string, string>): string {
  switch (m) {
    case 'estimates': return t(v, 'estimates');
    case 'change_orders': return t(v, 'change_orders');
    case 'selections': return t(v, 'selections');
    case 'daily_logs': return t(v, 'daily_logs');
    case 'lender_draws': return `Lender ${tLower(v, 'draws')}`;
    default: return MODULE_LABELS[m];
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function guardPhrase(g: GuardName, v: Record<string, string>): string {
  switch (g) {
    case 'has_customer': return `a ${tLower(v, 'customer')}`;
    case 'has_contract_value': return 'a contract value';
    case 'has_budget': return 'a budget';
    case 'estimate_accepted': return `an accepted ${tLower(v, 'estimate')}`;
    case 'deposit_requested': return 'a deposit request';
    case 'selections_approved': return `approved ${tLower(v, 'selections')}`;
    case 'no_open_change_orders': return `no open ${tLower(v, 'change_orders')}`;
    case 'punch_complete': return 'a finished punch list';
    case 'final_billed': return 'everything billed';
    case 'compliance_current': return 'current COIs and lien waivers';
    case 'work_orders_closed': return `every ${tLower(v, 'work_order')} closed`;
    case 'production_complete': return 'production finished';
  }
}

function billingSummary(j: PlanJobType): string {
  const others = j.billing_modes.filter((b) => b !== j.default_billing_mode).map((b) => BILLING_MODE_LABELS[b]);
  let s = `${BILLING_MODE_LABELS[j.default_billing_mode]} by default`;
  if (others.length) s += `; also ${list(others)}`;
  if (j.default_retainage_pct !== null) s += `; ${pct(j.default_retainage_pct)} retainage`;
  return s;
}

export function describePlan(plan: WorkspacePlan): PreviewCard[] {
  const v = plan.vocabulary;
  const cards: PreviewCard[] = [];
  const job = tLower(v, 'job');
  const jobs = tLower(v, 'jobs');

  // ---- job types
  const stagesByMachine = new Map<string, typeof plan.stages>();
  for (const s of plan.stages) stagesByMachine.set(s.machine_key, [...(stagesByMachine.get(s.machine_key) ?? []), s]);
  cards.push({
    section: 'job_types',
    title: `Kinds of ${jobs}`,
    summary: `${plural(plan.job_types.length, 'kind', 'kinds')} of ${job}, each with its own stages and billing.`,
    items: plan.job_types.map((j) => `${j.label}: ${plural(stagesByMachine.get(j.stage_machine_key)?.length ?? 0, 'stage', 'stages')}, bills ${BILLING_MODE_LABELS[j.default_billing_mode]}`),
  });

  // ---- stages
  const stageItems: string[] = [];
  for (const [machine, stages] of stagesByMachine) {
    const users = plan.job_types.filter((j) => j.stage_machine_key === machine).map((j) => j.label);
    const sorted = [...stages].sort((a, b) => a.sort - b.sort);
    const success = sorted.find((s) => s.is_terminal && s.core_status !== 'CANCELLED');
    const path = [
      ...sorted.filter((s) => !s.is_terminal && s.core_status !== 'ON_HOLD').map((s) => s.label),
      ...(success ? [success.label] : []),
    ];
    const exits = sorted.filter((s) => s.is_terminal && s !== success).map((s) => s.label);
    stageItems.push(`${list(users)}: ${path.join(' → ')}${exits.length ? ` (or ${orList(exits)})` : ''}`);
    const labelOf = new Map(sorted.map((s) => [s.stage_key, s.label]));
    const gated = plan.transitions.filter((tr) => tr.machine_key === machine && tr.guards.length > 0);
    const seenTo = new Set<string>();
    for (const tr of gated) {
      if (seenTo.has(tr.to_stage)) continue;
      seenTo.add(tr.to_stage);
      if (seenTo.size > 4) break;
      stageItems.push(`"${labelOf.get(tr.to_stage)}" needs ${list(tr.guards.map((g) => guardPhrase(g, v)))}`);
    }
  }
  cards.push({
    section: 'stages',
    title: 'Stages',
    summary: `A ${job} moves to the next stage only when its checks pass, so nothing starts without what it needs.`,
    items: stageItems,
  });

  // ---- billing
  cards.push({
    section: 'billing',
    title: "How you'll bill",
    summary: `Each ${job} sends ${tLower(v, 'invoice_request')}s to Books, which numbers and posts the invoice.`,
    items: plan.job_types.map((j) => `${j.label}: ${billingSummary(j)}`),
  });

  // ---- cost codes
  const childCount = new Map<string, number>();
  for (const c of plan.cost_codes) if (c.parent_code) childCount.set(c.parent_code, (childCount.get(c.parent_code) ?? 0) + 1);
  const groups = plan.cost_codes.filter((c) => !c.parent_code && childCount.has(c.code));
  const types = [...new Set(plan.cost_codes.map((c) => COST_TYPE_LABELS[c.cost_type].toLowerCase()))];
  cards.push({
    section: 'cost_codes',
    title: 'Cost codes',
    summary: `${plural(plan.cost_codes.length, 'cost code', 'cost codes')}${groups.length ? ` in ${plural(groups.length, 'group', 'groups')}` : ''}, rolling up as ${list(types)}.`,
    items: (groups.length ? groups.map((g) => `${g.code} ${g.name} (${childCount.get(g.code)})`) : plan.cost_codes.map((c) => `${c.code} ${c.name}`)).slice(0, 10),
  });

  // ---- modules
  const on = MODULES.filter((m) => plan.modules[m]);
  const off = MODULES.filter((m) => !plan.modules[m]);
  cards.push({
    section: 'modules',
    title: 'Tools turned on',
    summary: `${on.length} of ${MODULES.length} on. Anything off can be turned on later.`,
    items: [...on.map((m) => moduleLabel(m, v)), ...(off.length ? [`Off: ${off.map((m) => moduleLabel(m, v)).join(', ')}`] : [])],
  });

  // ---- vocabulary
  const renamed = (Object.keys(DEFAULT_VOCAB) as (keyof typeof DEFAULT_VOCAB)[])
    .filter((k) => v[k] && v[k] !== DEFAULT_VOCAB[k])
    .filter((k) => !(k.endsWith('s') && (k.slice(0, -1) in DEFAULT_VOCAB)));
  cards.push({
    section: 'vocabulary',
    title: "Words we'll use",
    summary: v.jobs !== DEFAULT_VOCAB.jobs
      ? `We'll call them ${t(v, 'jobs')}.`
      : renamed.length ? 'Standard terms, with the changes below.' : "We'll use the standard terms.",
    items: renamed.map((k) => `${DEFAULT_VOCAB[k]} → ${v[k]}`),
  });

  // ---- price book
  if (plan.price_book.length > 0) {
    cards.push({
      section: 'price_book',
      title: 'Starter price book',
      summary: `${plural(plan.price_book.length, 'item', 'items')} with starting prices. Change or replace any of them.`,
      items: plan.price_book.slice(0, 10).map((p) => `${p.name}: ${formatCents(p.price_cents)}${p.unit.toLowerCase() === 'each' ? '' : ` per ${p.unit}`}`),
    });
  }

  // ---- KPIs
  cards.push({
    section: 'kpis',
    title: "What we'll watch",
    summary: `${plural(plan.kpis.length, 'number', 'numbers')}, each compared with last period and linked to the ${jobs} behind it.`,
    items: plan.kpis.map((k) => k.label),
  });

  // ---- Books proposal
  const roleItems = Object.entries(plan.books_proposal.cost_type_roles)
    .map(([ct, role]) => `${COST_TYPE_SINGULAR[ct as CostType]} costs → ${ROLE_HINT_LABELS[role!]}`);
  const revItems = plan.job_types
    .filter((j) => plan.books_proposal.rev_rec_by_job_type[j.key])
    .map((j) => `${j.label}: revenue ${REV_REC_HINT_LABELS[plan.books_proposal.rev_rec_by_job_type[j.key]]}`);
  cards.push({
    section: 'books',
    title: "What we'll suggest to Books",
    summary: 'Books makes the final call on accounts and revenue recognition. These are starting suggestions.',
    items: [...roleItems, ...revItems],
  });

  // ---- sample job
  if (plan.sample_job) {
    const s = plan.sample_job;
    const budget = s.budget.reduce((sum, b) => sum + b.amountCents, 0);
    cards.push({
      section: 'sample_job',
      title: `Sample ${job}`,
      summary: `${s.name} for ${s.customerName}: ${formatCents(s.contractCents)} contract, ${formatCents(budget)} budget, ${plural(s.tasks.length, t(v, 'task').toLowerCase(), t(v, 'tasks').toLowerCase())}. Marked as a sample; remove it in one click.`,
      items: s.tasks.map((x) => x.title),
    });
  }

  return cards;
}
