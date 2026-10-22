/**
 * Plain-English copy for the /no-access page (05 §6.11; live smoke test: the page didn't
 * say what was blocked). Names the action and the capability's label from the registry
 * (lib/rbac/capabilities.ts) and, when known, the client. Pure.
 */

import { CAPABILITY_BY_KEY, type Action } from '@/lib/rbac/capabilities';
import { actionVerb } from '@/lib/access-governance/describe';

export interface NoAccessCopy {
  title: string;
  message: string;
  /** "Approve · Bills — Vendor bills incl. intake queue and OCR drafts." (null without a capability) */
  detail: string | null;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function noAccessCopy(input: {
  capability?: string | null;
  action?: Action | null;
  clientId?: string | null;
  clientName?: string | null;
}): NoAccessCopy {
  const def = input.capability ? CAPABILITY_BY_KEY.get(input.capability) : undefined;
  const where = input.clientName ? ` for ${input.clientName}` : input.clientId ? ' for this client' : '';
  if (!def) {
    return {
      title: "You don't have access to this",
      message: `Your access doesn’t include this page${where}. Ask someone who can grant it, or request access below.`,
      detail: null,
    };
  }
  const verb = actionVerb(input.action ?? 'view');
  return {
    title: `You can’t ${verb} ${def.label}${where}`,
    message: `Your access doesn’t include permission to ${verb} ${def.label}${where} (${def.label}: ${def.description.replace(/\.$/, '')}). Ask someone who can grant it, or request access below.`,
    detail: `${capitalize(verb)} · ${def.label} — ${def.description}`,
  };
}
