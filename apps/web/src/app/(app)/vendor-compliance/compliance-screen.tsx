'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Icon, PageHead } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { VendorComplianceTabs } from './vendor-compliance-tabs';
import { ComplianceTab } from './compliance-tab';
import { ReviewTab } from './review-tab';
import { RequirementsTab } from './requirements-tab';
import { BankChangesTab } from './bank-changes-tab';
import { ChaseDrawer } from './chase-drawer';
import { LegacyIsland } from '@/components/layout/legacy-scope';
import { Compliance1099Client } from '../compliance-1099/compliance-1099-client';
import { DocumentProposalsBanner } from '@/components/documents/document-proposals-banner';

type TabId = 'compliance' | 'review' | 'requirements' | 'bank' | '1099';
const TAB_IDS: readonly TabId[] = ['compliance', 'review', 'requirements', 'bank', '1099'];

/**
 * Vendor compliance — the AP clerk's exception list for vendor paperwork (FPB §11, §19.2).
 * Cockpit density (work screen). Tabs live on `?tab=` so the section tabs, deep links from
 * request emails and the Requests screen all land on the right view.
 */
export function VendorComplianceScreen() {
  const params = useSearchParams();
  const raw = params.get('tab');
  const tab: TabId = raw && (TAB_IDS as readonly string[]).includes(raw) ? (raw as TabId) : 'compliance';
  const { activeCompanyId, activeCompany, isAll } = useActiveCompany();
  const locationId = !isAll && activeCompanyId ? activeCompanyId : null;
  const [chaseOpen, setChaseOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const exportHref = `/api/vendor-compliance/export${locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''}`;

  return (
    <div>
      <PageHead
        eyebrow={['Payables', 'Vendor compliance']}
        title="Vendor compliance"
        actions={
          <>
            {/* A plain download link: the CSV route is an API response, not a page to navigate to. */}
            <a className="btn btn--quiet" href={exportHref} download>
              <Icon name="down" />
              Export CSV
            </a>
            <Button variant="primary" icon="sliders" onClick={() => setChaseOpen(true)}>
              Automatic chase
            </Button>
          </>
        }
      >
        <p className="t-cap">
          What each vendor owes{activeCompany ? ` ${activeCompany.name}` : ''}, what is on file, and what happens next. A vendor that is missing a required document cannot be paid until a person accepts one, or grants an override.
        </p>
      </PageHead>

      <VendorComplianceTabs />

      {/* W-9s / certificates found in Documents that still need their vendor (document intelligence). */}
      <DocumentProposalsBanner kind="vendor_w9" refreshKey={refreshKey} />
      <DocumentProposalsBanner kind="vendor_coi" refreshKey={refreshKey} />

      {tab === 'compliance' && <ComplianceTab locationId={locationId} companyName={activeCompany?.name ?? null} refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {tab === 'review' && <ReviewTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {tab === 'requirements' && <RequirementsTab />}
      {tab === 'bank' && <BankChangesTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
      {/* 1099 readiness (formerly /compliance-1099, which now redirects here). Its screen is
          still on the legacy bridge, so it renders inside a bridged island until it is ported. */}
      {tab === '1099' && (
        <LegacyIsland>
          <Compliance1099Client embedded />
        </LegacyIsland>
      )}

      <ChaseDrawer open={chaseOpen} onClose={() => setChaseOpen(false)} locationId={locationId} companyName={activeCompany?.name ?? null} />
    </div>
  );
}
