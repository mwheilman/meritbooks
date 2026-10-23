import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { TemplateSuggestionsNote } from '@/components/access/template-suggestions-note';
import { RolesClient } from './roles-client';
import { DualRunPanel } from './dual-run-panel';

export const metadata = { title: 'Roles & permissions' };

export const dynamic = 'force-dynamic';

/**
 * Roles & Permissions admin surface.
 *
 * Answers the owner need directly: (1) EXPLAIN what each shipped/system role grants, in
 * plain English, feature by feature; and (2) allow FULL customization — create custom
 * roles and toggle any individual permission per role. Everything the page writes goes
 * through the admin-gated, fail-closed /api/rbac/* routes.
 *
 * PAGE GUARD: user_permissions:view (identity gate #9). The /api/rbac mutation routes
 * additionally require canManageUsers (company_admin) — a viewer who is not an admin
 * sees the explanation read-only and gets a clear notice if they attempt an edit.
 */
export default async function RolesPage() {
  await requirePagePermission('user_permissions', 'view');
  return (
    <>
      {/* Header on merit-ui (Redesign R1); the role editor below is still on the legacy bridge. */}
      <PageHeader
        eyebrow={['Team & settings', 'Access']}
        title="Roles & permissions"
        description="See exactly what each role can do, tune any permission, and create custom roles. System defaults ship ready to use; every change is scoped to your organization and fails closed."
      />
      {/* R-11 dual-run status + enforcement switch (tenant admins only; hidden otherwise). */}
      <DualRunPanel />
      {/* MeritBooks role suggestions (05 §1.7 / §6.10) — renders nothing when there are none. */}
      <TemplateSuggestionsNote className="mb-4" />
      <RolesClient />
    </>
  );
}
