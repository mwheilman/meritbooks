/**
 * Honest placeholders for job tabs a pack names that are not built yet: what the tab will do and
 * where that work lives today. No sample rows, no fake figures.
 */
import type { JobTabValue } from '@/lib/pm/job-tabs';

export interface LaterCopy {
  what: string;
  meanwhile?: { label: string; href: (jobId: string) => string };
}

export const LATER_TABS: Partial<Record<JobTabValue, LaterCopy>> = {
  rfis: { what: 'RFIs and submittals with ball-in-court, due dates and the spec section, answered on the record.', meanwhile: { label: 'Open the activity', href: (j) => `/jobs/${j}?tab=activity` } },
  'client-view': { what: 'What the client sees in the portal: decisions waiting on them, schedule, photos, invoices.', meanwhile: { label: 'Open selections', href: (j) => `/jobs/${j}?tab=selections` } },
  equipment: { what: 'Equipment at this location with serials, install dates, warranty and service history.', meanwhile: { label: 'Open equipment', href: () => '/assets' } },
  agreement: { what: 'The service agreement covering this location: plan, visits due and renewal.', meanwhile: { label: 'Open agreements', href: () => '/agreements' } },
  parts: { what: 'Parts on this repair order: requested, picked, on order and billed.', meanwhile: { label: 'Open the parts counter', href: () => '/parts' } },
  'warranty-claim': { what: 'The manufacturer claim packet: serial, failure code, labor, parts and photos, with claim status.', meanwhile: { label: 'Open warranty', href: () => '/warranty' } },
  'capital-stack': { what: 'Equity, loans and draws funding this project, by source and in lender order.', meanwhile: { label: 'Open draws', href: (j) => `/jobs/${j}?tab=draws` } },
  bom: { what: 'Bill of materials and cut lists by release, from the engineered drawings.', meanwhile: { label: 'Open production', href: (j) => `/jobs/${j}?tab=production` } },
  'tm-tickets': { what: 'Time-and-material tickets with labor, material and the GC’s signature, rolled into billing.', meanwhile: { label: 'Open time', href: (j) => `/jobs/${j}?tab=time` } },
  receiving: { what: 'Items received against purchase orders, with inspection photos and damage notes.', meanwhile: { label: 'Open purchase orders', href: (j) => `/jobs/${j}?tab=commitments` } },
  productivity: { what: 'Installed quantities against hours and budget by cost code: the labor productivity grid.', meanwhile: { label: 'Open job cost', href: (j) => `/jobs/${j}?tab=job-cost` } },
};
