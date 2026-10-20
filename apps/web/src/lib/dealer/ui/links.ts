/**
 * Dealer Pack (D2) — canonical drill URLs. Every slice links through these so a
 * tile, report row or exception always lands on the same screen. Pure.
 */

const qs = (p: Record<string, string | number | null | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const dealerLinks = {
  home: () => '/dealer',
  /** minAge / maxAge = days in stock (inclusive), e.g. an aging bucket 91–180. */
  units: (f: { status?: string; condition?: string; minAge?: number; maxAge?: number; floored?: 'yes' | 'no'; q?: string } = {}) => `/dealer/units${qs(f)}`,
  unit: (id: string) => `/dealer/units/${id}`,
  floorPlan: (tab?: 'positions' | 'sot' | 'notes' | 'curtailments' | 'payoffs' | 'interest' | 'setup', f: Record<string, string | undefined> = {}) =>
    `/dealer/floor-plan${qs({ tab, ...f })}`,
  note: (id: string) => `/dealer/floor-plan/notes/${id}`,
  lenderStatements: (f: { lineId?: string } = {}) => `/dealer/lender-statements${qs(f)}`,
  lenderStatement: (id: string) => `/dealer/lender-statements/${id}`,
  warranty: (f: { status?: string; claim?: string; aging?: string } = {}) => `/dealer/warranty${qs(f)}`,
  incentives: (f: { status?: string; claim?: string; tab?: 'claims' | 'programs'; aging?: string } = {}) => `/dealer/incentives${qs(f)}`,
  oemStatements: () => '/dealer/oem-statements',
  oemStatement: (id: string) => `/dealer/oem-statements/${id}`,
  deals: (f: { status?: string; tab?: 'deals' | 'trades' } = {}) => `/dealer/deals${qs(f)}`,
  deal: (saleId: string) => `/dealer/deals/${saleId}`,
  imports: () => '/dealer/imports',
  importBatch: (id: string) => `/dealer/imports/${id}`,
  reports: (report?: string) => `/dealer/reports${qs({ report })}`,
  settings: (section?: 'accounts' | 'departments' | 'lenders' | 'policies' | 'enable') => `/dealer/settings${section ? `#${section}` : ''}`,
  /** Existing journal-entry deep link (lib/je-deep-link.ts). */
  journalEntry: (glEntryId: string) => `/journal-entries?id=${glEntryId}`,
  exceptions: () => '/exceptions',
};
