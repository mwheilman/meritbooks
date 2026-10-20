'use client';

import Link from 'next/link';
import { Lock } from 'lucide-react';
import type { Action } from '@/lib/rbac/capabilities';
import { capabilityLabel, describeGrant } from '@/lib/access-governance/describe';
import { RequestAccess } from './request-access';

/**
 * The 403 / "no access" state (05-RBAC-SPEC §0 item 9, §6.11): says plainly what is missing
 * and offers Request access, pre-filled with the capability and client in context.
 *
 * Mount it wherever a page or panel is refused — e.g. page-guard's redirect target, a route
 * that returns 403 `{ capability, action }`, or a widget whose data call is refused.
 */
export function NoAccessState({
  title = "You don't have access to this",
  capability,
  actions = ['view'],
  clientId = null,
  clientName,
  message,
  backHref = '/dashboard',
  compact = false,
}: {
  title?: string;
  capability?: string;
  actions?: Action[];
  clientId?: string | null;
  clientName?: string;
  message?: string;
  backHref?: string | null;
  compact?: boolean;
}) {
  const needs = capability ? describeGrant(capability, actions) : null;
  const body =
    message ??
    (needs
      ? `Your access doesn't include permission to ${needs}${clientName ? ` on ${clientName}` : ''}. Ask someone who can grant it.`
      : 'Your access doesn’t include this. Ask someone who can grant it.');
  return (
    <div
      role="status"
      className={compact ? 'flex flex-col items-start gap-3 py-6' : 'card mx-auto flex max-w-lg flex-col items-center px-6 py-12 text-center'}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-800">
        <Lock className="h-5 w-5 text-slate-400" aria-hidden />
      </div>
      <div>
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="mt-1 text-sm text-slate-400">{body}</p>
        {capability && !compact && <p className="mt-1 text-xs text-slate-500">Needed: {capabilityLabel(capability)}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <RequestAccess capability={capability} actions={actions} clientId={clientId} />
        {backHref && (
          <Link href={backHref} className="btn-ghost btn-sm">
            Go back
          </Link>
        )}
      </div>
    </div>
  );
}
