import { requirePagePermission } from '@/lib/rbac/page-guard';
import { SettingsClient } from './settings-client';

export const dynamic = 'force-dynamic';

/**
 * PAGE-LEVEL RBAC (IA-SPEC §7 R0b, interim; 06 §5 "Access issues"). The settings hub
 * edits organization, AI, routing, rev-rec, sales-tax, branding and company settings —
 * accounting configuration — so only roles that may view accounting settings reach it.
 * Fails closed (redirect). Guarded on the index page only (not a layout) because the
 * settings sub-pages carry their own, different guards (system settings, permissions).
 */
export default async function SettingsPage() {
  await requirePagePermission('settings_acct', 'view');
  return <SettingsClient />;
}
