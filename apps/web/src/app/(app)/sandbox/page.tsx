export const dynamic = 'force-dynamic';

import { PageHeader } from '@/components/ui';
import { SandboxConsole } from './sandbox-console';

export default function SandboxPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sandbox"
        description="Seed a COA-complete test tenant and exercise the full cross-module chain — cost, recognition, billing, and the closed-period rejection — end to end through the real services."
        breadcrumbs={[{ label: 'Admin' }, { label: 'Sandbox' }]}
      />
      <SandboxConsole />
    </div>
  );
}
