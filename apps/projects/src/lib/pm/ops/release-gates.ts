/**
 * pm.release_to_shop returns the failing gate names in a fixed order (1105). Each becomes one
 * plain sentence and the fix. Pure (unit-tested: one entry per gate, unknown gates still read).
 */
export const RELEASE_GATES = ['drawings_approved', 'bom_present', 'operations_present', 'selections_approved', 'has_budget'] as const;
export type ReleaseGate = (typeof RELEASE_GATES)[number];

export interface GateCopy {
  /** Checklist label when met. */
  label: string;
  /** One sentence when it blocks the release. */
  failing: string;
  /** What to do, and where. `panel` = a section of the order panel; `href` = a page. */
  fix: { label: string; panel?: 'drawings' | 'bom' | 'operations'; href?: (jobId: string) => string };
}

export const GATE_COPY: Readonly<Record<ReleaseGate, GateCopy>> = {
  drawings_approved: {
    label: 'Shop drawings approved',
    failing: 'Shop drawings are not approved yet.',
    fix: { label: 'Approve the drawings', panel: 'drawings' },
  },
  bom_present: {
    label: 'Cut list entered',
    failing: 'The order has no cut list or bill of materials.',
    fix: { label: 'Add the cut list', panel: 'bom' },
  },
  operations_present: {
    label: 'Routing applied',
    failing: 'No shop operations are planned yet.',
    fix: { label: 'Apply a routing', panel: 'operations' },
  },
  selections_approved: {
    label: 'Selections approved',
    failing: 'The client still owes selections on this job.',
    fix: { label: 'Open selections', href: (jobId) => `/selections?job=${jobId}` },
  },
  has_budget: {
    label: 'Budget in place',
    failing: 'The job has no original budget with lines.',
    fix: { label: 'Build the budget', href: (jobId) => `/jobs/${jobId}?tab=budget` },
  },
};

export function isReleaseGate(g: string): g is ReleaseGate {
  return (RELEASE_GATES as readonly string[]).includes(g);
}

export function gateCopy(g: string): GateCopy {
  if (isReleaseGate(g)) return GATE_COPY[g];
  const words = g.replace(/_/g, ' ');
  return { label: words, failing: `A release check (${words}) is not met yet.`, fix: { label: 'Open the order' } };
}

/** "Not released: shop drawings are not approved yet, and the order has no cut list…" */
export function releaseSentence(failing: ReadonlyArray<string>): string {
  if (failing.length === 0) return 'Released to the shop.';
  const parts = failing.map((g) => {
    const s = gateCopy(g).failing.replace(/\.$/, '');
    return s.charAt(0).toLowerCase() + s.slice(1);
  });
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
  return `Not released: ${list}.`;
}
