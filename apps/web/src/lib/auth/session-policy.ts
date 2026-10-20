/**
 * TENANT AUTHENTICATION POLICY — 05-RBAC-SPEC §3.8 / §5.7 R-7.
 *
 * Stored on core.organizations.security_policy (migration 167):
 *   mfa_all_staff            every staff session must have a verified second factor
 *   default_step_up_minutes  money release / locked configuration / vendor bank-detail
 *                            edits need a re-verification within N minutes (0 = off)
 *   session_max_hours        a session older than this cannot release money
 *   idle_timeout_minutes     a session idle longer than this cannot release money
 *   ip_allowlist_enforced    requests must come from a tenant allowlist CIDR
 *                            (core.ip_allowlists)
 *
 * PURE: the decision (evaluateSessionPolicy) takes the policy, the allowlists and the
 * session FACTS (Clerk factor-verification age, session timestamps, client IP) and
 * returns allow / deny-with-obligation. The server wrapper
 * (lib/auth/assert-session-policy.ts) gathers the facts.
 *
 * FAIL BEHAVIOR (the owner's rule for the dev Clerk instance):
 *   - every policy OFF (the default)  → allow, with the warning `policy_off` that the
 *     Security settings card shows.
 *   - a policy ON and the fact it needs MISSING (e.g. Clerk did not send the factor-
 *     verification claim) → DENY for sensitive actions (`POLICY_UNVERIFIABLE`), never
 *     a silent pass.
 */

export interface SecurityPolicy {
  mfa_all_staff: boolean;
  /** 0 = off. */
  default_step_up_minutes: number;
  /** null = off. */
  session_max_hours: number | null;
  /** null = off. */
  idle_timeout_minutes: number | null;
  ip_allowlist_enforced: boolean;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  mfa_all_staff: false,
  default_step_up_minutes: 0,
  session_max_hours: null,
  idle_timeout_minutes: null,
  ip_allowlist_enforced: false,
};

/** Bounds the settings form and the API validate against. */
export const POLICY_BOUNDS = {
  stepUpMinutes: { min: 1, max: 240 },
  sessionMaxHours: { min: 1, max: 720 },
  idleTimeoutMinutes: { min: 5, max: 1440 },
} as const;

/** What the caller is about to do (05 §3.8: release, configure on [L], bank details edit). */
export type SessionAction = 'money_release' | 'configure_locked' | 'bank_details_edit';

export interface SessionFacts {
  /** Clerk `factorVerificationAge`: minutes since [first, second] factor; -1 = never. null = claim absent. */
  factorVerificationAge: readonly [number, number] | null;
  sessionCreatedAt: Date | null;
  lastActiveAt: Date | null;
  clientIp: string | null;
  now: Date;
}

export interface ReverificationConfig {
  level: 'first_factor' | 'second_factor';
  afterMinutes: number;
}

export type DenyCode =
  | 'MFA_REQUIRED'
  | 'STEP_UP_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'IDLE_TIMEOUT'
  | 'IP_NOT_ALLOWED'
  | 'POLICY_UNVERIFIABLE';

export type SessionPolicyDecision =
  | { ok: true; warnings: string[] }
  | {
      ok: false;
      code: DenyCode;
      /** What the UI should do instead of showing a 403. */
      obligation: 'step_up' | 'mfa_enroll' | 'sign_in_again' | 'blocked';
      message: string;
      reverification: ReverificationConfig | null;
    };

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const clampInt = (v: number | null, lo: number, hi: number): number | null =>
  v == null ? null : Math.min(hi, Math.max(lo, Math.round(v)));

/** Coerce the stored jsonb onto a valid policy (unknown keys dropped, bounds clamped). */
export function normalizeSecurityPolicy(raw: unknown): SecurityPolicy {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const stepUp = clampInt(num(src.default_step_up_minutes), 0, POLICY_BOUNDS.stepUpMinutes.max) ?? 0;
  const maxH = num(src.session_max_hours);
  const idle = num(src.idle_timeout_minutes);
  return {
    mfa_all_staff: src.mfa_all_staff === true,
    default_step_up_minutes: stepUp,
    session_max_hours: maxH && maxH > 0 ? clampInt(maxH, POLICY_BOUNDS.sessionMaxHours.min, POLICY_BOUNDS.sessionMaxHours.max) : null,
    idle_timeout_minutes: idle && idle > 0 ? clampInt(idle, POLICY_BOUNDS.idleTimeoutMinutes.min, POLICY_BOUNDS.idleTimeoutMinutes.max) : null,
    ip_allowlist_enforced: src.ip_allowlist_enforced === true,
  };
}

/**
 * Wave 2G: which parts of a policy change RELAX the current policy? An admin may only
 * relax a policy from a session that meets the CURRENT one (a stolen or stale session
 * can't switch off the controls that would stop it). Tightening is never gated (a
 * mis-set policy can always be made stricter or fixed by an admin who meets it).
 *
 * The allowlist only matters while it is enforced: adding a network to an enforced list
 * (or switching enforcement off) loosens; removing networks tightens.
 */
