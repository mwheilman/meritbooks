// Shared client-side types for the unified Inbox. Kept in one place so the data
// hook, the tab shell, and the two queue views (InboxClient / ExceptionsQueue)
// agree on shape without importing from each other (avoids a client cycle).
//
// These mirror the server payloads:
//   /api/inbox       → lib/inbox/collect.ts (ranked "needs you" aggregate)
//   /api/exceptions  → app/api/exceptions/route.ts (broader flagged/held queue)

// ── /api/inbox ──────────────────────────────────────────────────────────────────

export type InboxItemType = 'APPROVAL' | 'POLICY_BLOCK' | 'ALERT' | 'EXCEPTION' | 'DRAFT';
export type InboxGroupKey = 'APPROVALS' | 'POLICY_BLOCKS' | 'ALERTS' | 'EXCEPTIONS' | 'DRAFTS';
export type InboxSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

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
}

export interface InboxGroup {
  key: InboxGroupKey;
  items: InboxItem[];
}

export interface InboxResponse {
  asOf: string;
  canApproveMoney: boolean;
  items: InboxItem[];
  groups: InboxGroup[];
  counts: { total: number; byType: Record<InboxItemType, number> };
  degraded: string[];
}

// ── /api/exceptions ─────────────────────────────────────────────────────────────

export type ExceptionSource = 'bank' | 'receipt' | 'bill' | 'ai_proposal' | 'approval' | 'cost';
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
  createdAt: string;
  href: string;
}

export interface ExceptionsResponse {
  data: ExceptionItem[];
  counts: {
    total: number;
    bySource: Record<string, number>;
    byDisposition?: Record<Disposition, number>;
  };
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
