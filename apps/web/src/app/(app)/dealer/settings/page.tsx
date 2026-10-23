export const dynamic = 'force-dynamic';

import { SettingsWorkspace } from './_components/settings-workspace';

export const metadata = { title: 'Dealer settings' };

/**
 * /dealer/settings — switch the pack on per client, map accounts and departments,
 * review lenders, set accounting policies and thresholds (FPB-dealer-pack §9.3).
 * Writes need the settings permission (DEALER_PERMS.settings), enforced server-side.
 */
export default function DealerSettingsPage() {
  return <SettingsWorkspace />;
}
