/**
 * Rail destinations whose modules arrive in later build waves. Each gets an honest
 * "Arrives in the next release" page — no sample figures, no fake rows. The money pages
 * (estimates, commitments, subcontractors, billing, retainage, job cost) have their own
 * routes and are no longer listed here.
 */
import type { VocabKey } from '@/lib/packs';

export interface Area {
  slug: string;
  title: string;
  /** Use this vocabulary term as the title instead (e.g. "Work orders" → "Repair orders"). */
  vocab?: VocabKey;
  /** One sentence: what the page will do. */
  what: string;
  /** Where to work on it today. */
  meanwhile?: { label: string; href: string };
}

export const AREAS: ReadonlyArray<Area> = [
  { slug: 'inbox', title: 'Inbox', what: 'Mentions, approvals routed to you and replies from customers, in one list.', meanwhile: { label: 'Open To review', href: '/review' } },
  { slug: 'leads', title: 'Leads', what: 'Inquiries before they become an estimate, with source and follow-up date.' },
  { slug: 'wip', title: 'WIP', what: 'Work in progress from Merit Books, read-only: earned, billed, over and under billing.' },
  { slug: 'ai-decisions', title: 'AI decisions', what: 'Every suggestion the AI made, what it was based on, and who approved it.' },
  { slug: 'compare', title: 'Compare companies', what: 'Margin, backlog and cycle time side by side across companies.', meanwhile: { label: 'Open margin by job', href: '/insights/margin' } },
];

export function findArea(slug: string): Area | undefined {
  return AREAS.find((a) => a.slug === slug);
}
