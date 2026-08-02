import Link from 'next/link';
import clsx from 'clsx';
import {
  CalendarDays,
  MapPin,
  Wrench,
  Clock,
  Flag,
  Layers,
  AlertCircle,
  Inbox,
  ClipboardList,
} from 'lucide-react';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';

export const dynamic = 'force-dynamic';

// G6 dispatch board: a live kanban of proj.work_orders lane-grouped by status.
// RLS auto-scopes every row to the caller's org; job identity is joined in JS
// from core.jobs (read-authoritative = core). Read-only surface — no writes.

type WorkOrderStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'DISPATCHED'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'COMPLETED'
  | 'CANCELED';

interface WorkOrder {
  id: string;
  job_id: string;
  title: string;
  status: WorkOrderStatus;
  required_capability: string | null;
  zone: string | null;
  priority: number;
  estimated_minutes: number | null;
  assigned_employee_id: string | null;
  scheduled_window: string | null;
}

interface Job {
  id: string;
  job_number: string;
  name: string;
}

// The lanes that make up the board, in dispatch flow order. ON_HOLD / CANCELED
// are intentionally not primary lanes; any that exist fold into a compact
// "Other" lane so nothing silently disappears.
const LANES: { status: WorkOrderStatus; label: string }[] = [
  { status: 'DRAFT', label: 'Draft' },
  { status: 'SCHEDULED', label: 'Scheduled' },
  { status: 'DISPATCHED', label: 'Dispatched' },
  { status: 'IN_PROGRESS', label: 'In Progress' },
  { status: 'COMPLETED', label: 'Completed' },
];

const OTHER_STATUSES: WorkOrderStatus[] = ['ON_HOLD', 'CANCELED'];

const LANE_ACCENT: Record<string, string> = {
  DRAFT: 'bg-slate-500',
  SCHEDULED: 'bg-info',
  DISPATCHED: 'bg-ai',
  IN_PROGRESS: 'bg-warning',
  COMPLETED: 'bg-brand-500',
  OTHER: 'bg-slate-600',
};

