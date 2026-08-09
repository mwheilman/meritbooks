import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { RolesClient } from '../roles/roles-client';

export const dynamic = 'force-dynamic';

/**
 * Alias of /settings/roles. The reserved sidebar (SIDEBAR_ITEMS.user_permissions in
 * lib/rbac/permissions.ts) links here, so this route makes that link resolve without
 * editing the reserved spine. Both paths render the identical admin surface.
 *
 * PAGE GUARD: user_permissions:view. The /api/rbac mutation routes additionally require
 * canManageUsers (company_admin); non-admins see the explanation read-only.
 */
export default async function PermissionsPage() {
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
