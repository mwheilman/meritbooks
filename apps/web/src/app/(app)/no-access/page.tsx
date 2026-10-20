import { NoAccessState } from '@/components/access/no-access-state';
import { ACTIONS, isCapabilityKey, type Action } from '@/lib/rbac/capabilities';

export const dynamic = 'force-dynamic';

/**
 * /no-access?cap=ap.bills&action=approve&client=<locationId>
 *
 * The 403 landing page (05-RBAC-SPEC §6.11): explains what is missing and offers Request
 * access, pre-filled. Intended as page-guard's refusal target (lead wires the redirect);
 * unknown or missing parameters fall back to a generic message.
 */
export default function NoAccessPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const capRaw = one(searchParams.cap);
  const capability = capRaw && isCapabilityKey(capRaw) ? capRaw : undefined;
  const actionRaw = one(searchParams.action);
  const actions: Action[] =
    actionRaw && (ACTIONS as readonly string[]).includes(actionRaw) ? [actionRaw as Action] : ['view'];
  const clientRaw = one(searchParams.client);
  const clientId = clientRaw && /^[0-9a-f-]{36}$/i.test(clientRaw) ? clientRaw : null;
  return (
    <div className="py-10">
      <NoAccessState capability={capability} actions={actions} clientId={clientId} />
    </div>
  );
}
