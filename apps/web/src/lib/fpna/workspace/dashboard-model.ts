/**
 * Dashboard persistence rules (FPB §4.13, AC-W3) — PURE: validation, the effective-dashboard
 * resolution chain and the IA M-8 lock checks. The store (dashboards-store.ts) applies them
 * before any service-role write; the DB CHECKs and unique indexes (migration 191) back them up.
 *
 * Resolution: personal (unless the role default is `locked`, or an `override` publish is newer
 * than the personal save) → tenant default for the role → tenant default for every role →
 * the built-in pack for the role.
 */

import { z } from 'zod';
import { METRICS } from '@/lib/metrics/registry';
import { PACK_BY_KEY, PACKS, packCards, packForRole, type PackDef } from './packs';
import type { DashboardCard, DashboardRow, DashboardSettings, EffectiveDashboardSummary, LockLevel, PackKey } from './types';

export const MAX_CARDS = 48;

export const settingsSchema = z.object({
  basis: z.enum(['month', 'qtd', 'ytd', 'ttm']),
  comparison: z.enum(['prior_period', 'prior_year', 'budget', 'none']),
  sparkline: z.union([z.literal(12), z.literal(24)]),
});

export const cardSchema = z.object({
  metric: z.string().min(1).max(64).refine((k) => METRICS.has(k), { message: 'Unknown metric' }),
  size: z.enum(['s', 'm', 'l']),
});

export const cardsSchema = z
  .array(cardSchema)
  .min(1, 'A dashboard needs at least one card')
  .max(MAX_CARDS, `At most ${MAX_CARDS} cards`)
  .refine((cards) => new Set(cards.map((c) => c.metric)).size === cards.length, { message: 'Each metric can appear once' });

export const PACK_KEYS = ['owner', 'cfo', 'construction', 'dealer', 'practice', 'custom'] as const;

export const personalSaveSchema = z.object({
  /** Update this personal dashboard (omit to create). */
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  packKey: z.enum(PACK_KEYS),
  cards: cardsSchema,
  settings: settingsSchema,
});
export type PersonalSaveInput = z.infer<typeof personalSaveSchema>;

export const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;

export const publishSchema = z.object({
  /** Role (UserRole vocabulary); null = every role. */
  roleKey: z.string().regex(ROLE_KEY_RE).nullable(),
  name: z.string().trim().min(1).max(80),
  packKey: z.enum(PACK_KEYS),
  cards: cardsSchema,
  settings: settingsSchema,
  lockLevel: z.enum(['unlocked', 'add_move', 'locked']),
  /** Metrics a user may not remove under add_move (default: every published card). */
  requiredMetrics: z.array(z.string().refine((k) => METRICS.has(k), { message: 'Unknown metric' })).max(MAX_CARDS).optional(),
  publishMode: z.enum(['new_users', 'override']),
  note: z.string().trim().max(500).optional(),
});
export type PublishInput = z.infer<typeof publishSchema>;

// ── row parsing (DB jsonb is untrusted input: unknown metrics are dropped, never shown as 0) ──

export function parseCards(raw: unknown): DashboardCard[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DashboardCard[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const metric = (c as { metric?: unknown }).metric;
    const size = (c as { size?: unknown }).size;
    if (typeof metric !== 'string' || !METRICS.has(metric) || seen.has(metric)) continue;
    seen.add(metric);
    out.push({ metric, size: size === 's' || size === 'l' ? size : 'm' });
  }
  return out;
}

export const DEFAULT_SETTINGS: DashboardSettings = { basis: 'ytd', comparison: 'prior_year', sparkline: 12 };

export function parseSettings(raw: unknown): DashboardSettings {
  const r = settingsSchema.safeParse(raw);
  return r.success ? r.data : DEFAULT_SETTINGS;
}

