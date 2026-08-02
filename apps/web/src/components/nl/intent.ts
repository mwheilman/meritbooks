/**
 * Universal NL Command — intent taxonomy, classifier helpers, and the router
 * intent-mapping logic (FPB-nl-copilot §1).
 *
 * This module is ISOMORPHIC and dependency-free (no next/clerk/lucide/db). It
 * holds ONLY pure functions so the router mapping is unit-testable with a mocked
 * gateway. All model calls happen in the route (app/api/nl/route.ts) through the
 * Core AI gateway — this file never touches the network.
 *
 * The three lanes (canon invariant, CANON-ANCHOR §3):
 *   PROCESSING  → produce a PROPOSED action (propose→approve; never auto-post).
 *   ANALYTICAL  → NL → constrained, allowlisted, read-only ledger query (no SQL).
 *   NAVIGATION  → resolve to an in-app destination / grounded how-to.
 */

export type NlLane = 'PROCESSING' | 'ANALYTICAL' | 'NAVIGATION' | 'ABSTAIN';

/**
 * Processing intents wired to the bar. Each drives a propose→approve panel that
 * reuses an EXISTING gated route — the copilot adds no parallel posting path:
 *   P1 → /api/journal-entries/compose then /api/journal-entries (post)
 *   P2 → /api/nl/categorize (propose) then /api/bank-feed/approve (post)
 *   P3 → /api/nl/draft-bill (propose) then /api/bills/create
 *   P4 → /api/nl/draft-invoice (propose) then /api/invoices (create)
 */
export type ProcessingKind =
  | 'P1_RECORD_JE'
  | 'P2_CATEGORIZE'
  | 'P3_CREATE_BILL'
  | 'P4_CREATE_INVOICE';

export interface NlContext {
  surface?: string;
  entityId?: string;
  recordType?: string;
  period?: string;
}

export interface NlEntities {
  company?: string;
  amount?: string;
  period?: string;
  vendor?: string;
  customer?: string;
}

/** The classifier's structured output ({lane,intent,entities,confidence,clarify}). */
export interface Classification {
  lane: NlLane;
  intent: string;
  entities: NlEntities;
  confidence: number; // 0..1
  clarifyingQuestion: string | null;
}

export interface NavTarget {
  label: string;
  href: string;
}

/** The router's final, lane-shaped result (returned by POST /api/nl/route). */
export interface NlRouteResult {
  lane: NlLane;
  intent: string;
  confidence: number;
  entities: NlEntities;
  clarifyingQuestion: string | null;
  /** true when the model was unavailable (budget hard-block / no key) and we fell back to rules. */
  degraded: boolean;
  /** PROCESSING lane — tells the client which propose→approve flow to drive. */
  processing?: { kind: ProcessingKind; description: string };
  /** ANALYTICAL lane — the client forwards this prompt to POST /api/nl/query. */
  analytical?: { prompt: string };
  /** NAVIGATION lane — resolved destination, or null when unresolved. */
  navigation?: NavTarget | null;
  /** ABSTAIN — nothing safe/supported to do; show the nearest supported action. */
  abstain?: { reason: string; suggestion?: string };
}

/**
 * Curated navigation allowlist (label + href + trigger keywords). Reading the
 * live `lib/navigation.ts` is fine, but it pulls lucide icons and is a reserved
 * shared-spine file; this small mirror keeps the module isomorphic and stable.
 */
