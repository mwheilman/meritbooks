import { z } from 'zod';

/** Zod schemas for /api/onboarding/migrations/* (Onboarding v2 part 1). */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30');
const userId = z.string().min(1).max(200);

/**
 * Security review M4: a cutover is the date the source books are proven AS OF, and sign-off
 * hard-closes every month through it — a future cutover would lock the open month. The schema
 * refuses a date after today (UTC, one day of slack for time zones); the server re-checks against
 * the organization's own today at proof and sign-off (server/certificate.ts).
 */
export function cutoverNotInFuture(d: string, now: Date = new Date()): boolean {
  const slack = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return d <= slack;
}
const cutoverDate = isoDate.refine((d) => cutoverNotInFuture(d), 'The cutover can’t be in the future — pick the last month-end the old books are closed through.');

export const towerQuery = z.object({}).passthrough();

export const towerAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), location_ids: z.array(uuid).min(1).max(200), wave_id: uuid.nullable().optional(), preparer_user_id: userId.nullable().optional(), reviewer_user_id: userId.nullable().optional() }),
  z.object({ action: z.literal('refresh_all') }),
  z.object({ action: z.literal('bulk_cutover'), project_ids: z.array(uuid).min(1).max(200), cutover_date: cutoverDate.nullable() }),
  z.object({ action: z.literal('bulk_assign'), project_ids: z.array(uuid).min(1).max(200), preparer_user_id: userId.nullable().optional(), reviewer_user_id: userId.nullable().optional() }),
  z.object({ action: z.literal('bulk_preflight'), project_ids: z.array(uuid).min(1).max(50) }),
  z.object({ action: z.literal('create_wave'), name: z.string().trim().min(1).max(120), cutover_date: cutoverDate, purpose: z.string().trim().max(300).nullable().optional(), target_go_live: isoDate.nullable().optional() }),
  z.object({ action: z.literal('close_wave'), wave_id: uuid }),
]);
export type TowerAction = z.infer<typeof towerAction>;

export const projectQuery = z.object({ id: uuid });

export const projectAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update_plan'),
    id: uuid,
    cutover_date: cutoverDate.nullable().optional(),
    wave_id: uuid.nullable().optional(),
    history_depth: z.enum(['opening_only', 'monthly', 'monthly_plus_detail']).optional(),
    target_go_live: isoDate.nullable().optional(),
    shadow_mode: z.enum(['parallel', 'clean_switch', 'none']).optional(),
    chart_strategy: z.enum(['keep_source_chart', 'tenant_standard']).optional(),
    systems_confirmed: z.boolean().optional(),
    lead_user_id: userId.nullable().optional(),
    preparer_user_id: userId.nullable().optional(),
    reviewer_user_id: userId.nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  }),
  z.object({ action: z.literal('add_source'), id: uuid, system_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }),
  z.object({ action: z.literal('remove_source'), id: uuid, source_id: uuid }),
  z.object({ action: z.literal('skip_practice_close'), id: uuid, reason: z.string().trim().min(10).max(1000) }),
  z.object({ action: z.literal('comment'), id: uuid, text: z.string().trim().min(1).max(560) }),
  z.object({ action: z.literal('pull_qbo'), id: uuid }),
  z.object({ action: z.literal('refresh'), id: uuid }),
]);
export type ProjectAction = z.infer<typeof projectAction>;

export const preflightAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run'), id: uuid }),
  z.object({
    action: z.literal('decide'),
    id: uuid,
    check_id: z.string().regex(/^PF-(0[1-9]|1[0-9]|2[0-4])$/),
    disposition: z.enum(['open', 'fixed_in_source', 'carry_as_reconciling_item', 'accepted_with_note', 'not_applicable']),
    note: z.string().max(2000).nullable().optional(),
  }),
]);
export type PreflightAction = z.infer<typeof preflightAction>;

export const mappingAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run'), id: uuid, use_ai: z.boolean().optional() }),
  z.object({ action: z.literal('accept'), id: uuid, keys: z.array(z.string().min(1).max(200)).min(1).max(2000) }),
  z.object({ action: z.literal('accept_ready'), id: uuid }),
  z.object({ action: z.literal('set'), id: uuid, key: z.string().min(1).max(200), target_account_id: uuid, reason: z.string().max(1000).nullable().optional() }),
  z.object({ action: z.literal('request_account'), id: uuid, key: z.string().min(1).max(200), note: z.string().max(300).nullable().optional() }),
  z.object({ action: z.literal('reopen'), id: uuid, key: z.string().min(1).max(200) }),
  z.object({ action: z.literal('settle_rule'), rule_id: uuid, target_account_id: uuid }),
]);
export type MappingAction = z.infer<typeof mappingAction>;

export const mastersAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run'), id: uuid }),
  z.object({ action: z.literal('link'), id: uuid, staged_ids: z.array(uuid).min(1).max(1000) }),
  z.object({ action: z.literal('keep_new'), id: uuid, staged_ids: z.array(uuid).min(1).max(1000) }),
  z.object({ action: z.literal('ignore'), id: uuid, staged_ids: z.array(uuid).min(1).max(1000) }),
  z.object({ action: z.literal('accept_all_matches'), id: uuid, entity: z.enum(['customer', 'vendor', 'item', 'dimension']) }),
]);
export type MastersAction = z.infer<typeof mastersAction>;

export const loadAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stage_opening'), id: uuid }),
  z.object({ action: z.literal('open_items'), id: uuid, kind: z.enum(['ar', 'ap']) }),
]);
export type LoadAction = z.infer<typeof loadAction>;

export const certificateAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sign_proof'), id: uuid }),
  z.object({ action: z.literal('sign_off'), id: uuid }),
  z.object({ action: z.literal('void'), id: uuid, reason: z.string().trim().min(10).max(1000) }),
  z.object({ action: z.literal('go_live'), id: uuid }),
]);
export type CertificateAction = z.infer<typeof certificateAction>;

export const rulesQuery = z.object({ set_id: uuid.optional() });

export const buyInQuery = z.object({ id: uuid, role: z.enum(['bookkeeper', 'accounting_manager', 'controller', 'owner', 'ap_clerk']).optional() });
