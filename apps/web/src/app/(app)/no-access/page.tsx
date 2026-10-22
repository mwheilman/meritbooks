import { NoAccessState } from '@/components/access/no-access-state';
import { ACTIONS, isCapabilityKey, type Action } from '@/lib/rbac/capabilities';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { noAccessCopy } from './no-access-copy';

export const dynamic = 'force-dynamic';

/**
 * /no-access?cap=ap.bills&action=approve&client=<locationId>
 *
 * The 403 landing page (05-RBAC-SPEC §6.11, page-guard's refusal target): says what was
 * blocked — the action and the capability's plain-English label, and the client by name
 * when `client` is passed — and offers Request access, pre-filled. Unknown or missing
 * parameters fall back to a generic message.
 */
async function clientNameFor(clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  try {
    const supabase = await createAuthedServerSupabase();
    if (!supabase) return null;
    // RLS (the caller's org) scopes the read; a client the caller can't see stays unnamed.
    const { data } = await supabase.schema('core').from('locations').select('name').eq('id', clientId).maybeSingle();
    const name = (data as { name: string | null } | null)?.name;
    return name && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export default async function NoAccessPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const capRaw = one(searchParams.cap);
  const capability = capRaw && isCapabilityKey(capRaw) ? capRaw : undefined;
  const actionRaw = one(searchParams.action);
  const action: Action = actionRaw && (ACTIONS as readonly string[]).includes(actionRaw) ? (actionRaw as Action) : 'view';
  const clientRaw = one(searchParams.client);
  const clientId = clientRaw && /^[0-9a-f-]{36}$/i.test(clientRaw) ? clientRaw : null;
  const clientName = await clientNameFor(clientId);
  const copy = noAccessCopy({ capability, action, clientId, clientName });
  return (
    <div className="py-10">
      <NoAccessState
        title={copy.title}
        message={copy.message}
        capability={capability}
        actions={[action]}
        clientId={clientId}
        clientName={clientName ?? undefined}
      />
    </div>
  );
}
