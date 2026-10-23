import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { TemplateSuggestionsNote } from '@/components/access/template-suggestions-note';
import { RolesClient } from '../roles/roles-client';

export const metadata = { title: 'Permissions' };

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
      {/* MeritBooks role suggestions (05 §1.7 / §6.10) — renders nothing when there are none. */}
      <TemplateSuggestionsNote className="mb-4" />
      <RolesClient />
    </>
  );
}
