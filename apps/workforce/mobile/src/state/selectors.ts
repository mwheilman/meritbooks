/** Small read helpers over the cached field bundle. Pure. */
import type { FieldAssignment, FieldJob, FieldTask, FieldToday } from '@/core/contract';

export function jobById(t: FieldToday | null, id: string | null | undefined): FieldJob | null {
  if (!t || !id) return null;
  return t.jobs.find((j) => j.id === id) ?? null;
}

const OPEN_VISIT = (a: FieldAssignment) => a.status !== 'DONE' && a.status !== 'CANCELLED';

export function visitsOn(t: FieldToday | null, day: string): FieldAssignment[] {
  return (t?.assignments ?? []).filter((a) => a.day === day);
}

/** The visit to work on now: the first open one today. */
export function currentVisit(t: FieldToday | null): FieldAssignment | null {
  return visitsOn(t, t?.today ?? '').find(OPEN_VISIT) ?? null;
}

export function tasksOn(t: FieldToday | null, day: string): FieldTask[] {
  return (t?.tasks ?? []).filter((k) => k.status === 'IN_PROGRESS' ? day === t?.today : (!k.startOn || k.startOn <= day) && (!k.dueOn || k.dueOn >= day));
}

/** Cost code from the schedule: my task on the job today first, then any task on it with a code. */
export function scheduleCostCode(t: FieldToday | null, jobId: string | null): string | null {
  if (!t || !jobId) return null;
  const onJob = tasksOn(t, t.today).filter((k) => k.jobId === jobId && k.costCodeId);
  return (onJob.find((k) => k.mine) ?? onJob[0])?.costCodeId ?? null;
}

export function costCodesFor(t: FieldToday | null, jobId: string | null): FieldToday['costCodes'] {
  const job = jobById(t, jobId);
  if (!t || !job) return [];
  return t.costCodes.filter((c) => c.companyId === job.companyId && (!c.jobId || c.jobId === job.id));
}

export function timeOf(iso: string | null, lang: 'en' | 'es'): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString(lang === 'es' ? 'es-US' : 'en-US', { hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(day: string, lang: 'en' | 'es'): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

export function agoText(ms: number | null, lang: 'en' | 'es'): string {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60_000);
  if (lang === 'es') return min < 1 ? 'ahora' : min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

export function hoursText(h: number): string {
  return (Math.round(h * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * The jobs whose current drawing set the phone keeps: jobs with sheets that I work on in the
 * three-day window (visits, tasks, the shift), today's first; else the first ten with sheets.
 */
export function drawingJobs(t: FieldToday | null, drawings: Readonly<Record<string, number>> | null | undefined, shiftJobId: string | null = null): { jobs: string[]; priority: string[] } {
  if (!t || !drawings) return { jobs: [], priority: [] };
  const has = (id: string) => (drawings[id] ?? 0) > 0;
  const todayJobs = [shiftJobId, ...t.assignments.filter((a) => a.day === t.today).map((a) => a.jobId)].filter((x): x is string => !!x);
  const windowJobs = [...todayJobs, ...t.assignments.map((a) => a.jobId), ...t.tasks.filter((k) => k.mine).map((k) => k.jobId)];
  let jobs = [...new Set(windowJobs)].filter(has);
  if (!jobs.length) jobs = t.jobs.map((j) => j.id).filter(has).slice(0, 10);
  return { jobs: jobs.slice(0, 30), priority: [...new Set(todayJobs)] };
}