export function policyLoosenings(
  current: SecurityPolicy,
  currentCidrs: readonly string[],
  next: SecurityPolicy,
  nextCidrs: readonly string[],
): string[] {
  const out: string[] = [];
  if (current.mfa_all_staff && !next.mfa_all_staff) out.push('two-factor requirement turned off');
  if (current.default_step_up_minutes > 0
      && (next.default_step_up_minutes === 0 || next.default_step_up_minutes > current.default_step_up_minutes)) {
    out.push(next.default_step_up_minutes === 0 ? 're-verification turned off' : 're-verification window lengthened');
  }
  if (current.session_max_hours != null
      && (next.session_max_hours == null || next.session_max_hours > current.session_max_hours)) {
    out.push(next.session_max_hours == null ? 'session age limit removed' : 'session age limit raised');
  }
  if (current.idle_timeout_minutes != null
      && (next.idle_timeout_minutes == null || next.idle_timeout_minutes > current.idle_timeout_minutes)) {
    out.push(next.idle_timeout_minutes == null ? 'idle timeout removed' : 'idle timeout raised');
  }
  if (current.ip_allowlist_enforced && !next.ip_allowlist_enforced) out.push('IP allowlist turned off');
  if (current.ip_allowlist_enforced && next.ip_allowlist_enforced) {
    // A network is "new" unless an existing entry already covers all of it.
    const covered = (c: string) => currentCidrs.some((h) => cidrWithin(c, h));
    if (nextCidrs.some((c) => !covered(c))) out.push('networks added to the IP allowlist');
  }
  return out;
}

/** Is every address of `inner` inside `outer`? (bare address = /32 or /128). */
function cidrWithin(inner: string, outer: string): boolean {
  const [ia, il] = inner.trim().split('/');
  const [oa, ol] = outer.trim().split('/');
  const i = parseIp(ia);
  const o = parseIp(oa);
  if (!i || !o || i.bits !== o.bits) return false;
  const iLen = il == null || il === '' ? i.bits : Number(il);
  const oLen = ol == null || ol === '' ? o.bits : Number(ol);
  if (!Number.isInteger(iLen) || !Number.isInteger(oLen) || iLen < oLen) return false;
  if (oLen === 0) return true;
  const shift = BigInt(o.bits - oLen);
  return (i.v >> shift) === (o.v >> shift);
}

export function policyIsOff(p: SecurityPolicy): boolean {
  return !p.mfa_all_staff && p.default_step_up_minutes === 0 && p.session_max_hours == null
    && p.idle_timeout_minutes == null && !p.ip_allowlist_enforced;
}

// ── CIDR matching (IPv4 + IPv6) ────────────────────────────────────────────────

function parseIPv4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseIPv6(s: string): bigint | null {
  let str = s.toLowerCase();
  const zone = str.indexOf('%');
  if (zone >= 0) str = str.slice(0, zone);
  // IPv4-mapped tail (::ffff:1.2.3.4)
  const lastColon = str.lastIndexOf(':');
  let tailGroups: string[] = [];
  if (str.includes('.') && lastColon >= 0) {
    const v4 = parseIPv4(str.slice(lastColon + 1));
    if (v4 == null) return null;
    tailGroups = [((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16)];
    str = str.slice(0, lastColon + 1) + tailGroups.join(':');
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

interface ParsedIp { v: bigint; bits: 32 | 128 }

export function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (!raw) return null;
  const s = raw.trim();
  const v4 = parseIPv4(s);
  if (v4 != null) return { v: v4, bits: 32 };
  const v6 = parseIPv6(s);
  if (v6 == null) return null;
  // Normalise IPv4-mapped IPv6 (::ffff:a.b.c.d) to IPv4 so v4 CIDRs match.
  if (v6 >> 32n === 0xffffn) return { v: v6 & 0xffffffffn, bits: 32 };
  return { v: v6, bits: 128 };
}

/** Is `ip` inside `cidr` ("10.0.0.0/8", "2001:db8::/32", or a bare address)? */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [addr, lenStr] = cidr.trim().split('/');
  const net = parseIp(addr);
  const host = parseIp(ip);
  if (!net || !host || net.bits !== host.bits) return false;
  const len = lenStr == null || lenStr === '' ? net.bits : Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > net.bits) return false;
  if (len === 0) return true;
  const shift = BigInt(net.bits - len);
  return (net.v >> shift) === (host.v >> shift);
}

export function isValidCidr(cidr: string): boolean {
  const [addr, lenStr] = cidr.trim().split('/');
  const net = parseIp(addr);
  if (!net) return false;
  if (lenStr == null) return true;
  const len = Number(lenStr);
  return Number.isInteger(len) && len >= 0 && len <= net.bits;
}

// ── The decision ──────────────────────────────────────────────────────────────

const SENSITIVE: ReadonlySet<SessionAction> = new Set(['money_release', 'configure_locked', 'bank_details_edit']);