export const NAV_CATALOG: Array<{ label: string; href: string; keywords: string[] }> = [
  { label: 'Dashboard', href: '/dashboard', keywords: ['dashboard', 'home', 'overview'] },
  { label: 'Needs Attention', href: '/exceptions', keywords: ['exceptions', 'needs attention', 'inbox', 'queue'] },
  { label: 'Bank Feed', href: '/bank-feed', keywords: ['bank feed', 'bank', 'transactions', 'feed'] },
  { label: 'Credit Cards', href: '/credit-cards', keywords: ['credit card', 'credit cards'] },
  { label: 'Receipts', href: '/receipts', keywords: ['receipt', 'receipts'] },
  { label: 'Bills', href: '/bills', keywords: ['bill', 'bills', 'accounts payable', 'ap'] },
  { label: 'Check Run', href: '/checks', keywords: ['check run', 'checks', 'check'] },
  { label: 'Flagged Items', href: '/flagged', keywords: ['flagged', 'flags'] },
  { label: 'Journal Entries', href: '/journal-entries', keywords: ['journal', 'journal entries', 'je', 'general ledger', 'gl'] },
  { label: 'Chart of Accounts', href: '/chart-of-accounts', keywords: ['chart of accounts', 'coa', 'accounts'] },
  { label: 'Reconciliation', href: '/reconciliation', keywords: ['reconciliation', 'reconcile', 'bank rec'] },
  { label: 'Fiscal Periods', href: '/periods', keywords: ['periods', 'fiscal period', 'period'] },
  { label: 'Revenue Recognition', href: '/rev-rec', keywords: ['revenue recognition', 'rev rec', 'rev-rec'] },
  { label: 'Invoices', href: '/invoices', keywords: ['invoice', 'invoices', 'accounts receivable', 'ar'] },
  { label: 'Payments', href: '/settings/payments', keywords: ['payments', 'payment settings'] },
  { label: 'Payroll', href: '/payroll', keywords: ['payroll', 'pay run'] },
  { label: 'Budgets', href: '/budgets', keywords: ['budget', 'budgets'] },
  { label: 'Cash', href: '/cash', keywords: ['cash', 'cash position'] },
  { label: 'Forecast', href: '/forecast', keywords: ['forecast', '13-week', 'cash forecast'] },
  { label: 'Reports', href: '/reports', keywords: ['report', 'reports', 'financial statements', 'p&l', 'balance sheet', 'income statement'] },
  { label: 'Profitability', href: '/profitability', keywords: ['profitability', 'profit'] },
  { label: 'AI Decisions', href: '/ai-decisions', keywords: ['ai decisions', 'decision log', 'decisions'] },
  { label: 'Categorize', href: '/categorize', keywords: ['categorize', 'categorization', 'coding'] },
  { label: 'Departments', href: '/departments', keywords: ['department', 'departments'] },
  { label: 'Internal Invoices', href: '/internal-invoices', keywords: ['internal invoice', 'internal invoices'] },
  { label: 'Intercompany', href: '/intercompany', keywords: ['intercompany', 'inter-company', 'eliminations'] },
  { label: 'Jobs', href: '/jobs', keywords: ['job', 'jobs', 'job costing'] },
  { label: 'Vendors', href: '/vendors', keywords: ['vendor', 'vendors'] },
  { label: 'Customers', href: '/customers', keywords: ['customer', 'customers'] },
  { label: 'Vendor Compliance', href: '/vendor-compliance', keywords: ['vendor compliance', 'w-9', 'w9', 'coi'] },
  { label: '1099s', href: '/compliance-1099', keywords: ['1099', '1099s'] },
  { label: 'Close', href: '/close', keywords: ['close', 'month-end', 'close command'] },
  { label: 'Team', href: '/team', keywords: ['team', 'team performance', 'members'] },
  { label: 'Audit', href: '/audit', keywords: ['audit', 'audit trail'] },
  { label: 'Settings', href: '/settings', keywords: ['settings', 'configuration', 'config'] },
  { label: 'Import', href: '/import', keywords: ['import', 'migration', 'quickbooks import', 'sage import'] },
];

