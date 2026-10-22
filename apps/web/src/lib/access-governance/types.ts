/**
 * Access governance (05-RBAC-SPEC R-9 / R-10, wave 2D) — shared shapes for the access log,
 * access reviews, access requests and MeritBooks role suggestions. Mirrors migration 166.
 * PURE: no I/O, safe for client components.
 */

export type LogSource = 'ui' | 'api' | 'backfill' | 'template_update' | 'review' | 'request' | 'sweeper' | 'system';
export type LogSubjectType =
  | 'assignment' | 'role' | 'permission_set' | 'client_policy' | 'access_review' | 'access_review_item'
  | 'access_request' | 'template_update' | 'export' | 'session' | 'field' | 'tenant_setting';

/** core.access_change_log row as the API returns it (names stitched in). */
export interface AccessLogEntry {
  id: string;
  seq: number;
  at: string;
  event: string;
  source: LogSource;
  actorContext: string;
  actorUserId: string | null;
  actorName: string | null;
  subjectType: LogSubjectType;
  subjectId: string | null;
  affectedMembershipIds: string[];
  affectedNames: string[];
  locationIds: string[];
  locationNames: string[];
  allClients: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  approvalRef: string | null;
  /** One plain-English line (describeLogEntry). */
  summary: string;
}

export type ReviewScopeKind = 'all' | 'client' | 'role';
export type ReviewStatus = 'draft' | 'open' | 'closed';
export type ReviewDecision = 'keep' | 'reduce' | 'revoke' | 'delegate';

export interface ReviewSummaryCounts {
  items: number;
  kept: number;
  reduced: number;
  revoked: number;
  delegated: number;
  undecided: number;
  auto_revoked: number;
  reviewers: number;
  closed_late: boolean;
}

export interface AccessReview {
  id: string;
  name: string;
  scopeKind: ReviewScopeKind;
  scopeLabel: string;
  dueAt: string;
  status: ReviewStatus;
  autoRevokeUnreviewed: boolean;
  createdAt: string;
  createdByName: string | null;
  closedAt: string | null;
  summary: ReviewSummaryCounts | null;
  progress: { total: number; decided: number; mine: number; mineUndecided: number };
}

export interface AccessReviewItem {
  id: string;
  reviewId: string;
  membershipId: string | null;
  personName: string;
  personEmail: string | null;
  reviewerMembershipId: string | null;
  reviewerName: string | null;
  isMine: boolean;
  /** "Bookkeeper on Client One" */
  title: string;
  sourceName: string;
  scopeLabel: string;
  grantedAt: string | null;
  grantedByName: string | null;
  endsAt: string | null;
  legacy: boolean;
  reason: string | null;
  decision: ReviewDecision | null;
  decisionNote: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
}

export type RequestKind = 'capability' | 'role' | 'permission_set' | 'client';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface AccessRequestView {
  id: string;
  kind: RequestKind;
  /** "Edit Journal entries on Client Two for 7 days" */
  what: string;
  capability: string | null;
  actions: string[];
  roleId: string | null;
  roleName: string | null;
  permissionSetName: string | null;
  locationId: string | null;
  locationName: string | null;
  durationDays: number | null;
  reason: string;
  status: RequestStatus;
  requesterMembershipId: string;
  requesterName: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  needsSecondApproval: boolean;
  /** The created assignment is still waiting for a second grantor. */
  awaitingSecondApproval: boolean;
  createdAt: string;
  expiresAt: string;
  routedCount: number;
}

export type SuggestionKind = 'add' | 'remove' | 'constraint';

export interface SuggestionChange {
  id: string;
  kind: SuggestionKind;
  capability: string;
  actions?: string[];
  constraints?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface RoleSuggestion {
  id: string;
  roleId: string;
  roleName: string;
  holders: number;
  status: 'available' | 'partially_adopted';
  noteDismissed: boolean;
  changes: Array<SuggestionChange & { sentence: string; decision: 'added' | 'skipped' | null }>;
  createdAt: string;
}
