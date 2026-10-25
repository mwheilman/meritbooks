import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { fsCall, fsOwn, fsWrite } from '@/lib/fieldservice/rpc';
import { loadFormTemplates } from '@/lib/fieldservice/completion';
import { Uuid } from '@/lib/pm/ops/schemas';

/**
 * Checklists with required readings (FS-29). GET the company's templates. POST: switch one on / off,
 * save its fields (each save bumps the version; past submissions keep the version they used), or
 * submit a form from the office (same rules as the phone: required readings, ranges, red tags).
 */
const Field = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/), label: z.string().trim().min(1).max(120),
  type: z.enum(['reading', 'number', 'pass_fail', 'check', 'choice', 'text', 'photo']), unit: z.string().trim().max(20).optional(),
  min: z.number().optional(), max: z.number().optional(), required: z.boolean().optional(), options: z.array(z.string().max(80)).max(20).optional(),
  red_tag_on_fail: z.boolean().optional(), red_tag_above: z.number().optional(), red_tag_below: z.number().optional(),
});

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ companyId: Uuid }) }, async ({ db, tenant, query }) => {
  assertCompany(tenant, query.companyId);
  const t = await loadFormTemplates(db, query.companyId);
  return { templates: t.data, error: t.error };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('active'), templateId: Uuid, active: z.boolean() }),
  z.object({ op: z.literal('fields'), templateId: Uuid, fields: z.array(Field).min(1).max(80), requiresSignature: z.boolean() }),
  z.object({ op: z.literal('submit'), workOrderId: Uuid, templateId: Uuid, answers: z.record(z.union([z.string().max(2000), z.number(), z.boolean(), z.array(Uuid).max(20), z.null()])),
             signedName: z.string().trim().max(120).nullish() }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, body: Body,
  ops: { active: { cap: 'projects.settings', action: 'configure' }, fields: { cap: 'projects.settings', action: 'configure' } } }, async ({ db, body, tenant }) => {
  if (body.op === 'submit') {
    return fsCall(db, 'fs_submit_form', { p_wo: body.workOrderId, p_template: body.templateId, p_answers: body.answers, p_signed_name: body.signedName ?? null,
      p_signature_path: null, p_photos: [], p_command: null, p_red_tag_reason: null });
  }
  const t = await fsOwn<{ id: string; location_id: string; version: number }>(db, 'fs_form_templates', 'id, location_id, version', body.templateId, 'That checklist was not found.');
  assertCompany(tenant, t.location_id);
  const patch = body.op === 'active' ? { is_active: body.active } : { fields: body.fields, requires_signature: body.requiresSignature, version: t.version + 1 };
  return fsWrite(db.schema('pm').from('fs_form_templates').update(patch).eq('id', t.id).select('id, version, is_active').single(), 'save checklist');
});