const NAV_VERBS = /\b(go to|take me to|open|navigate to|show me the|jump to|bring up)\b/i;
const PROCESSING_VERBS = /\b(record|accrue|book|post a|enter (a|the)|create (a|an|the)|draft (a|an|the)|reclass|reclassify|journalize|write off|write-off|invoice|bill)\b/i;
const CATEGORIZE_VERBS = /\b(categorize|categorise|code (the|these|those|last)|recode)\b/i;
// AP bill (P3): "enter a $1,800 bill from Ace Plumbing due Aug 30". Anchored on a
// create verb + the word "bill" + "from" (a vendor) so it never eats an AR ask.
const BILL_VERBS = /^\s*(enter|create|add|record|book|draft|new|log)\b.*\bbill\b.*\bfrom\b/i;
// AR invoice (P4): "invoice Coho $5k for June retainer" / "create an invoice for X".
const INVOICE_VERBS = /^\s*invoice\b/i;
const INVOICE_CREATE_VERBS = /^\s*(create|draft|send|new|raise|generate)\b.*\binvoice\b/i;
const ANALYTICAL_VERBS = /\b(why|how much|what(?:'s| is| are| was)|how many|show me (?:the )?(?:p&l|balance|cash|revenue|expenses|profit)|trend|compare|budget vs|variance|forecast|runway|dscr|margin)\b/i;
const CONTROL_VERBS = /\b(check for duplicate|find duplicate|anomalous|run a control|any anomalies)\b/i;

/** Retired capabilities (CANON-ANCHOR §2) — never surfaced; abstain if asked. */
const RETIRED = /\b(chargeback|overhead rate|burden rate|labor classification|time tracking|timesheet)\b/i;

/** Strip a leading navigation/processing verb so we keep only the substantive ask. */
function stripLeadingVerb(prompt: string): string {
  return prompt.replace(NAV_VERBS, '').trim();
}

/** Match a prompt to a navigation destination by keyword (longest keyword wins). */
export function resolveNavigation(prompt: string): NavTarget | null {
  const p = prompt.toLowerCase();
  let best: { target: NavTarget; len: number } | null = null;
  for (const entry of NAV_CATALOG) {
    for (const kw of entry.keywords) {
      if (p.includes(kw) && (!best || kw.length > best.len)) {
        best = { target: { label: entry.label, href: entry.href }, len: kw.length };
      }
    }
  }
  return best?.target ?? null;
}

/**
 * Fast rules pre-filter for OBVIOUS verbs (and the degraded fallback when the
 * gateway is budget-blocked). Returns a high-confidence classification, or null
 * when the prompt needs the model. Never guesses — ambiguous → null.
 */
export function rulesClassify(prompt: string, _context?: NlContext): Classification | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  if (RETIRED.test(trimmed)) {
    return {
      lane: 'ABSTAIN',
      intent: 'RETIRED_CAPABILITY',
      entities: {},
      confidence: 0.95,
      clarifyingQuestion: null,
    };
  }

  // Navigation is the cheapest, safest match: an explicit nav verb + a known target.
  if (NAV_VERBS.test(trimmed)) {
    const target = resolveNavigation(stripLeadingVerb(trimmed));
    if (target) {
      return { lane: 'NAVIGATION', intent: 'N1_NAVIGATE', entities: {}, confidence: 0.9, clarifyingQuestion: null };
    }
  }

  if (CONTROL_VERBS.test(trimmed)) {
    // Control runs are PROCESSING (detect-only) but not wired in the MVP → let the model/abstain handle.
    return null;
  }

  if (CATEGORIZE_VERBS.test(trimmed)) {
    return { lane: 'PROCESSING', intent: 'P2_CATEGORIZE', entities: {}, confidence: 0.82, clarifyingQuestion: null };
  }

  // AP bill draft — checked BEFORE the generic P1 block ("enter …" would otherwise
  // classify as a journal entry).
  if (BILL_VERBS.test(trimmed)) {
    return { lane: 'PROCESSING', intent: 'P3_CREATE_BILL', entities: {}, confidence: 0.82, clarifyingQuestion: null };
  }

  // AR invoice draft — a leading "invoice …" or an explicit create+invoice.
  if (INVOICE_VERBS.test(trimmed) || INVOICE_CREATE_VERBS.test(trimmed)) {
    return { lane: 'PROCESSING', intent: 'P4_CREATE_INVOICE', entities: {}, confidence: 0.82, clarifyingQuestion: null };
  }

  // Analytical question shapes take precedence over the generic processing verbs
  // (e.g. "what bills are due" is a query, not "enter a bill").
  if (ANALYTICAL_VERBS.test(trimmed) && !/^\s*(record|accrue|book|post|enter|create|draft|reclass)/i.test(trimmed)) {
    return { lane: 'ANALYTICAL', intent: 'A_QUERY', entities: {}, confidence: 0.8, clarifyingQuestion: null };
  }

  if (PROCESSING_VERBS.test(trimmed) && /^\s*(record|accrue|book|post|enter|create|draft|reclass|journalize)/i.test(trimmed)) {
    return { lane: 'PROCESSING', intent: 'P1_RECORD_JE', entities: {}, confidence: 0.8, clarifyingQuestion: null };
  }

  return null;
}

/** Build the classifier prompt (gateway-routed). Returns strict-JSON instructions. */
export function buildClassifierPrompt(prompt: string, context?: NlContext): string {
  const ctx = context
    ? `\nCURRENT SURFACE CONTEXT (use to disambiguate; do not invent): ${JSON.stringify(context)}`
    : '';
  return `You are the intent router for MeritBooks, an AI-native accounting book of record. Classify the user's prompt into exactly ONE lane and ONE intent. Do NOT answer the prompt; only classify it.

LANES & INTENTS:
- PROCESSING (create/record/categorize — produces a PROPOSAL a human approves; never posts):
  - P1_RECORD_JE: record/accrue/book/reclass a journal entry ("accrue $4,200 rent for Coho for July").
  - P2_CATEGORIZE: code/categorize bank-feed or card charges ("code the last 5 Home Depot charges to job materials").
  - P3_CREATE_BILL: enter a vendor BILL / accounts-payable ("enter a $1,800 bill from Ace Plumbing due Aug 30"). A bill is money we OWE a vendor; the entities.vendor is the payee.
  - P4_CREATE_INVOICE: raise a customer INVOICE / accounts-receivable ("invoice Coho $5k for the June retainer"). An invoice is money a CUSTOMER owes us; entities.customer is the payer. "invoice <name>" is ALWAYS P4, never P3.
- ANALYTICAL (read-only ledger question — answered later by a constrained query):
  - A_QUERY: any question about the numbers ("why did OpEx jump?", "cash on hand for Heartland", "P&L for Coho Q2", "budget vs actual", "will we have cash in 8 weeks").
- NAVIGATION (get somewhere / how-to):
  - N1_NAVIGATE: "take me to the bank feed", "open invoices".
  - N2_HOWTO: "how do I record a customer deposit?".
- ABSTAIN: not a MeritBooks capability, retired feature, or genuinely unclear.

RULES:
- One prompt → one lane → one intent. If it straddles ("record X and then show me Y"), pick the FIRST actionable step and set clarifyingQuestion.
- If the target entity, amount, or economic substance is ambiguous for a PROCESSING prompt, set a single specific clarifyingQuestion.
- Extract entities you can see: company, amount, period, vendor, customer. Never invent them.
- confidence is 0..1. Be honest; low confidence is fine.
${ctx}

USER PROMPT:
"""${prompt}"""

Respond with ONLY this JSON, no prose, no markdown:
{"lane":"PROCESSING|ANALYTICAL|NAVIGATION|ABSTAIN","intent":"...","entities":{"company":null,"amount":null,"period":null,"vendor":null,"customer":null},"confidence":0.0,"clarifyingQuestion":null}`;
}

const VALID_LANES: NlLane[] = ['PROCESSING', 'ANALYTICAL', 'NAVIGATION', 'ABSTAIN'];

/** Parse the model's JSON classification, failing closed to ABSTAIN. */
export function parseClassification(text: string): Classification {
  const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { lane: 'ABSTAIN', intent: 'PARSE_FAILED', entities: {}, confidence: 0, clarifyingQuestion: null };
  }
  const laneRaw = String(parsed.lane ?? 'ABSTAIN').toUpperCase();
  const lane = (VALID_LANES.includes(laneRaw as NlLane) ? laneRaw : 'ABSTAIN') as NlLane;
  const rawEnt = (parsed.entities as Record<string, unknown>) ?? {};
  const str = (v: unknown): string | undefined => (v == null || v === '' ? undefined : String(v));
  const entities: NlEntities = {
    company: str(rawEnt.company),
    amount: str(rawEnt.amount),
    period: str(rawEnt.period),
    vendor: str(rawEnt.vendor),
    customer: str(rawEnt.customer),
  };
  return {
    lane,
    intent: String(parsed.intent ?? 'UNKNOWN'),
    entities,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0))),
    clarifyingQuestion: parsed.clarifyingQuestion ? String(parsed.clarifyingQuestion) : null,
  };
}

