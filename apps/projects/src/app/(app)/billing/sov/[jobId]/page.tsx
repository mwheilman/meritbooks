import Link from 'next/link';
import { ArrowLeft, AlertTriangle, Lock, Layers } from 'lucide-react';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { SovEditor, type SovVersionDto, type SovLineDto, type ContractDto } from './sov-editor';

export const dynamic = 'force-dynamic';

// G7 Schedule of Values — the AIA-style progress-billing workspace for one job.
// A contractor maintains a versioned schedule of values, sets % complete per line
// each period, and generates a progress billing that flows through the existing
// draw/approve -> JOB_BILLING money path. This server component loads the job, its
// contract, every SOV version (proj.v_sov_status) and their lines, then hands off
// to the SovEditor client for the interactive create/edit/activate/generate flow.

// ---- Row shapes (no `any`) ---------------------------------------------------

interface JobRow {
  id: string;
  job_number: string;
  name: string;
  customer_name: string | null;
  status: string;
}

interface ContractRow {
  id: string;
  original_contract_cents: number;
  retention_pct: number;
  status: string;
}

interface SovStatusRow {
  sov_version_id: string;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  contract_id: string | null;
  line_count: number;
  scheduled_total_cents: number;
  earned_to_date_cents: number;
  remaining_cents: number;
  pct_complete_weighted: number;
}

interface SovLineRow {
  id: string;
  sov_version_id: string;
  line_no: number;
  cost_code_id: string | null;
  description: string;
  scheduled_value_cents: number;
  pct_complete: number;
  retainage_pct: number | null;
  sort_order: number;
}

interface SovVersionMemoRow {
  id: string;
  memo: string | null;
}

// ---- Page --------------------------------------------------------------------

export default async function SovPage({ params }: { params: { jobId: string } }) {
  const jobId = params.jobId;
  const sb = await createAuthedServerSupabase();

  if (!sb) {
    return (
      <Shell>
        <StateCard
          icon={<Lock className="h-5 w-5 text-slate-500" />}
          title="Sign in to view the schedule of values"
          body="Your session couldn't be resolved. This workspace is scoped to your organization and requires an authenticated session."
          action={
            <Link href="/sign-in" className="text-sm text-brand-400 hover:text-brand-300">
              Go to sign in
            </Link>
          }
        />
      </Shell>
    );
  }

  const [jobRes, contractRes, versionsRes] = await Promise.all([
    sb.schema('core').from('jobs').select('id,job_number,name,customer_name,status').eq('id', jobId).maybeSingle(),
    sb
      .schema('proj')
      .from('contracts')
      .select('id,original_contract_cents,retention_pct,status')
      .eq('job_id', jobId)
      .maybeSingle(),
    sb
      .schema('proj')
      .from('v_sov_status')
      .select(
        'sov_version_id,version,status,contract_id,line_count,scheduled_total_cents,earned_to_date_cents,remaining_cents,pct_complete_weighted',
      )
      .eq('job_id', jobId)
      .order('version', { ascending: false }),
  ]);

  const firstError = jobRes.error || contractRes.error || versionsRes.error;
  if (firstError) {
    return (
      <Shell>
        <StateCard
          icon={<AlertTriangle className="h-5 w-5 text-danger-fg" />}
          title="Couldn't load the schedule of values"
          body={firstError.message}
        />
      </Shell>
    );
  }

  const job = jobRes.data as JobRow | null;
  if (!job) {
    return (
      <Shell>
        <StateCard
          icon={<AlertTriangle className="h-5 w-5 text-warning-fg" />}
          title="Job not found"
          body="This job doesn't exist or isn't visible to your organization."
          action={
            <Link href="/billing" className="text-sm text-brand-400 hover:text-brand-300">
              Back to billing
            </Link>
          }
        />
      </Shell>
    );
  }

  const contractRow = contractRes.data as ContractRow | null;
  const versionRows = (versionsRes.data ?? []) as SovStatusRow[];
  const versionIds = versionRows.map((v) => v.sov_version_id);

  // Lines + per-version memo for every version (small N; one round-trip each).
  const [linesRes, memoRes] = await Promise.all([
    versionIds.length
      ? sb
          .schema('proj')
          .from('sov_lines')
          .select('id,sov_version_id,line_no,cost_code_id,description,scheduled_value_cents,pct_complete,retainage_pct,sort_order')
          .in('sov_version_id', versionIds)
          .order('sort_order', { ascending: true })
          .order('line_no', { ascending: true })
      : Promise.resolve({ data: [] as SovLineRow[], error: null }),
    versionIds.length
      ? sb.schema('proj').from('sov_versions').select('id,memo').in('id', versionIds)
      : Promise.resolve({ data: [] as SovVersionMemoRow[], error: null }),
  ]);

  if (linesRes.error || memoRes.error) {
    return (
      <Shell>
        <StateCard
          icon={<AlertTriangle className="h-5 w-5 text-danger-fg" />}
          title="Couldn't load schedule lines"
          body={(linesRes.error || memoRes.error)?.message ?? 'Unknown error'}
        />
      </Shell>
    );
  }

  const memoById = new Map<string, string | null>(
    ((memoRes.data ?? []) as SovVersionMemoRow[]).map((m) => [m.id, m.memo]),
  );

  const versions: SovVersionDto[] = versionRows.map((v) => ({
    id: v.sov_version_id,
    version: Number(v.version),
    status: v.status,
    memo: memoById.get(v.sov_version_id) ?? null,
    lineCount: Number(v.line_count),
    scheduledTotalCents: Number(v.scheduled_total_cents),
    earnedToDateCents: Number(v.earned_to_date_cents),
    remainingCents: Number(v.remaining_cents),
    pctCompleteWeighted: Number(v.pct_complete_weighted),
  }));

  const linesByVersion: Record<string, SovLineDto[]> = {};
  for (const row of (linesRes.data ?? []) as SovLineRow[]) {
    (linesByVersion[row.sov_version_id] ||= []).push({
      id: row.id,
      lineNo: Number(row.line_no),
      description: row.description,
      scheduledValueCents: Number(row.scheduled_value_cents),
      pctComplete: Number(row.pct_complete),
      retainagePct: row.retainage_pct === null ? null : Number(row.retainage_pct),
      sortOrder: Number(row.sort_order),
    });
  }

  const contract: ContractDto | null = contractRow
    ? {
        originalContractCents: Number(contractRow.original_contract_cents),
        retentionPct: Number(contractRow.retention_pct),
        status: contractRow.status,
      }
    : null;

  return (
    <Shell>
      <SovEditor
        job={{ id: job.id, jobNumber: job.job_number, name: job.name, customerName: job.customer_name }}
        contract={contract}
        versions={versions}
        linesByVersion={linesByVersion}
      />
    </Shell>
  );
}

// ---- Presentational shell ----------------------------------------------------

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-8">
      <Link
        href="/billing"
        className="inline-flex items-center gap-1.5 text-2xs uppercase tracking-wider text-slate-500 hover:text-slate-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Billing
      </Link>
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
    <div className="rounded-xl border border-surface-800 bg-surface-900 p-8 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-surface-800 bg-surface-950">
        {icon ?? <Layers className="h-5 w-5 text-slate-500" />}
      </div>
      <div className="mt-3 text-sm font-medium text-white">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
