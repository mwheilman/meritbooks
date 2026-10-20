/**
 * FIELD MASKS — 05-RBAC-SPEC §3.6 / §5.7 R-6, IA-SPEC R16 ("sensitive fields masked by
 * default").
 *
 *   comp      pay rates, salaries, per-person payroll      hidden · grouped · visible
 *   tin       vendor / employee TIN, SSN, sole-prop EIN     hidden · masked · reveal_logged · visible
 *   bank      bank account & routing numbers                hidden · masked · reveal_logged · visible
 *   personal  home address, DOB, personal phone             hidden · visible
 *   secrets   API keys, provider tokens                     never (platform lock H10)
 *
 * The caller's level per class comes from their role's `field_policy` (05 R-2 role
 * definitions, imported per tenant from the legacy role in migration 158; the legacy
 * fallback is lib/rbac/legacy-map.ts legacyFieldPolicy). Everything here is MASKED BY
 * DEFAULT: an unknown role, a missing policy or a read error resolves to the most
 * restrictive level (fail closed).
 *
 * `reveal_logged` means "masked unless the caller explicitly asks to reveal, with a
 * reason" — each reveal writes core.field_reveals (migration 167, append-only) and
 * core.action_log. `visible` returns the value without a reveal step.
 *
 * Two layers (R-6): the DB never returns the raw `column_revoke` columns to anon /
 * authenticated (migration 167 column-level grants), and API serializers + exports run
 * every row through applyFieldMasks before responding.
 *
 * PURE section first (unit-tested); the server helpers below take an explicit
 * service-role client and org — they never resolve one themselves.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FieldPolicy } from '@/lib/rbac/access-templates';
import { legacyFieldPolicy } from '@/lib/rbac/legacy-map';
import { normalizeMembershipRole } from '@/lib/rbac/role-normalize';

export type MaskedFieldClass = 'comp' | 'tin' | 'bank' | 'personal' | 'secrets';
export type FieldLevel = 'hidden' | 'grouped' | 'masked' | 'reveal_logged' | 'visible';

/** The most restrictive policy — what an unknown caller gets. */
export const LOCKED_FIELD_POLICY: FieldPolicy = { comp: 'hidden', tin: 'hidden', bank: 'hidden', personal: 'hidden' };

const LEVELS: Record<Exclude<MaskedFieldClass, 'secrets'>, readonly FieldLevel[]> = {
  comp: ['hidden', 'grouped', 'visible'],
  tin: ['hidden', 'masked', 'reveal_logged', 'visible'],
  bank: ['hidden', 'masked', 'reveal_logged', 'visible'],
  personal: ['hidden', 'visible'],
};

export interface FieldAccess {
  policy: FieldPolicy;
  /** Classes the caller explicitly revealed for THIS request (already logged). */
  revealed: ReadonlySet<MaskedFieldClass>;
}

export function lockedAccess(): FieldAccess {
  return { policy: LOCKED_FIELD_POLICY, revealed: new Set() };
}

/** The caller's level for a class. Secrets are always hidden. */
export function fieldLevel(policy: FieldPolicy, cls: MaskedFieldClass): FieldLevel {
  if (cls === 'secrets') return 'hidden';
  return policy[cls];
}

/** May this level be raised to the raw value by an explicit (logged) reveal? */
export function canReveal(level: FieldLevel): boolean {
  return level === 'reveal_logged' || level === 'visible';
}

/** Coerce a stored jsonb field_policy onto a full, valid policy (invalid → restrictive). */
export function normalizeFieldPolicy(raw: unknown, fallback: FieldPolicy = LOCKED_FIELD_POLICY): FieldPolicy {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pick = <K extends keyof FieldPolicy>(k: K): FieldPolicy[K] => {
    const v = src[k];
    return (typeof v === 'string' && (LEVELS[k] as readonly string[]).includes(v) ? v : fallback[k]) as FieldPolicy[K];
  };
  return { comp: pick('comp'), tin: pick('tin'), bank: pick('bank'), personal: pick('personal') };
}

/** "•••• 1234" — the last four characters of the alphanumerics, or null when blank. */
export function last4Mask(value: string | null | undefined): string | null {
  if (value == null) return null;
  const clean = String(value).replace(/[^0-9A-Za-z]/g, '');
  if (clean.length === 0) return null;
  return `•••• ${clean.slice(-4)}`;
}