/** Confidence below this → ask one disambiguating question instead of acting. */
export const CLARIFY_THRESHOLD = 0.45;

/** Pure: map a classification onto the lane-shaped router result the client renders. */
export function buildRouteResult(
  classification: Classification,
  prompt: string,
  opts: { degraded: boolean },
): NlRouteResult {
  const base = {
    lane: classification.lane,
    intent: classification.intent,
    confidence: classification.confidence,
    entities: classification.entities,
    clarifyingQuestion: classification.clarifyingQuestion,
    degraded: opts.degraded,
  };

  // Low confidence (and not already asking) → clarify before acting/answering.
  if (classification.lane !== 'ABSTAIN' && classification.confidence > 0 && classification.confidence < CLARIFY_THRESHOLD && !classification.clarifyingQuestion) {
    return {
      ...base,
      clarifyingQuestion: 'I want to make sure I route this correctly — can you rephrase or add the company, amount, or period?',
    };
  }

  switch (classification.lane) {
    case 'PROCESSING': {
      const kind: ProcessingKind =
        classification.intent === 'P2_CATEGORIZE'
          ? 'P2_CATEGORIZE'
          : classification.intent === 'P3_CREATE_BILL'
            ? 'P3_CREATE_BILL'
            : classification.intent === 'P4_CREATE_INVOICE'
              ? 'P4_CREATE_INVOICE'
              : 'P1_RECORD_JE';
      return { ...base, processing: { kind, description: prompt.trim() } };
    }
    case 'ANALYTICAL':
      return { ...base, analytical: { prompt: prompt.trim() } };
    case 'NAVIGATION': {
      const nav = resolveNavigation(stripLeadingVerb(prompt));
      if (nav) return { ...base, navigation: nav };
      // A how-to (N2) or an unresolved destination.
      if (classification.intent === 'N2_HOWTO') {
        return { ...base, navigation: null };
      }
      return {
        ...base,
        lane: 'ABSTAIN',
        navigation: null,
        abstain: { reason: "I couldn't match that to a screen.", suggestion: 'Try “open bank feed”, “take me to invoices”, or “go to reports”.' },
      };
    }
    case 'ABSTAIN':
    default:
      return {
        ...base,
        abstain: {
          reason:
            classification.intent === 'RETIRED_CAPABILITY'
              ? 'That capability was retired from MeritBooks.'
              : "I can't do that from the ledger yet.",
          suggestion: 'Try recording an entry (“accrue $4,200 rent for Coho”), asking a question (“why did OpEx jump?”), or navigating (“open invoices”).',
        },
      };
  }
}

