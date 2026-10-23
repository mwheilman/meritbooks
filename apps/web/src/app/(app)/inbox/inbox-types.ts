// Shared client-side types for the unified Inbox. Kept in one place so the data
// hook, the tab shell, and the two queue views (InboxClient / ExceptionsQueue)
// agree on shape without importing from each other (avoids a client cycle).
//
// These mirror the server payload of /api/inbox (lib/work/needs-attention over
// lib/inbox/collect). The Exceptions tab rows are a projection of the same items
// (toExceptionRows below — mirrors needs-attention's toExceptionItems), so every tab
// count and every list come from ONE scoped item set and can never disagree.

// ── /api/inbox ──────────────────────────────────────────────────────────────────

export type InboxItemType = 'APPROVAL' | 'POLICY_BLOCK' | 'ALERT' | 'EXCEPTION' | 'DRAFT';
export type InboxGroupKey = 'APPROVALS' | 'POLICY_BLOCKS' | 'ALERTS' | 'EXCEPTIONS' | 'DRAFTS';
export type InboxSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type WorkLane = 'approvals' | 'exceptions' | 'alerts' | 'drafts';
export type WorkSource =
  | 'approval'
  | 'expense_report'
  | 'expense_policy'
  | 'bill_hold'
  | 'ai_proposal'
  | 'bank'
  | 'receipt'
  | 'cost'
  | 'obligation'
  | 'je_draft';

export interface InboxItem {
  id: string;
  type: InboxItemType;
  group: InboxGroupKey;
  title: string;
  subtitle: string | null;
  dueOrAge: string;
  severity: InboxSeverity;
  actionHref: string;
  actionLabel: string;
  amountCents: number | null;
  entity: { table: string; id: string };
  sortValue: number;
  lane: WorkLane;
  source: WorkSource;
  /** core.locations id; null = organization-level. */
  locationId: string | null;
  locationName: string | null;
  confidence: number | null;
  disposition: Disposition | null;
  createdAt: string | null;
}

export interface InboxGroup {
  key: InboxGroupKey;
  items: InboxItem[];
}

export interface InboxCounts {
  total: number;
  byLane: Record<WorkLane, number>;
  byType: Record<InboxItemType, number>;
  bySource: Record<WorkSource, number>;
  byDisposition: Record<Disposition, number> & { unscored: number };
  critical: number;
}

export interface InboxResponse {
  asOf: string;
  canApproveMoney: boolean;
  scope: { locationId: string | null; isAll: boolean };
  items: InboxItem[];
  groups: InboxGroup[];
  counts: InboxCounts;
  /** Lanes whose list was capped (counts are always the full set). */
  truncated: Record<WorkLane, boolean>;
  degraded: string[];
}

// ── /api/exceptions ─────────────────────────────────────────────────────────────

export type ExceptionSource = 'bank' | 'receipt' | 'ai_proposal' | 'cost';
export type Disposition = 'AUTO' | 'REVIEW' | 'ESCALATE' | 'BLOCKED';

export interface ExceptionItem {
  id: string;
  source: ExceptionSource;
  title: string;
  subtitle: string | null;
  amountCents: number | null;
  confidence: number | null;
  disposition: Disposition | null;
  companyId: string | null;
  companyName: string | null;
  createdAt: string;
  href: string;
}

export interface ExceptionsResponse {
  data: ExceptionItem[];
  counts: {
    total: number;
    bySource: Record<string, number>;
    byDisposition: Record<Disposition, number>;
    /** AI proposals with no recorded disposition — so the chips sum to the AI count. */
    unscored: number;
  };
  truncated: boolean;
}

const EXCEPTION_SOURCE: Partial<Record<WorkSource, ExceptionSource>> = {
  ai_proposal: 'ai_proposal',
  bank: 'bank',
  receipt: 'receipt',
  cost: 'cost',
};

/**
 * The Exceptions tab, projected from the /api/inbox payload (newest first). Counts
 * come from the server's full-set summary so they match the tab badge even when the
 * list is capped.
 */
export function toExceptionsResponse(inbox: InboxResponse): ExceptionsResponse {
  const data: ExceptionItem[] = [];
  for (const i of inbox.items) {
    const source = i.lane === 'exceptions' ? EXCEPTION_SOURCE[i.source] : undefined;
    if (!source) continue;
    data.push({
      id: i.entity.id,
      source,
      title: i.title,
      subtitle: i.subtitle,
      amountCents: i.amountCents,
      confidence: i.confidence,
      disposition: i.disposition,
      companyId: i.locationId,
      companyName: i.locationName,
      createdAt: i.createdAt ?? '',
      href: i.actionHref,
    });
  }
  data.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const { unscored, ...byDisposition } = inbox.counts.byDisposition;
  const src = inbox.counts.bySource;
  return {
    data,
    counts: {
      total: inbox.counts.byLane.exceptions,
      bySource: { ai_proposal: src.ai_proposal, bank: src.bank, receipt: src.receipt, cost: src.cost },
      byDisposition,
      unscored,
    },
    truncated: inbox.truncated.exceptions,
  };
}

/** Label for an item's client in the all-clients grouping. */
export const ORG_GROUP_LABEL = 'Organization';

/**
 * Group rows by client for the all-clients view: busiest client first, the
 * organization-level group (no client) last. Row order inside a group is preserved.
 */
export function groupRowsByClient<T>(
  rows: readonly T[],
  clientOf: (row: T) => { id: string | null; name: string | null },
): Array<{ id: string; title: string; rows: T[] }> {
  const map = new Map<string, { id: string; title: string; rows: T[] }>();
  for (const r of rows) {
    const c = clientOf(r);
    const key = c.id ?? '__org__';
    const g = map.get(key) ?? { id: key, title: c.id ? c.name ?? 'Unnamed client' : ORG_GROUP_LABEL, rows: [] };
    g.rows.push(r);
    map.set(key, g);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.id === '__org__') return 1;
    if (b.id === '__org__') return -1;
    return b.rows.length - a.rows.length || a.title.localeCompare(b.title);
  });
}

// ── Tab model (shared by the shell + the summary badges) ─────────────────────────

export type TabKey = 'approvals' | 'exceptions' | 'alerts' | 'drafts';

/**
 * Which /api/inbox groups each (non-exceptions) tab renders. Policy blocks ride
 * with Approvals since both are gates that hold money movement. The Exceptions
 * tab is powered by /api/exceptions instead (a broader flagged/held queue).
 */
export const GROUPS_FOR_TAB: Record<Exclude<TabKey, 'exceptions'>, InboxGroupKey[]> = {
  approvals: ['APPROVALS', 'POLICY_BLOCKS'],
  alerts: ['ALERTS'],
  drafts: ['DRAFTS'],
};

export const SEVERITY_RANK: Record<InboxSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};