/**
 * Mask one value of a class at the caller's level. Numbers (comp) are either the raw
 * value (`visible`) or null; strings (tin / bank) are null (`hidden`), last-4
 * (`masked`, or `reveal_logged` without a reveal), or raw.
 */
export function maskValue<V extends string | number | null | undefined>(
  cls: MaskedFieldClass,
  value: V,
  access: FieldAccess,
): V | string | null {
  if (value == null) return null;
  const level = fieldLevel(access.policy, cls);
  if (cls === 'secrets') return null;
  if (cls === 'comp') return level === 'visible' ? value : null;
  if (cls === 'personal') return level === 'visible' ? value : null;
  // tin / bank
  if (level === 'hidden') return null;
  if (level === 'visible') return value;
  if (level === 'reveal_logged' && access.revealed.has(cls)) return value;
  return last4Mask(String(value));
}

/** Which columns of a row belong to which class. */
export type FieldMaskSpec<T> = Partial<Record<keyof T & string, MaskedFieldClass>>;

export interface MaskResult<T> {
  row: T;
  /** Columns returned masked / nulled for this caller (for the UI's "masked" hint). */
  masked: string[];
}

/** Apply the spec to one row. Never mutates the input. */
export function applyFieldMasks<T extends Record<string, unknown>>(
  row: T,
  spec: FieldMaskSpec<T>,
  access: FieldAccess,
): MaskResult<T> {
  const out: Record<string, unknown> = { ...row };
  const masked: string[] = [];
  for (const [col, cls] of Object.entries(spec) as Array<[string, MaskedFieldClass | undefined]>) {
    if (!cls || !(col in out)) continue;
    const before = out[col] as string | number | null | undefined;
    const after = maskValue(cls, before, access);
    if (after !== before) masked.push(col);
    out[col] = after;
  }
  return { row: out as T, masked };
}

/** Apply the spec to many rows; `masked` is the union of masked columns. */
export function applyFieldMasksAll<T extends Record<string, unknown>>(
  rows: readonly T[],
  spec: FieldMaskSpec<T>,
  access: FieldAccess,
): { rows: T[]; masked: string[] } {
  const maskedCols = new Set<string>();
  const out = rows.map((r) => {
    const res = applyFieldMasks(r, spec, access);
    res.masked.forEach((c) => maskedCols.add(c));
    return res.row;
  });
  return { rows: out, masked: [...maskedCols] };
}

/** Response metadata the UI uses to label masked fields and offer "Reveal". */
export function maskMeta(access: FieldAccess, masked: string[]): {
  masked: string[];
  levels: FieldPolicy;
  revealed: MaskedFieldClass[];
} {
  return { masked, levels: access.policy, revealed: [...access.revealed] };
}

export interface RevealRequest {
  classes: MaskedFieldClass[];
  reason: string;
}

/**
 * Parse `?reveal=tin,bank&reason=…` from a request URL. A reveal without a reason of
 * at least 3 characters is ignored (05 §3.6: each reveal is logged WITH a reason).
 */
export function parseRevealRequest(url: string | URL): RevealRequest | null {
  const u = typeof url === 'string' ? new URL(url) : url;
  const raw = u.searchParams.get('reveal');
  const reason = (u.searchParams.get('reason') ?? '').trim();
  if (!raw || reason.length < 3) return null;
  const classes = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is MaskedFieldClass => s === 'tin' || s === 'bank');
  return classes.length > 0 ? { classes: [...new Set(classes)], reason: reason.slice(0, 500) } : null;
}

// ── Server helpers (explicit service-role client + org) ─────────────────────────

/**
 * Resolve the caller's field policy in an org. Order: the tenant's own role definition
 * for the caller's legacy role (migration 158 imported one per legacy role, editable
 * per tenant) → the legacy default for that role → LOCKED. Fails closed on any error.
 */