const verifiedWithin = (age: number, minutes: number) => age >= 0 && age <= minutes;

export function evaluateSessionPolicy(
  policy: SecurityPolicy,
  allowlistCidrs: readonly string[],
  facts: SessionFacts,
  action: SessionAction,
): SessionPolicyDecision {
  if (policyIsOff(policy)) return { ok: true, warnings: ['policy_off'] };
  const sensitive = SENSITIVE.has(action);
  const warnings: string[] = [];

  // 1. IP allowlist.
  if (policy.ip_allowlist_enforced) {
    if (allowlistCidrs.length === 0) {
      warnings.push('ip_allowlist_empty');
    } else if (!facts.clientIp) {
      return deny('POLICY_UNVERIFIABLE', 'blocked', 'Your network address could not be verified against this workspace’s IP allowlist.');
    } else if (!allowlistCidrs.some((c) => ipInCidr(facts.clientIp as string, c))) {
      return deny('IP_NOT_ALLOWED', 'blocked', 'This action is only allowed from your organization’s approved networks.');
    }
  }

  // 2. Session age / idle.
  if (policy.session_max_hours != null && sensitive) {
    if (!facts.sessionCreatedAt) {
      return deny('POLICY_UNVERIFIABLE', 'sign_in_again', 'Your session age could not be verified. Sign in again to continue.');
    }
    if (facts.now.getTime() - facts.sessionCreatedAt.getTime() > policy.session_max_hours * 3_600_000) {
      return deny('SESSION_EXPIRED', 'sign_in_again', `Sessions older than ${policy.session_max_hours} hours can’t release money. Sign in again.`);
    }
  }
  if (policy.idle_timeout_minutes != null && sensitive) {
    if (!facts.lastActiveAt) {
      return deny('POLICY_UNVERIFIABLE', 'sign_in_again', 'Your session activity could not be verified. Sign in again to continue.');
    }
    if (facts.now.getTime() - facts.lastActiveAt.getTime() > policy.idle_timeout_minutes * 60_000) {
      return deny('IDLE_TIMEOUT', 'sign_in_again', `Your session was idle for more than ${policy.idle_timeout_minutes} minutes. Sign in again.`);
    }
  }

  const fva = facts.factorVerificationAge;

  // 3. MFA for all staff.
  if (policy.mfa_all_staff) {
    if (!fva) {
      if (sensitive) {
        return deny('POLICY_UNVERIFIABLE', 'step_up', 'Two-factor verification could not be confirmed for this session.', {
          level: 'second_factor', afterMinutes: policy.default_step_up_minutes || POLICY_BOUNDS.stepUpMinutes.max,
        });
      }
      warnings.push('mfa_unverifiable');
    } else if (fva[1] < 0) {
      return deny('MFA_REQUIRED', 'mfa_enroll', 'This workspace requires two-factor authentication. Set up a second factor and verify it to continue.', {
        level: 'second_factor', afterMinutes: policy.default_step_up_minutes || POLICY_BOUNDS.stepUpMinutes.max,
      });
    }
  }

  // 4. Step-up for sensitive actions.
  if (policy.default_step_up_minutes > 0 && sensitive) {
    const minutes = policy.default_step_up_minutes;
    const level: ReverificationConfig['level'] = policy.mfa_all_staff ? 'second_factor' : 'first_factor';
    if (!fva) {
      return deny('POLICY_UNVERIFIABLE', 'step_up', 'Re-verification could not be confirmed for this session. Verify again to continue.', { level, afterMinutes: minutes });
    }
    const fresh = policy.mfa_all_staff
      ? verifiedWithin(fva[1], minutes)
      : verifiedWithin(fva[0], minutes) || verifiedWithin(fva[1], minutes);
    if (!fresh) {
      return deny('STEP_UP_REQUIRED', 'step_up', `Confirm it’s you — this action needs a verification within the last ${minutes} minutes.`, { level, afterMinutes: minutes });
    }
  }

  return { ok: true, warnings };
}

function deny(
  code: DenyCode,
  obligation: 'step_up' | 'mfa_enroll' | 'sign_in_again' | 'blocked',
  message: string,
  reverification: ReverificationConfig | null = null,
): SessionPolicyDecision {
  return { ok: false, code, obligation, message, reverification };
}

/** The structured body a denied request returns (merged with Clerk's reverification hint server-side). */
export interface StepUpErrorBody {
  error: string;
  code: DenyCode;
  obligation: 'step_up' | 'mfa_enroll' | 'sign_in_again' | 'blocked';
  reverification: ReverificationConfig | null;
}

/** Client helper: is this API error body a session-policy denial? */
export function isSessionPolicyError(body: unknown): body is StepUpErrorBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return typeof b.obligation === 'string' && typeof b.code === 'string'
    && ['MFA_REQUIRED', 'STEP_UP_REQUIRED', 'SESSION_EXPIRED', 'IDLE_TIMEOUT', 'IP_NOT_ALLOWED', 'POLICY_UNVERIFIABLE'].includes(b.code);
}
