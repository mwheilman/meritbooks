/**
 * Org-level routes — pages that act on the WHOLE workspace (the tenant), never on one
 * client's books. On these the "Posts to <client>" tag beside the page verbs is wrong
 * (nothing on /settings posts to Coho Flooring), so the indicator hides itself here.
 *
 * Pure (no React, no next/*) so it can be unit-tested and shared by the shell later.
 * A prefix matches the route itself and everything under it ("/settings" matches
 * "/settings/approvals"), never a sibling that merely shares letters ("/settings-x").
 */
export const ORG_LEVEL_PREFIXES: readonly string[] = [
  // Workspace homes and cross-client queues
  '/dashboard',
  '/inbox',
  '/portfolio',
  '/consolidation',
  '/search',
  // Org administration — team, access, settings, integrations, platform
  '/settings',
  '/team',
  '/integrations',
  '/operations',
  '/platform',
  // Setup and refusals
  '/onboarding',
  '/no-access',
  // Org-wide oversight and AI governance (read-only logs across every client)
  '/audit',
  '/compliance',
  '/ai-decisions',
  '/agents',
];

/** True when `pathname` is an org-level route (see ORG_LEVEL_PREFIXES). */
export function isOrgLevelRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return ORG_LEVEL_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}
