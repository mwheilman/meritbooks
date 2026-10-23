/**
 * What the customer did with the online link — from the append-only invoice_events
 * log (VIEWED on hosted-page load, PAY_* from the pay intent + Stripe webhook).
 * Pure: the invoice list ("Paid online" / "Viewed 3×") and the drawer's Pay link panel
 * both read it.
 */

export type OnlineStatus = 'PAID_ONLINE' | 'PROCESSING' | 'FAILED' | 'STARTED' | 'VIEWED' | 'NOT_VIEWED';

export interface OnlineEvent {
  event_type: string;
  created_at: string;
  meta?: Record<string, unknown> | null;
}

export interface OnlineActivity {
  status: OnlineStatus;
  /** Plain-English label for the list column / panel. */
  label: string;
  views: number;
  lastViewedAt: string | null;
  paidOnlineAt: string | null;
  /** Amount of the most recent successful online payment (cents), when known. */
  paidOnlineCents: number | null;
  lastAttemptAt: string | null;
}

const PAY_TYPES = new Set(['VIEWED', 'PAY_INITIATED', 'PAY_PROCESSING', 'PAY_SUCCEEDED', 'PAY_FAILED']);

export const ONLINE_EVENT_TYPES = [...PAY_TYPES];

export function summarizeOnlineActivity(events: ReadonlyArray<OnlineEvent>): OnlineActivity {
  const ev = events.filter((e) => PAY_TYPES.has(e.event_type)).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  const views = ev.filter((e) => e.event_type === 'VIEWED');
  const lastOf = (t: string) => ev.filter((e) => e.event_type === t).at(-1) ?? null;
  const succeeded = lastOf('PAY_SUCCEEDED');
  const processing = lastOf('PAY_PROCESSING');
  const failed = lastOf('PAY_FAILED');
  const started = lastOf('PAY_INITIATED');
  const lastAttempt = [started, processing, failed, succeeded].filter(Boolean).map((e) => e!.created_at).sort().at(-1) ?? null;
  const amount = (e: OnlineEvent | null) => {
    const v = e?.meta?.amount_cents ?? e?.meta?.base_cents;
    return typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
  };

  const after = (a: OnlineEvent | null, b: OnlineEvent | null) => !!a && (!b || a.created_at >= b.created_at);
  let status: OnlineStatus;
  if (succeeded) status = 'PAID_ONLINE';
  else if (processing && after(processing, failed)) status = 'PROCESSING';
  else if (failed && after(failed, started)) status = 'FAILED';
  else if (started) status = 'STARTED';
  else if (views.length) status = 'VIEWED';
  else status = 'NOT_VIEWED';

  const n = views.length;
  const label: Record<OnlineStatus, string> = {
    PAID_ONLINE: 'Paid online',
    PROCESSING: 'Bank payment processing',
    FAILED: 'Online payment failed',
    STARTED: 'Started paying',
    VIEWED: `Viewed ${n}×`,
    NOT_VIEWED: 'Not viewed',
  };
  return {
    status,
    label: label[status],
    views: n,
    lastViewedAt: views.at(-1)?.created_at ?? null,
    paidOnlineAt: succeeded?.created_at ?? null,
    paidOnlineCents: amount(succeeded),
    lastAttemptAt: lastAttempt,
  };
}
