/**
 * Registry of MEMBER (RLS-scoped) Supabase clients — the clients that run as the signed-in
 * user (createAuthedSupabase / createServerSupabase). lib/db/scoped-writer.ts uses it to
 * decide when a write to a member-locked table (migration 171) must be ESCALATED to the
 * service role (after the org / client-scope checks): only a known member client is.
 *
 * Fail-closed by construction: a client NOT in the registry is used as-is. If it is the
 * service role (drains, webhooks, crons) the write proceeds exactly as before; if it is
 * some other member-scoped client, RLS refuses the write — it is never silently upgraded.
 * Marking can therefore only ever route a member's write through the checked service path.
 */

const MEMBER_CLIENTS = new WeakSet<object>();

/** Record a client as running as the signed-in member (RLS enforced). Returns it. */
export function markMemberClient<T extends object>(client: T): T {
  MEMBER_CLIENTS.add(client);
  return client;
}

/** Is this a known member (RLS-scoped) client? */
export function isMemberClient(client: unknown): boolean {
  return typeof client === 'object' && client !== null && MEMBER_CLIENTS.has(client);
}
