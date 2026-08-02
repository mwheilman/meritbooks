import Link from 'next/link';
import {
  AlertTriangle, TriangleAlert, ShieldAlert, FileWarning, ArrowUpRight,
  Building2, Wrench, Factory, CircleDot,
} from 'lucide-react';
import { currentOrgId, getEntitlements } from '@/lib/entitlements';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';

export const dynamic = 'force-dynamic';

/* ------------------------------------------------------------------ money ---- */
const n = (v: unknown): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v) || 0);
function compact(c: number): string {
  const d = c / 100, a = Math.abs(d);
  if (a >= 1_000_000) return `$${(d / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `$${Math.round(d / 1_000)}K`;
  return `$${Math.round(d)}`;
}
const pctLabel = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);

/* ------------------------------------------------------------------ types ---- */
interface Margin {
  job_id: string; job_number: string | null; name: string | null;
  revenue_contract_cents: number; operational_actual_cents: number; operational_pending_cents: number;
  committed_open_cents: number; projected_final_cents: number;
  operational_margin_pct: number | null; budget_remaining_cents: number;
}
interface JobMeta { id: string; archetype: string | null; status: string | null; customer_name: string | null; }
interface Contract { job_id: string; pct_complete: number | null; }
interface Slip { job_id: string; variance_cents: number; }
interface Gate { id: string; job_id: string; name: string | null; gate_type: string; status: string; blocks_billing: boolean; }
interface Draw { id: string; job_id: string; status: string; billing_type: string; }

type Sev = 'critical' | 'warning' | 'info';
interface Attn { sev: Sev; job_id: string; icon: React.ComponentType<{ className?: string }>; head: string; sub: string; impact: string; }

/* ------------------------------------------------------------------ page ----- */
export default async function Dashboard() {
  const orgId = await currentOrgId();
  const ents = await getEntitlements(orgId);
  const sb = await createAuthedServerSupabase();

  if (!sb) {
    return <Shell subtitle="Connecting to the suite…"><Empty label="Signing you in — one moment." /></Shell>;
  }

  const [mRes, jRes, cRes, sRes, gRes, dRes] = await Promise.all([
    sb.schema('proj').from('v_job_margin').select('job_id, job_number, name, revenue_contract_cents, operational_actual_cents, operational_pending_cents, committed_open_cents, projected_final_cents, operational_margin_pct, budget_remaining_cents'),
    sb.schema('core').from('jobs').select('id, archetype, status, customer_name'),
    sb.schema('proj').from('v_contract_current').select('job_id, pct_complete'),
    sb.schema('proj').from('v_cost_code_slippage').select('job_id, variance_cents'),
    sb.schema('proj').from('external_gates').select('id, job_id, name, gate_type, status, blocks_billing'),
    sb.schema('proj').from('billing_requests').select('id, job_id, status, billing_type'),
  ]);

  const loadErr = mRes.error || jRes.error;
  if (loadErr) return <Shell subtitle="Portfolio overview"><ErrorCard msg={loadErr.message} /></Shell>;

  const margins = (mRes.data ?? []) as Margin[];
  const meta = new Map(((jRes.data ?? []) as JobMeta[]).map((j) => [j.id, j]));
  const pctById = new Map(((cRes.data ?? []) as Contract[]).map((c) => [c.job_id, c.pct_complete]));
  const slips = (sRes.data ?? []) as Slip[];
  const gates = (gRes.data ?? []) as Gate[];
  const draws = (dRes.data ?? []) as Draw[];

  if (margins.length === 0) {
    return <Shell subtitle="Portfolio overview">
      <Empty label="No active jobs yet. Won opportunities become jobs here — provisioning writes the first contract." />
    </Shell>;
  }

  /* ---- portfolio pulse ---- */
  const contract = margins.reduce((s, m) => s + n(m.revenue_contract_cents), 0);
  const cost = margins.reduce((s, m) => s + n(m.operational_actual_cents), 0);
  const pending = margins.reduce((s, m) => s + n(m.operational_pending_cents), 0);
  const committed = margins.reduce((s, m) => s + n(m.committed_open_cents), 0);
  const projFinal = margins.reduce((s, m) => s + n(m.projected_final_cents), 0);
  const projMargin = contract - projFinal;
  const projMarginPct = contract > 0 ? (projMargin / contract) * 100 : null;
  const activeJobs = margins.filter((m) => meta.get(m.job_id)?.status === 'ACTIVE').length || margins.length;
  const openGates = gates.filter((g) => !['CLEARED', 'WAIVED'].includes(g.status));
  const draftDraws = draws.filter((d) => d.status === 'DRAFT');

  /* ---- the signature: reasoned cross-domain attention feed ---- */
  const attn: Attn[] = [];
  for (const m of margins) {
    const label = `${m.job_number ?? ''} · ${m.name ?? 'Job'}`;
    const pm = n(m.revenue_contract_cents) - n(m.projected_final_cents);
    if (pm < 0) {
      attn.push({ sev: 'critical', job_id: m.job_id, icon: TriangleAlert, head: 'Projected loss', sub: label, impact: `−${compact(Math.abs(pm))}` });
    } else if (m.operational_margin_pct != null && m.operational_margin_pct < 12) {
      attn.push({ sev: 'warning', job_id: m.job_id, icon: AlertTriangle, head: `Thin margin · ${pctLabel(m.operational_margin_pct)}`, sub: label, impact: compact(pm) });
    }
  }
  const overByJob = new Map<string, { amt: number; codes: number }>();
  for (const s of slips) {
    if (n(s.variance_cents) < 0) {
      const e = overByJob.get(s.job_id) ?? { amt: 0, codes: 0 };
      e.amt += Math.abs(n(s.variance_cents)); e.codes += 1;
      overByJob.set(s.job_id, e);
    }
  }
  for (const [job_id, e] of overByJob) {
    const m = margins.find((x) => x.job_id === job_id);
    attn.push({ sev: 'warning', job_id, icon: FileWarning, head: `${e.codes} cost code${e.codes > 1 ? 's' : ''} over budget`, sub: `${m?.job_number ?? ''} · ${m?.name ?? ''}`, impact: `−${compact(e.amt)}` });
  }
  for (const g of openGates.filter((x) => x.blocks_billing)) {
    const m = margins.find((x) => x.job_id === g.job_id);
    attn.push({ sev: 'info', job_id: g.job_id, icon: ShieldAlert, head: `${g.name ?? g.gate_type} — blocks billing`, sub: `${m?.job_number ?? ''} · ${m?.name ?? ''} · ${g.status.toLowerCase()}`, impact: 'gate' });
  }
  for (const d of draftDraws) {
    const m = margins.find((x) => x.job_id === d.job_id);
    if (m) attn.push({ sev: 'info', job_id: d.job_id, icon: CircleDot, head: 'Draw ready — not yet issued', sub: `${m.job_number ?? ''} · ${m.name ?? ''}`, impact: 'draft' });
  }
  const rank: Record<Sev, number> = { critical: 0, warning: 1, info: 2 };
  attn.sort((a, b) => rank[a.sev] - rank[b.sev]);

  const jobs = [...margins].sort((a, b) => n(b.revenue_contract_cents) - n(a.revenue_contract_cents));

  return (
    <Shell subtitle="Live operational picture across the portfolio — cost, margin, and what needs a decision today.">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-2xs uppercase tracking-[0.14em] text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-brand-400" />Online</span>
        <span>Entitlement · <span className="text-slate-300">{ents.projects ? 'projects' : '—'}</span></span>
        <span>Ledger · <span className="text-slate-300">{ents.books ? 'Books present' : 'Standalone'}</span></span>
      </div>

      <section className="rounded-2xl border border-surface-800 bg-surface-900 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-2xs uppercase tracking-[0.14em] text-slate-500">Contracted backlog</div>
            <div className="mt-1 font-mono text-[2.4rem] leading-none tabular-nums text-white">{compact(contract)}</div>
            <div className="mt-1 text-xs text-slate-500">{jobs.length} jobs · {compact(cost)} cost to date · {compact(committed)} committed open</div>
          </div>
          <div className="text-right">
            <div className="text-2xs uppercase tracking-[0.14em] text-slate-500">Projected margin</div>
            <div className={`mt-1 font-mono text-[2.4rem] leading-none tabular-nums ${projMargin >= 0 ? 'text-brand-400' : 'text-danger-fg'}`}>{compact(projMargin)}</div>
            <div className="mt-1 text-xs text-slate-500">{pctLabel(projMarginPct)} of contract at projected final</div>
          </div>
        </div>
        <PulseBar contract={contract} cost={cost} committed={committed} pending={pending} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <section className="lg:col-span-2 rounded-2xl border border-surface-800 bg-surface-900">
          <div className="flex items-center justify-between px-5 py-4 border-b border-surface-800">
            <h2 className="text-heading text-white">Needs attention</h2>
            <span className="text-2xs uppercase tracking-[0.14em] text-slate-500">{attn.length} items · by severity</span>
          </div>
          {attn.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">Nothing at risk. Every job is on margin, no gate is blocking a draw, and there’s no unbilled earned work.</div>
          ) : (
            <ul className="divide-y divide-surface-800">
              {attn.slice(0, 8).map((a, i) => {
                const c = a.sev === 'critical' ? 'text-danger-fg' : a.sev === 'warning' ? 'text-warning-fg' : 'text-info-fg';
                const rail = a.sev === 'critical' ? 'border-danger' : a.sev === 'warning' ? 'border-warning' : 'border-info';
                const Icon = a.icon;
                const showImpact = a.impact !== 'gate' && a.impact !== 'draft';
                return (
                  <li key={i}>
                    <Link href={`/jobs/${a.job_id}`} className={`flex items-center gap-4 border-l-2 ${rail} px-5 py-3 hover:bg-surface-850 transition-colors`}>
                      <Icon className={`h-4 w-4 shrink-0 ${c}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-white">{a.head}</div>
                        <div className="truncate text-2xs uppercase tracking-wider text-slate-500">{a.sub}</div>
                      </div>
                      {showImpact && <div className={`font-mono text-sm tabular-nums ${a.impact.startsWith('−') ? 'text-danger-fg' : 'text-slate-400'}`}>{a.impact}</div>}
                      <ArrowUpRight className="h-3.5 w-3.5 text-slate-600" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="grid grid-cols-2 gap-3 content-start">
          <Kpi label="Active jobs" value={String(activeJobs)} />
          <Kpi label="Open permits" value={String(openGates.length)} tone={openGates.length ? 'warning' : undefined} />
          <Kpi label="Cost to date" value={compact(cost)} />
          <Kpi label="Committed open" value={compact(committed)} />
          <Kpi label="Pending cost" value={compact(pending)} />
          <Kpi label="Draws to issue" value={String(draftDraws.length)} tone={draftDraws.length ? 'info' : undefined} />
        </section>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-heading text-white">Jobs</h2>
          <Link href="/jobs" className="text-xs text-brand-400 hover:text-brand-300">All jobs →</Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {jobs.map((m) => (
            <JobCard key={m.job_id} m={m} meta={meta.get(m.job_id)} pctc={pctById.get(m.job_id) ?? null} />
          ))}
        </div>
      </section>
    </Shell>
  );
}

