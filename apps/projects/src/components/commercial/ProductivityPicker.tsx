'use client';

import { useRouter } from 'next/navigation';
import { Field, WidgetState } from '@meritbooks/merit-ui';
import type { JobOption } from '@/lib/pm/ops/scope';
import { JobSelect } from '@/components/ops/common/bits';
import { ProductivityBoard } from './ProductivityView';

/** The productivity screen: pick a job, then its board (the URL keeps the job). */
export function ProductivityPicker({ jobs, jobId, today, canLog, canSetUnits, canFade }: { jobs: JobOption[]; jobId: string | null; today: string; canLog: boolean; canSetUnits: boolean; canFade: boolean }) {
  const router = useRouter();
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="ops-toolbar"><Field label="Job"><JobSelect jobs={jobs} value={jobId ?? ''} onChange={(id) => router.push(id ? `/productivity?job=${id}` : '/productivity')} /></Field></div>
      {jobId ? <ProductivityBoard key={jobId} jobId={jobId} today={today} canLog={canLog} canSetUnits={canSetUnits} canFade={canFade} />
        : <div className="mp-table"><WidgetState state={{ kind: 'empty', title: 'Pick a job', body: 'Its cost codes show earned against actual hours, with the foreman’s installed quantities and the weekly fade check.' }} /></div>}
    </div>
  );
}
