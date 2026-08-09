import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { RolesClient } from './roles-client';

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
      <PageHeader
        title="Roles & Permissions"
        description="See exactly what each role can do, tune any permission, and create custom roles. System defaults ship ready to use; every change here is org-scoped and fails closed."
      />
      <RolesClient />
    </>
  );
}
