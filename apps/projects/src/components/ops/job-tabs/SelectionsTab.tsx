import { WidgetState } from '@meritbooks/merit-ui';
import { requireDb } from '@/lib/pm/db';
import { loadSelectionBundle } from '@/lib/pm/ops/selection-load';
import { hasModule, jobOption, packKeyOf, type JobTabProps } from '@/lib/pm/ops/job-tab';
import { MODULES } from '@/lib/packs';
import { todayIso } from '@/lib/time';
import { SelectionsView } from '../selections/SelectionsView';
import '../ops.css';

/** Job tab: the client's selections on this job, its purchasing items and flooring measures. */
export async function SelectionsTab({ jobId, companyId, modules }: JobTabProps) {
  const db = await requireDb();
  const [job, packKey] = await Promise.all([jobOption(db, jobId), packKeyOf(db, companyId)]);
  if (!job) return <div className="surface"><WidgetState state={{ kind: 'error', title: 'This job did not load', body: 'Refresh the page; if it repeats, tell support.' }} /></div>;
  const on = MODULES.filter((m) => hasModule(modules, m));
  const b = await loadSelectionBundle(db, { companyIds: [companyId], jobId }, { modules: on.length ? on : ['selections'], packKeys: [packKey], inScope: (id) => id === jobId });
  const tabs = b.tabs.length ? b.tabs : (['selections'] as const);
  return (
    <SelectionsView
      tabs={[...tabs]}
      initialTab={tabs[0]!}
      selections={b.selections}
      procurement={b.procurement}
      measures={b.measures}
      areas={b.areas}
      totals={b.totals}
      jobs={[job]}
      vendors={b.vendors}
      storage={b.storage}
      today={todayIso()}
      initialJobId={jobId}
      focusId={null}
      fixedJobId={jobId}
    />
  );
}
