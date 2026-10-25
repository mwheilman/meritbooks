'use client';

import { useState } from 'react';
import { Seg, useQuery } from '@meritbooks/merit-ui';
import type { BuyoutPackage } from '@/lib/commercial/screen-logic';
import type { ChecklistTemplate, Incident, Inspection, Jha, Observation, ToolboxTalk } from '@/lib/commercial/screen-types';
import type { JobOption } from '@/lib/pm/ops/scope';
import { todayIso } from '@/lib/time';
import { useCan, useShell } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { BuyoutView } from '@/components/commercial/BuyoutView';
import { CloseoutJob } from '@/components/commercial/CloseoutView';
import { InspectionsView } from '@/components/commercial/InspectionsView';
import { ObservationsView } from '@/components/commercial/ObservationsView';
import { ProductivityBoard } from '@/components/commercial/ProductivityView';
import { SafetyView } from '@/components/commercial/SafetyView';
import { Loaded, Sec } from './common';

/**
 * Commercial job tabs (1120): the same screens as the commercial areas, narrowed to one job and
 * fetched from /api/commercial/* — labor productivity and installed quantities, the buyout log,
 * closeout and the close gate, safety with inspections and observations. Each read is the
 * caller's own RLS at the job's company; money follows the shell (MoneyScope on the job page).
 */

/** The one job these tabs work on, as the commercial views take it. */
function thisJob(jobId: string, companyId: string | null): JobOption[] {
  return [{ id: jobId, label: 'This job', companyId: companyId ?? '', company: null, customerId: null, customer: null, open: true, jobTypeKey: '' }];
}

export function ProductivityTab({ jobId }: { jobId: string }) {
  const canLog = useCan('projects.time:create');
  const canUnits = useCan('projects.jobs:edit');
  const canFade = useCan('projects.time:approve');
  const { readOnly } = useShell();
  return (
    <Sec title="Labor productivity" meta="Installed quantities against hours used, by cost code — hours only">
      <ProductivityBoard jobId={jobId} today={todayIso()} canLog={!readOnly && canLog} canSetUnits={!readOnly && canUnits} canFade={!readOnly && canFade} />
    </Sec>
  );
}

export function BuyoutTab({ jobId, canSeed }: { jobId: string; canSeed: boolean }) {
  const { run, busy } = useAction();
  const q = useQuery<{ packages: BuyoutPackage[] }>('/api/commercial/buyout', { jobId }, { scope: false });
  const seed = async () => {
    const r = await run<{ seeded: number }>('seed', 'post', '/api/commercial/buyout', { jobId }, (d) => `Added ${d.seeded} buyout ${d.seeded === 1 ? 'package' : 'packages'} from the budget`);
    if (!r.error) await q.refetch();
  };
  return (
    <Sec title="Buyout" meta="Budget against what each package was bought for">
      <Loaded q={q} what="the buyout log">
        {(d) => <BuyoutView packages={d.packages} today={todayIso()} canEdit={canSeed} onSeed={busy === 'seed' ? undefined : () => void seed()} onChanged={() => void q.refetch()} />}
      </Loaded>
    </Sec>
  );
}

export function CloseoutTab({ jobId, canEdit }: { jobId: string; canEdit: boolean }) {
  const canClose = useCan('projects.settings:configure');
  const { readOnly } = useShell();
  return (
    <Sec title="Closeout" meta="The closeout package by sub, and what still blocks closing the job">
      <CloseoutJob jobId={jobId} today={todayIso()} canEdit={canEdit} canClose={!readOnly && canClose} />
    </Sec>
  );
}

type SafetyPart = 'safety' | 'inspections' | 'observations';
interface SafetyData { talks: ToolboxTalk[]; jhas: Jha[]; incidents: Incident[]; incidentsVisible?: boolean }

export function SafetyTab({ jobId }: { jobId: string }) {
  const [part, setPart] = useState<SafetyPart>('safety');
  return (
    <Sec title="Safety and quality" meta="Toolbox talks, pre-task plans, incidents, inspections and observations on this job"
      actions={<Seg aria-label="Safety and quality" value={part} onChange={setPart} items={[{ value: 'safety', label: 'Safety' }, { value: 'inspections', label: 'Inspections' }, { value: 'observations', label: 'Observations' }]} />}>
      {part === 'safety' && <SafetyPartView jobId={jobId} />}
      {part === 'inspections' && <InspectionsPart jobId={jobId} />}
      {part === 'observations' && <ObservationsPart jobId={jobId} />}
    </Sec>
  );
}

function SafetyPartView({ jobId }: { jobId: string }) {
  const { activeCompanyId } = useShell();
  const canRecord = useCan('projects.documents:create');
  const canIncident = useCan('projects.jobs:edit');
  const seesInjury = useCan('projects.team:view');
  const s = useQuery<SafetyData>('/api/commercial/safety', { jobId }, { scope: false });
  const o = useQuery<{ observations: Observation[] }>('/api/commercial/observations', { jobId }, { scope: false });
  return (
    <Loaded q={s} what="safety records">
      {(d) => (
        <SafetyView talks={d.talks} jhas={d.jhas} incidents={seesInjury ? d.incidents : []} incidentsVisible={seesInjury && d.incidentsVisible !== false}
          hazards={(o.data?.observations ?? []).filter((x) => x.obs_type === 'SAFETY' && (x.status === 'OPEN' || x.status === 'IN_PROGRESS')).map((x) => x.hazard ?? x.title)}
          jobs={thisJob(jobId, activeCompanyId)} companies={[]} today={todayIso()} canRecord={canRecord} canIncident={canIncident} onChanged={() => void s.refetch()} />
      )}
    </Loaded>
  );
}

function InspectionsPart({ jobId }: { jobId: string }) {
  const { activeCompanyId } = useShell();
  const canEdit = useCan('projects.jobs:edit');
  const q = useQuery<{ inspections: Inspection[]; templates: ChecklistTemplate[] }>('/api/commercial/inspections', { jobId }, { scope: false });
  return (
    <Loaded q={q} what="inspections">
      {(d) => <InspectionsView inspections={d.inspections} templates={d.templates} jobs={thisJob(jobId, activeCompanyId)} today={todayIso()} canEdit={canEdit} onChanged={() => void q.refetch()} />}
    </Loaded>
  );
}

function ObservationsPart({ jobId }: { jobId: string }) {
  const { activeCompanyId } = useShell();
  const canEdit = useCan('projects.jobs:edit');
  const q = useQuery<{ observations: Observation[] }>('/api/commercial/observations', { jobId }, { scope: false });
  const dir = useQuery<{ entries: Array<{ vendor_id: string | null; company_name: string | null }> }>('/api/commercial/directory', { jobId }, { scope: false });
  const vendors = [...new Map((dir.data?.entries ?? []).filter((e) => e.vendor_id).map((e) => [e.vendor_id!, { id: e.vendor_id!, name: e.company_name ?? 'Subcontractor' }])).values()];
  return (
    <Loaded q={q} what="observations">
      {(d) => <ObservationsView observations={d.observations} jobs={thisJob(jobId, activeCompanyId)} vendors={vendors} today={todayIso()} canEdit={canEdit} canChange={canEdit} onChanged={() => void q.refetch()} />}
    </Loaded>
  );
}
