'use client';

import { Shield, ShieldCheck } from 'lucide-react';
import { SectionTabs, useSectionTab, type SectionTab } from '../_components/section-tabs';
import { ComplianceView } from './compliance-view';
import { ControlsClient } from '../controls/controls-client';

/**
 * Compliance & Controls shell. Merges the former standalone /compliance (regulatory
 * filing tracker) and /controls (SOX controls command center) into one screen — both
 * are governed by the same `compliance` permission. /controls redirects to
 * /compliance?tab=controls. Each tab body keeps its own section header.
 */
const TABS: SectionTab[] = [
  { id: 'compliance', label: 'Filings', icon: <Shield size={14} /> },
  { id: 'controls', label: 'Controls', icon: <ShieldCheck size={14} /> },
];

const VALID = ['compliance', 'controls'] as const;

export function ComplianceControlsTabs() {
  const [tab, setTab] = useSectionTab(VALID, 'compliance');

  return (
    <div className="space-y-6">
      <SectionTabs tabs={TABS} active={tab} onChange={(id) => setTab(id as typeof VALID[number])} />
      {tab === 'compliance' ? <ComplianceView /> : <ControlsClient />}
    </div>
  );
}
