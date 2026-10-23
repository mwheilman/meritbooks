'use client';

import Link from 'next/link';
import { Icon } from '@meritbooks/merit-ui';
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
  // Kit state block (.surface .wg-state): a column with an 8px gap between every part, so
  // the "Needed: …" line can never run into the Request access button below it.
  return (
    <div
      role="status"
      className={compact ? 'wg-state mb-noaccess mb-noaccess--compact' : 'surface wg-state mb-noaccess'}
    >
      <span className="mb-noaccess-mark" aria-hidden="true">
        <Icon name="lock" />
      </span>
      <span className="t-head">{title}</span>
      <p>{body}</p>
      {capability && !compact && <p className="t-cap">Needed: {capabilityLabel(capability)}</p>}
      <div className="btn-row mb-noaccess-acts">
        <RequestAccess capability={capability} actions={actions} clientId={clientId} />
        {backHref && (
          <Link href={backHref} className="btn btn--quiet">
            Go back
          </Link>
        )}
      </div>
    </div>
  );
}
