/**
 * Plain-language questions over operations (FS-110), rules only until AI is on: a fixed metric
 * catalog (pm.fs_metric, migration 1123) and a parser that maps a question onto one metric plus a
 * period and an optional threshold. Every answer links to the records behind it. Money metrics
 * come back masked when the person may not see them. Pure; unit-tested.
 */

export type MetricKey =
  | 'unbilled_jobs' | 'open_estimates' | 'close_rate_by_advisor' | 'recalls_by_tech' | 'deferred_revenue' | 'unfunded_financing'
  | 'low_margin_jobs' | 'revenue_by_bu' | 'memberships_expiring' | 'installs_stuck' | 'permits_pending' | 'unconfirmed_visits'
  | 'missed_calls' | 'timesheet_exceptions';

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** Example question shown in the catalog. */
  example: string;
  /** Each group must match at least one word (AND of ORs). */
  match: ReadonlyArray<RegExp>;
}

export const METRICS: readonly MetricDef[] = [
  { key: 'low_margin_jobs', label: 'Sold jobs under a margin', example: 'Which sold jobs ran under 40% margin last month?', match: [/margin/i, /(under|below|less than|<)/i] },
  { key: 'deferred_revenue', label: 'Agreement deferred revenue', example: 'How much deferred revenue do we owe in visits?', match: [/deferred|unearned/i] },
  { key: 'unbilled_jobs', label: 'Completed visits not invoiced', example: 'Which completed jobs were never invoiced?', match: [/(not|never|un)\s*(billed|invoiced)|unbilled|uninvoiced/i] },
  { key: 'open_estimates', label: 'Open estimates by age', example: 'Which open estimates are older than 3 days?', match: [/estimate|quote|proposal/i, /(open|unsold|pending|waiting|older|aging|follow)/i] },
  { key: 'close_rate_by_advisor', label: 'Close rate by comfort advisor', example: 'What is the close rate by advisor this quarter?', match: [/(close|closing|conversion)\s*rate|closed/i] },
  { key: 'recalls_by_tech', label: 'Recalls by technician', example: 'Who had the most recalls this month?', match: [/recall|callback|call-back|call back/i] },
  { key: 'unfunded_financing', label: 'Financed sales not funded', example: 'Which financed jobs are still unfunded?', match: [/financ|lender|loan|fund/i] },
  { key: 'revenue_by_bu', label: 'Revenue by business unit', example: 'Revenue by business unit last month', match: [/revenue|sales|sold/i, /(business unit|bu\b|department|by unit|by trade)/i] },
  { key: 'memberships_expiring', label: 'Memberships expiring', example: 'Which memberships expire in the next 60 days?', match: [/membership|agreement|plan/i, /(expir|renew|lapse|ending)/i] },
  { key: 'installs_stuck', label: 'Installs stuck in a stage', example: 'Which installs are stuck?', match: [/install/i, /(stuck|late|stalled|waiting|behind)/i] },
  { key: 'permits_pending', label: 'Permits not issued', example: 'Which permits are still pending?', match: [/permit/i] },
  { key: 'unconfirmed_visits', label: 'Visits tomorrow not confirmed', example: 'Who has not confirmed for tomorrow?', match: [/confirm/i] },
  { key: 'missed_calls', label: 'Missed calls', example: 'How many calls did we miss today?', match: [/call/i, /(miss|abandon|voicemail|unanswered)/i] },
  { key: 'timesheet_exceptions', label: 'Timesheet exceptions', example: 'Any timesheet problems this week?', match: [/time ?sheet|overtime|clock|hours/i] },
];