export function rowFromDb(r: Record<string, unknown>): DashboardRow {
  const pack = String(r.pack_key ?? 'custom');
  return {
    id: String(r.id),
    scopeKind: r.scope_kind === 'tenant' ? 'tenant' : 'user',
    roleKey: (r.role_key as string | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
    name: String(r.name ?? ''),
    packKey: (PACK_KEYS as readonly string[]).includes(pack) ? (pack as PackKey) : 'custom',
    cards: parseCards(r.cards),
    settings: parseSettings(r.settings),
    lockLevel: (['unlocked', 'add_move', 'locked'].includes(String(r.lock_level)) ? r.lock_level : 'unlocked') as LockLevel,
    requiredMetrics: Array.isArray(r.required_metrics) ? (r.required_metrics as string[]).filter((k) => METRICS.has(k)) : [],
    publishMode: r.publish_mode === 'override' ? 'override' : 'new_users',
    version: Number(r.version ?? 1),
    isCurrent: r.is_current !== false,
    basedOnId: (r.based_on_id as string | null) ?? null,
    publishedBy: (r.published_by as string | null) ?? null,
    publishedAt: (r.published_at as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

// ── resolution ─────────────────────────────────────────────────────────────

export interface ResolveInput {
  role: string | null;
  /** The reader's own current personal rows. */
  personal: readonly DashboardRow[];
  /** The org's current tenant defaults (any role). */
  tenant: readonly DashboardRow[];
  /** 'pack:<key>' | row id | 'default' | undefined (most recent personal, else default). */
  requested?: string | null;
}

/** The tenant default that governs this role (its own, else the every-role default). */
export function governingDefault(role: string | null, tenant: readonly DashboardRow[]): DashboardRow | null {
  const current = tenant.filter((t) => t.scopeKind === 'tenant' && t.isCurrent);
  return (role ? current.find((t) => t.roleKey === role) : undefined) ?? current.find((t) => t.roleKey === null) ?? null;
}

function lockOf(def: DashboardRow | null): EffectiveDashboardSummary['lock'] {
  if (!def) return null;
  return {
    level: def.lockLevel,
    requiredMetrics: def.lockLevel === 'add_move' ? (def.requiredMetrics.length ? def.requiredMetrics : def.cards.map((c) => c.metric)) : [],
    publishedBy: def.publishedBy,
    publishedAt: def.publishedAt,
    note: def.note,
    roleKey: def.roleKey,
  };
}

/** Was this personal row superseded by an override publish? */
export function isOverridden(personal: DashboardRow, def: DashboardRow | null): boolean {
  if (!def || def.publishMode !== 'override' || !def.publishedAt) return false;
  return Date.parse(def.publishedAt) > Date.parse(personal.updatedAt);
}

function fromPack(pack: PackDef, lock: EffectiveDashboardSummary['lock'], canPersonalize: boolean): EffectiveDashboardSummary {
  return { id: null, ref: `pack:${pack.key}`, name: pack.name, packKey: pack.key, cards: packCards(pack), settings: pack.settings, source: 'pack', lock, canPersonalize, overridden: false, version: 1 };
}

function fromRow(row: DashboardRow, source: EffectiveDashboardSummary['source'], lock: EffectiveDashboardSummary['lock'], canPersonalize: boolean, overridden = false): EffectiveDashboardSummary {
  return { id: row.id, ref: row.id, name: row.name, packKey: row.packKey, cards: row.cards, settings: row.settings, source, lock, canPersonalize, overridden, version: row.version };
}

export function resolveEffectiveDashboard(input: ResolveInput): EffectiveDashboardSummary {
  const def = governingDefault(input.role, input.tenant);
  const lock = lockOf(def);
  const canPersonalize = !def || def.lockLevel !== 'locked';
  const defaultView = (): EffectiveDashboardSummary => {
    if (def && def.cards.length) return fromRow(def, def.roleKey ? 'role_default' : 'tenant_default', lock, canPersonalize);
    return fromPack(packForRole(input.role), lock, canPersonalize);
  };
  const req = input.requested ?? null;

  if (req && req.startsWith('pack:')) {
    const pack = PACK_BY_KEY.get(req.slice(5));
    // A locked default is the only view; packs are starting points for a personal copy.
    if (pack && canPersonalize) return fromPack(pack, lock, canPersonalize);
    return defaultView();
  }
  if (req === 'default') return defaultView();
  if (req) {
    const own = input.personal.find((p) => p.id === req && p.isCurrent);
    if (own && canPersonalize && own.cards.length) {
      if (isOverridden(own, def)) return { ...defaultView(), overridden: true };
      return fromRow(own, 'personal', lock, canPersonalize);
    }
    const t = input.tenant.find((x) => x.id === req && x.isCurrent);
    if (t && t === def) return defaultView();
    return defaultView();
  }
  // No explicit choice: the most recently saved personal dashboard that is still in force.
  if (canPersonalize) {
    const mine = [...input.personal].filter((p) => p.isCurrent && p.cards.length).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const live = mine.find((p) => !isOverridden(p, def));
    if (live) return fromRow(live, 'personal', lock, canPersonalize);
    if (mine.length) return { ...defaultView(), overridden: true };
  }
  return defaultView();
}

// ── lock checks for a personal save ─────────────────────────────────────────

export type SaveCheck = { ok: true } | { ok: false; status: 409; code: 'DASHBOARD_LOCKED' | 'REQUIRED_METRIC_REMOVED'; message: string };

export function checkPersonalSave(role: string | null, tenant: readonly DashboardRow[], cards: readonly DashboardCard[]): SaveCheck {
  const def = governingDefault(role, tenant);
  if (!def) return { ok: true };
  if (def.lockLevel === 'locked') {
    return { ok: false, status: 409, code: 'DASHBOARD_LOCKED', message: 'Your administrator has locked this dashboard for your role, so it can’t be personalised.' };
  }
  if (def.lockLevel === 'add_move') {
    const required = lockOf(def)?.requiredMetrics ?? [];
    const have = new Set(cards.map((c) => c.metric));
    const missing = required.filter((k) => !have.has(k));
    if (missing.length) {
      const names = missing.map((k) => METRICS.get(k)?.name ?? k);
      return { ok: false, status: 409, code: 'REQUIRED_METRIC_REMOVED', message: `Your administrator requires ${names.join(', ')} on this dashboard. You can add and move cards, but not remove these.` };
    }
  }
  return { ok: true };
}

/** Move one card (keyboard ←/→ and drag both call this). PURE. */
export function moveCard(cards: readonly DashboardCard[], from: number, to: number): DashboardCard[] {
  if (from < 0 || from >= cards.length) return [...cards];
  const clamped = Math.max(0, Math.min(cards.length - 1, to));
  const out = [...cards];
  const [c] = out.splice(from, 1);
  out.splice(clamped, 0, c);
  return out;
}

export function packList(): Array<{ key: PackDef['key']; name: string; description: string; cardCount: number }> {
  return PACKS.map((p) => ({ key: p.key, name: p.name, description: p.description, cardCount: p.metrics.length }));
}
