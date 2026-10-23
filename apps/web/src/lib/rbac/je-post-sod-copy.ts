/**
 * What the "large journal entries need a second person" rule (H6_JE_SELF_POST) actually
 * does for THIS tenant, in plain words — one source for both places /settings/approvals
 * mentions it (the always-on safeguards list and the threshold setting). Live check
 * Wave 1, fix 1G-6: the screen said "always-on" and "Not yet enforced" at once.
 *
 * The rule is checked on every manual post (/api/gl/post, /api/journal-entries) and on
 * month-end WIP runs since wave 2G (lib/rbac/je-post-sod.ts); what a hit DOES follows
 * the tenant's access mode:
 *   v2 / unknown → refused;
 *   dual         → allowed, and listed as a difference to review on the Roles page;
 *   legacy       → allowed, not recorded.
 * Pure and client-safe (no server imports).
 */

export type JeSelfPostMode = 'legacy' | 'dual' | 'v2' | null;

export interface JeSelfPostCopy {
  /** Short status chip. */
  status: 'Enforced' | 'Checked · not blocking yet' | 'Off until the new access model';
  tone: 'pos' | 'warn' | 'default';
  /** One or two sentences for the setting and the safeguard row. */
  detail: string;
}

/** The SoD rule key this copy describes (matches core.sod_rules.key / ACTION_SOD_RULE_KEY). */
export const JE_SELF_POST_RULE_KEY = 'H6_JE_SELF_POST';

export function jeSelfPostCopy(mode: JeSelfPostMode, thresholdText: string): JeSelfPostCopy {
  if (mode === 'dual') {
    return {
      status: 'Checked · not blocking yet',
      tone: 'warn',
      detail:
        `Checked on every journal entry posted at ${thresholdText} or more. While your company is trying the new access model side by side, ` +
        'such posts still go through, and each one is listed as a difference to review on the Roles page before you switch over.',
    };
  }
  if (mode === 'legacy') {
    return {
      status: 'Off until the new access model',
      tone: 'default',
      detail:
        `Your company still uses the original access model, so a person can post their own entry at ${thresholdText} or more. ` +
        'Turn on the new access model on the Roles page to enforce this.',
    };
  }
  return {
    status: 'Enforced',
    tone: 'pos',
    detail:
      `Entries at ${thresholdText} or more are refused when the person who prepared them tries to post them (manual entries and month-end WIP runs). ` +
      'A WIP run is approved by someone other than the person who proposed it; posting a manual draft someone else prepared isn’t available yet.',
  };
}