/**
 * Orchestrate: rules pre-filter first (cheap, no spend), else call the injected
 * `classify` (the gateway). On classify failure (budget block / no key) fall
 * back to rules, marking the result degraded. Injecting `classify` is what makes
 * the router unit-testable with a mocked gateway.
 */
export async function classifyAndRoute(
  prompt: string,
  context: NlContext | undefined,
  classify: (prompt: string, context?: NlContext) => Promise<Classification>,
): Promise<{ result: NlRouteResult; usedGateway: boolean }> {
  const rule = rulesClassify(prompt, context);
  if (rule && rule.confidence >= 0.8) {
    return { result: buildRouteResult(rule, prompt, { degraded: false }), usedGateway: false };
  }
  try {
    const classification = await classify(prompt, context);
    return { result: buildRouteResult(classification, prompt, { degraded: false }), usedGateway: true };
  } catch {
    const fallback = rule ?? {
      lane: 'ABSTAIN' as NlLane,
      intent: 'AI_UNAVAILABLE',
      entities: {},
      confidence: 0,
      clarifyingQuestion: null,
    };
    const result = buildRouteResult(fallback, prompt, { degraded: true });
    if (fallback.lane === 'ABSTAIN') {
      result.abstain = {
        reason: 'AI is paused (budget cap or provider unavailable).',
        suggestion: 'Navigation still works — try “open bank feed”. Otherwise use the equivalent form or report directly.',
      };
    }
    return { result, usedGateway: false };
  }
}
