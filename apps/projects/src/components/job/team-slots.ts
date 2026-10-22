/** Job-team slots (spec §2: pm.job_members.slot). Client-safe. */
export const TEAM_SLOTS = ['pm', 'apm', 'superintendent', 'foreman', 'lead', 'crew', 'estimator', 'sales', 'coordinator', 'accountant', 'designer', 'other'] as const;
export type TeamSlot = (typeof TEAM_SLOTS)[number];

export const SLOT_LABEL: Readonly<Record<TeamSlot, string>> = {
  pm: 'Project manager',
  apm: 'Assistant PM',
  superintendent: 'Superintendent',
  foreman: 'Foreman',
  lead: 'Lead',
  crew: 'Crew',
  estimator: 'Estimator',
  sales: 'Sales',
  coordinator: 'Coordinator',
  accountant: 'Accountant',
  designer: 'Designer',
  other: 'Other',
};