/* --------------------------------------------------------------- components -- */
function Shell({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-title text-white">Portfolio</h1>
        <p className="max-w-2xl text-sm text-slate-400">{subtitle}</p>
      </header>
      {children}
    </div>
  );
}

function PulseBar({ contract, cost, committed, pending }: { contract: number; cost: number; committed: number; pending: number }) {
  const base = Math.max(contract, cost + committed + pending, 1);
  const seg = (v: number) => `${Math.min(100, (v / base) * 100)}%`;
  const remaining = Math.max(contract - cost - pending - committed, 0);
  return (
    <div className="mt-5">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-950">
        <div className="bg-brand-500" style={{ width: seg(cost) }} title="Cost to date" />
        <div className="bg-warning" style={{ width: seg(pending) }} title="Pending cost" />
        <div className="bg-surface-300/30" style={{ width: seg(committed) }} title="Committed open" />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-2xs text-slate-500">
        <Legend c="bg-brand-500" t={`Cost to date ${compact(cost)}`} />
        <Legend c="bg-warning" t={`Pending ${compact(pending)}`} />
        <Legend c="bg-surface-300/30" t={`Committed open ${compact(committed)}`} />
        <Legend c="border border-surface-700" t={`Remaining to contract ${compact(remaining)}`} />
      </div>
    </div>
  );
}
function Legend({ c, t }: { c: string; t: string }) {
  return <span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-sm ${c}`} />{t}</span>;
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'warning' | 'info' }) {
  const color = tone === 'warning' ? 'text-warning-fg' : tone === 'info' ? 'text-info-fg' : 'text-white';
  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-4">
      <div className="text-2xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={`mt-1.5 font-mono text-2xl leading-none tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

const ARCH: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string }> = {
  project: { icon: Building2, label: 'Project' },
  field_service: { icon: Wrench, label: 'Field service' },
  ETO: { icon: Factory, label: 'ETO' },
};