function formatDuration(mins: number | null): string | null {
  if (mins == null || mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Priority → visual weight. Higher int = more urgent = more prominent.
function priorityMeta(priority: number): { label: string; dot: string; text: string } | null {
  if (priority >= 3) return { label: 'Urgent', dot: 'bg-danger', text: 'text-danger-fg' };
  if (priority === 2) return { label: 'High', dot: 'bg-warning', text: 'text-warning-fg' };
  if (priority === 1) return { label: 'Elevated', dot: 'bg-info', text: 'text-info-fg' };
  return null; // priority 0 = normal, no indicator
}

export default async function SchedulePage() {
  const sb = await createAuthedServerSupabase();

  if (!sb) {
    return (
      <Shell>
        <StateCard
          icon={<AlertCircle className="h-5 w-5 text-warning-fg" />}
          title="Sign in to view the dispatch board"
          body="Your session isn't authenticated, so we can't load work orders scoped to your organization."
          action={
            <Link
              href="/sign-in"
              className="inline-block text-sm text-brand-400 hover:text-brand-300"
            >
              Sign in
            </Link>
          }
        />
      </Shell>
    );
  }

  const [{ data: wos, error: woErr }, { data: jobRows }] = await Promise.all([
    sb
      .schema('proj')
      .from('work_orders')
      .select(
        'id, job_id, title, status, required_capability, zone, priority, estimated_minutes, assigned_employee_id, scheduled_window',
      ),
    sb.schema('core').from('jobs').select('id, job_number, name'),
  ]);

  if (woErr) {
    return (
      <Shell>
        <StateCard
          icon={<AlertCircle className="h-5 w-5 text-danger-fg" />}
          title="Couldn't load the dispatch board"
          body={woErr.message || 'The work-order query failed. Try refreshing the page.'}
        />
      </Shell>
    );
  }

  const workOrders = (wos ?? []) as WorkOrder[];
  const jobs = (jobRows ?? []) as Job[];
  const jobById = new Map<string, Job>(jobs.map((j) => [j.id, j]));

  if (workOrders.length === 0) {
    return (
      <Shell>
        <StateCard
          icon={<Inbox className="h-5 w-5 text-slate-400" />}
          title="No work orders yet"
          body="When jobs generate work orders, they'll appear here as dispatchable cards — grouped into lanes from draft through completion."
        />
      </Shell>
    );
  }

  // Bucket once. Sort each lane by priority desc, then unscheduled-first so the
  // dispatcher sees the most urgent, still-unplaced work at the top.
  const byLane = new Map<string, WorkOrder[]>();
  const laneStatuses = new Set(LANES.map((l) => l.status));
  for (const wo of workOrders) {
    const key = laneStatuses.has(wo.status) ? wo.status : 'OTHER';
    const arr = byLane.get(key) ?? [];
    arr.push(wo);
    byLane.set(key, arr);
  }
  const sortLane = (arr: WorkOrder[]) =>
    [...arr].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const as = a.scheduled_window ? 1 : 0;
      const bs = b.scheduled_window ? 1 : 0;
      return as - bs;
    });

  const otherCount = byLane.get('OTHER')?.length ?? 0;
  const columns = [
    ...LANES,
    ...(otherCount > 0 ? [{ status: 'OTHER' as const, label: 'Other' }] : []),
  ];

  const scheduledCount = workOrders.filter((w) => w.scheduled_window).length;
  const unassignedCount = workOrders.filter((w) => !w.assigned_employee_id).length;

  return (
    <Shell
      meta={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-2xs text-slate-500">
          <span>
            <span className="num text-slate-300">{workOrders.length}</span> work orders
          </span>
          <span>
            <span className="num text-slate-300">{scheduledCount}</span> scheduled
          </span>
          <span>
            <span className="num text-slate-300">{unassignedCount}</span> unassigned
          </span>
        </div>
      }
    >
      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((col) => {
          const lane = sortLane(byLane.get(col.status) ?? []);
          return (
            <section
              key={col.status}
              className="flex w-72 shrink-0 flex-col rounded-xl border border-surface-800 bg-surface-900"
            >
              <header className="flex items-center justify-between gap-2 border-b border-surface-800 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx('h-2 w-2 rounded-full', LANE_ACCENT[col.status])}
                    aria-hidden
                  />
                  <span className="text-2xs font-semibold uppercase tracking-wider text-slate-300">
                    {col.label}
                  </span>
                </div>
                <span className="num rounded-full bg-surface-950 px-2 py-0.5 text-2xs text-slate-400">
                  {lane.length}
                </span>
              </header>

              <div className="flex flex-col gap-2 p-2">
                {lane.length === 0 ? (
                  <div className="px-2 py-6 text-center text-2xs text-slate-600">No work orders</div>
                ) : (
                  lane.map((wo) => (
                    <WorkOrderCard key={wo.id} wo={wo} job={jobById.get(wo.job_id)} />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </Shell>
  );
}

function WorkOrderCard({ wo, job }: { wo: WorkOrder; job: Job | undefined }) {
  const prio = priorityMeta(wo.priority);
  const duration = formatDuration(wo.estimated_minutes);
  const scheduled = Boolean(wo.scheduled_window);

  return (
    <article
      className={clsx(
        'group rounded-lg border bg-surface-950 p-3 transition-colors',
        'border-surface-800 hover:border-brand-800',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium leading-snug text-white group-hover:text-brand-100">
          {wo.title}
        </h3>
        {prio && (
          <span className={clsx('flex shrink-0 items-center gap-1 text-2xs font-semibold', prio.text)}>
            <span className={clsx('h-1.5 w-1.5 rounded-full', prio.dot)} aria-hidden />
            {prio.label}
          </span>
        )}
      </div>

      {job && (
        <div className="mt-1 flex items-center gap-1.5 text-2xs text-slate-500">
          <span className="num text-slate-400">#{job.job_number}</span>
          <span className="truncate">{job.name}</span>
        </div>
      )}

      {(wo.required_capability || wo.zone || duration) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {wo.required_capability && (
            <Chip icon={<Wrench className="h-3 w-3" />} tone="brand">
              {wo.required_capability}
            </Chip>
          )}
          {wo.zone && (
            <Chip icon={<MapPin className="h-3 w-3" />} tone="slate">
              {wo.zone}
            </Chip>
          )}
          {duration && (
            <Chip icon={<Clock className="h-3 w-3" />} tone="slate">
              <span className="num">{duration}</span>
            </Chip>
          )}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-3 border-t border-surface-900 pt-2 text-2xs text-slate-500">
        <span className="flex items-center gap-1">
          <CalendarDays className="h-3 w-3" />
          {scheduled ? (
            <span className="text-slate-400">Scheduled</span>
          ) : (
            <span className="text-slate-600">Unscheduled</span>
          )}
        </span>
        <span className="flex items-center gap-1">
          <Flag className="h-3 w-3" />
          {wo.assigned_employee_id ? (
            <span className="text-slate-400">Assigned</span>
          ) : (
            <span className="text-slate-600">Unassigned</span>
          )}
        </span>
      </div>
    </article>
  );
}

function Chip({
  icon,
  children,
  tone,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  tone: 'brand' | 'slate';
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs',
        tone === 'brand'
          ? 'border-brand-900 bg-brand-950 text-brand-300'
          : 'border-surface-800 bg-surface-900 text-slate-400',
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function Shell({
  children,
  meta,
}: {
  children: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-brand-400" />
          <h1 className="text-title text-white">Schedule</h1>
        </div>
        <p className="text-sm text-slate-400">
          Dispatch board — every work order, lane-grouped from draft through completion.
        </p>
        {meta && <div className="pt-1">{meta}</div>}
      </header>
      {children}
    </div>
  );
}

function StateCard({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-10">
      <div className="mx-auto max-w-md space-y-3 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-surface-800 bg-surface-950">
          {icon}
        </div>
        <div className="flex items-center justify-center gap-2 text-heading font-semibold text-white">
          <ClipboardList className="h-4 w-4 text-slate-500" />
          {title}
        </div>
        <p className="text-sm text-slate-400">{body}</p>
        {action}
      </div>
    </div>
  );
}