export async function resolveFieldPolicy(admin: SupabaseClient, orgId: string, clerkUserId: string): Promise<FieldPolicy> {
  try {
    const { data: emp } = await admin
      .schema('core')
      .from('employees')
      .select('role')
      .eq('org_id', orgId)
      .eq('clerk_user_id', clerkUserId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    const rawRole = (emp as { role: string | null } | null)?.role ?? null;
    const role = normalizeMembershipRole(rawRole);
    if (!role) return LOCKED_FIELD_POLICY;
    const legacy = normalizeFieldPolicy(legacyFieldPolicy(role));

    const { data: def } = await admin
      .schema('core')
      .from('role_definitions')
      .select('field_policy')
      .eq('org_id', orgId)
      .eq('owner_level', 'tenant')
      .eq('legacy_role_key', role)
      .limit(1)
      .maybeSingle();
    const stored = (def as { field_policy: unknown } | null)?.field_policy;
    return stored ? normalizeFieldPolicy(stored, legacy) : legacy;
  } catch {
    return LOCKED_FIELD_POLICY;
  }
}

export interface RevealSubject {
  table: string;
  ids: string[];
}

/**
 * The most records one reveal may cover. A reveal unmasks a whole class for the
 * response, so it is granted only when EVERY subject in the response is logged — a
 * request over the cap is refused outright (never "log the first N, unmask all").
 */
export const MAX_REVEAL_SUBJECTS = 500;

/**
 * Build the request's FieldAccess. When the request asks to reveal a class the caller's
 * level allows (`reveal_logged` / `visible`), the reveal is written to core.field_reveals
 * (one row per subject id) and core.action_log BEFORE the class is unmasked. A reveal
 * the level does not allow is silently not granted (the value stays masked). If the
 * log write fails the reveal is NOT granted (no unlogged reveal).
 */
export async function resolveFieldAccess(
  admin: SupabaseClient,
  orgId: string,
  clerkUserId: string,
  reveal?: { request: RevealRequest | null; subject: RevealSubject },
): Promise<FieldAccess> {
  const policy = await resolveFieldPolicy(admin, orgId, clerkUserId);
  const revealed = new Set<MaskedFieldClass>();
  const req = reveal?.request;
  if (!req || !reveal || reveal.subject.ids.length === 0) return { policy, revealed };
  const ids = [...new Set(reveal.subject.ids)];
  if (ids.length > MAX_REVEAL_SUBJECTS) return { policy, revealed }; // no unlogged reveal

  for (const cls of req.classes) {
    const level = fieldLevel(policy, cls);
    if (!canReveal(level)) continue;
    if (level === 'visible') { revealed.add(cls); continue; }
    const ok = await logFieldReveal(admin, {
      orgId, clerkUserId, fieldClass: cls, subjectTable: reveal.subject.table, subjectIds: ids, reason: req.reason,
    });
    if (ok) revealed.add(cls);
  }
  return { policy, revealed };
}

/**
 * Append the reveal to core.field_reveals + core.action_log — one row per subject, ALL
 * subjects (refused above MAX_REVEAL_SUBJECTS rather than truncated). Returns false on
 * failure or when over the cap; the caller must then NOT unmask.
 */
export async function logFieldReveal(
  admin: SupabaseClient,
  e: { orgId: string; clerkUserId: string; fieldClass: MaskedFieldClass; subjectTable: string; subjectIds: string[]; reason: string },
): Promise<boolean> {
  if (e.subjectIds.length === 0 || e.subjectIds.length > MAX_REVEAL_SUBJECTS) return false;
  const rows = e.subjectIds.map((id) => ({
    org_id: e.orgId,
    clerk_user_id: e.clerkUserId,
    field_class: e.fieldClass,
    subject_table: e.subjectTable,
    subject_id: id,
    reason: e.reason,
  }));
  const { error } = await admin.schema('core').from('field_reveals').insert(rows);
  if (error) return false;
  // Best-effort mirror into the trust trail; the field_reveals row is the record.
  try {
    const { logHumanAction } = await import('@/lib/trust/action-log');
    await logHumanAction(admin, e.clerkUserId, e.orgId, {
      action: 'field.reveal',
      subjectTable: e.subjectTable,
      subjectId: e.subjectIds.length === 1 ? e.subjectIds[0] : null,
      summary: `Revealed ${e.fieldClass.toUpperCase()} on ${e.subjectIds.length} ${e.subjectTable} record(s): ${e.reason}`,
      metadata: { fieldClass: e.fieldClass, subjectIds: e.subjectIds.slice(0, 50), reason: e.reason },
    });
  } catch {
    /* field_reveals already holds the record */
  }
  return true;
}