function JobCard({ m, meta, pctc }: { m: Margin; meta?: JobMeta; pctc: number | null }) {
  const contract = n(m.revenue_contract_cents);
  const cost = n(m.operational_actual_cents);
  const committed = n(m.committed_open_cents);
  const projFinal = n(m.projected_final_cents);
  const marginPct = m.operational_margin_pct;
  const loss = contract > 0 && projFinal > contract;
  const base = Math.max(contract, projFinal, 1);
  const w = (v: number) => `${Math.min(100, (v / base) * 100)}%`;
  const a = meta?.archetype ? ARCH[meta.archetype] : undefined;
  const Icon = a?.icon ?? Building2;
  const progress = pctc == null ? null : Math.round(pctc * 100);

  return (
    <Link href={`/jobs/${m.job_id}`} className="group block rounded-2xl border border-surface-800 bg-surface-900 p-5 hover:border-surface-700 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white group-hover:text-brand-300">{m.name ?? 'Job'}</div>
          <div className="mt-0.5 truncate text-2xs uppercase tracking-wider text-slate-500">{m.job_number} · {meta?.customer_name ?? '—'}</div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 rounded-md border border-surface-700 px-2 py-1 text-2xs text-slate-400">
          <Icon className="h-3 w-3" />{a?.label ?? meta?.archetype ?? '—'}
        </span>
      </div>

      <div className="mt-4">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-950">
          <div className={loss ? 'bg-danger' : 'bg-brand-500'} style={{ width: w(cost) }} title="Cost to date" />
          <div className="bg-surface-300/25" style={{ width: w(committed) }} title="Committed open" />
        </div>
        <div className="mt-2 flex items-center justify-between text-2xs text-slate-500">
          <span>{compact(cost)} cost · {compact(committed)} committed</span>
          <span>{compact(contract)} contract</span>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div>
          <div className="text-2xs uppercase tracking-[0.14em] text-slate-500">Proj. margin</div>
          <div className={`font-mono text-lg tabular-nums ${marginPct != null && marginPct < 0 ? 'text-danger-fg' : 'text-brand-400'}`}>{pctLabel(marginPct)}</div>
        </div>
        <div className="text-right">
          <div className="text-2xs uppercase tracking-[0.14em] text-slate-500">Complete</div>
          <div className="font-mono text-lg tabular-nums text-slate-200">{progress == null ? '—' : `${progress}%`}</div>
        </div>
      </div>
    </Link>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="rounded-2xl border border-dashed border-surface-800 bg-surface-900 px-6 py-12 text-center text-sm text-slate-500">{label}</div>;
}
function ErrorCard({ msg }: { msg: string }) {
  return (
    <div className="rounded-2xl border border-danger/40 bg-danger/5 px-6 py-5">
      <div className="text-sm font-medium text-danger-fg">Couldn’t load the portfolio</div>
      <div className="mt-1 font-mono text-xs text-slate-400">{msg}</div>
    </div>
  );
}
