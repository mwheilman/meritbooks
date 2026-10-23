'use client';

import { ButtonLink } from '@meritbooks/merit-ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { RecognitionPolicyCard } from '@/components/rev-rec/recognition-policy-card';

/**
 * Settings → Revenue recognition. The same "How do you recognize revenue?" election card as
 * Revenue recognition → Policy (FPB-rev-rec-wip §6), for the selected company.
 */
export function RevRecConfig() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row row--between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <p className="t-body ink-2">
          Method resolves per job: <b>job</b> → <b>revenue type / job type</b> → <b>company default</b>. The month-end entry is reviewed on the WIP schedule.
        </p>
        <ButtonLink href="/jobs/wip" variant="quiet" iconAfter="right">WIP schedule</ButtonLink>
      </div>
      <CompanyScopeGuard title="Pick a company to set its revenue policy">
        <RecognitionPolicyCard />
      </CompanyScopeGuard>
    </div>
  );
}
