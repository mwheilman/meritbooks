import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsCall } from '@/lib/fieldservice/rpc';
import { loadFindings, rpcLoad } from '@/lib/fieldservice/completion';
import type { Dashboard, MetricAnswer } from '@/lib/fieldservice/completion-types';
import { METRICS, parseQuestion, type MetricKey } from '@/lib/fieldservice/qa';
import { todayIso } from '@/lib/time';
import { Day, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Role dashboards (FS-109), plain-language questions (FS-110, rules-only metric catalog until AI is
 * switched on) and the billing integrity auditor (FS-112). Money is stripped inside the database
 * for anyone who may not see it; a money metric then answers "masked" with no rows.
 */
const Q = z.object({ companyId: Uuid, role: z.enum(['gm', 'dispatcher', 'service_manager', 'install_pm']).default('gm'), from: Day.optional(), to: Day.optional() });

export const GET = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, query: Q }, async ({ db, tenant, query }) => {
  assertCompany(tenant, query.companyId);
  const [dash, findings] = await Promise.all([
    rpcLoad<Dashboard | null>(db, 'fs_dashboard', { p_location: query.companyId, p_role: query.role, p_from: query.from ?? null, p_to: query.to ?? null }, null),
    loadFindings(db, query.companyId),
  ]);
  return { dashboard: dash.data, error: dash.error, findings: findings.data, metrics: METRICS.map((m) => ({ key: m.key, label: m.label, example: m.example })) };
});

const MetricZ = z.enum(METRICS.map((m) => m.key) as [MetricKey, ...MetricKey[]]);
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ask'), companyId: Uuid, question: z.string().trim().min(3).max(300) }),
  z.object({ op: z.literal('metric'), companyId: Uuid, metric: MetricZ, from: Day.nullish(), to: Day.nullish(), threshold: z.number().min(0).max(1000).nullish() }),
  z.object({ op: z.literal('audit'), companyId: Uuid, since: Day.nullish() }),
  z.object({ op: z.literal('task'), findingId: Uuid }),
  z.object({ op: z.literal('dismiss'), findingId: Uuid, reason: z.string().trim().min(3).max(500) }),
]);

export const POST = route({ access: { cap: 'projects.dispatch', action: 'view' }, mask: false, body: Body }, async ({ db, body }) => {
  switch (body.op) {
    case 'ask': {
      const p = parseQuestion(body.question, todayIso());
      if (!p.metric) return { understood: p.understood, answer: null, suggestions: METRICS.filter((m) => p.suggestions.includes(m.key) || p.suggestions.length === 0).slice(0, 6).map((m) => ({ key: m.key, example: m.example })) };
      const answer = await fsCall<MetricAnswer>(db, 'fs_metric', { p_location: body.companyId, p_metric: p.metric, p_from: p.from, p_to: p.to, p_threshold: p.threshold });
      return { understood: p.understood, answer, suggestions: [] };
    }
    case 'metric':
      return { answer: await fsCall<MetricAnswer>(db, 'fs_metric', { p_location: body.companyId, p_metric: body.metric, p_from: body.from ?? null, p_to: body.to ?? null, p_threshold: body.threshold ?? null }) };
    case 'audit':
      return { counts: await fsCall<Record<string, number>>(db, 'fs_run_integrity', { p_location: body.companyId, p_since: body.since ?? null }) };
    case 'task':
      return { taskId: await fsCall<string>(db, 'fs_task_finding', { p_finding: body.findingId, p_assignee_user: null }) };
    case 'dismiss':
      return { id: await fsCall<string>(db, 'fs_dismiss_finding', { p_finding: body.findingId, p_reason: body.reason }) };
  }
});