export interface ParsedQuestion {
  metric: MetricKey | null;
  from: string | null;
  to: string | null;
  threshold: number | null;
  /** What the parser understood, for the answer header ("last month · under 40 %"). */
  understood: string[];
  /** Close matches when nothing matched (or more than one did). */
  suggestions: MetricKey[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** A period from the question, relative to `today` (YYYY-MM-DD). Null when none is named. */
export function parsePeriod(q: string, today: string): { from: string; to: string; label: string } | null {
  const t = new Date(`${today}T00:00:00Z`);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const s = q.toLowerCase();
  const n = s.match(/last\s+(\d{1,3})\s+days?/);
  if (n) return { from: iso(new Date(t.getTime() - (Number(n[1]) - 1) * 86_400_000)), to: today, label: `last ${n[1]} days` };
  if (/\btoday\b/.test(s)) return { from: today, to: today, label: 'today' };
  if (/\byesterday\b/.test(s)) { const d = iso(new Date(t.getTime() - 86_400_000)); return { from: d, to: d, label: 'yesterday' }; }
  const dow = (t.getUTCDay() + 6) % 7;
  if (/\bthis week\b/.test(s)) return { from: iso(new Date(t.getTime() - dow * 86_400_000)), to: today, label: 'this week' };
  if (/\blast week\b/.test(s)) {
    const start = new Date(t.getTime() - (dow + 7) * 86_400_000);
    return { from: iso(start), to: iso(new Date(start.getTime() + 6 * 86_400_000)), label: 'last week' };
  }
  if (/\bthis month\b|\bmonth to date\b|\bmtd\b/.test(s)) return { from: iso(utc(y, m, 1)), to: today, label: 'this month' };
  if (/\blast month\b/.test(s)) return { from: iso(utc(y, m - 1, 1)), to: iso(utc(y, m, 0)), label: 'last month' };
  if (/\bthis quarter\b|\bqtd\b/.test(s)) return { from: iso(utc(y, Math.floor(m / 3) * 3, 1)), to: today, label: 'this quarter' };
  if (/\bthis year\b|\bytd\b/.test(s)) return { from: iso(utc(y, 0, 1)), to: today, label: 'this year' };
  if (/\blast year\b/.test(s)) return { from: iso(utc(y - 1, 0, 1)), to: iso(utc(y - 1, 11, 31)), label: 'last year' };
  const mi = MONTHS.findIndex((name) => new RegExp(`\\b(in\\s+)?${name}\\b`).test(s));
  if (mi >= 0) {
    const yr = mi > m ? y - 1 : y;
    return { from: iso(utc(yr, mi, 1)), to: iso(utc(yr, mi + 1, 0)), label: `${MONTHS[mi]![0]!.toUpperCase()}${MONTHS[mi]!.slice(1)} ${yr}` };
  }
  return null;
}

/** "under 40%" → 0.40 (margin); "older than 5 days" → 5. */
export function parseThreshold(q: string, metric: MetricKey | null): number | null {
  const pct = q.match(/(\d{1,2}(?:\.\d+)?)\s*(%|percent)/i);
  if (pct && metric === 'low_margin_jobs') return Number(pct[1]) / 100;
  const days = q.match(/(\d{1,3})\s*days?/i);
  if (days && metric === 'open_estimates') return Number(days[1]);
  return null;
}

export function parseQuestion(question: string, today: string): ParsedQuestion {
  const q = question.trim();
  const hits = METRICS.filter((d) => d.match.every((re) => re.test(q)));
  const metric = hits[0]?.key ?? null;
  const period = parsePeriod(q, today);
  const threshold = parseThreshold(q, metric);
  const understood: string[] = [];
  if (metric) understood.push(METRICS.find((d) => d.key === metric)!.label);
  if (period) understood.push(period.label);
  if (threshold != null) understood.push(metric === 'low_margin_jobs' ? `under ${Math.round(threshold * 100)} %` : `older than ${threshold} days`);
  const suggestions = metric ? hits.slice(1).map((h) => h.key)
    : METRICS.filter((d) => d.match.some((re) => re.test(q))).map((d) => d.key).slice(0, 4);
  return { metric, from: period?.from ?? null, to: period?.to ?? null, threshold, understood, suggestions };
}
