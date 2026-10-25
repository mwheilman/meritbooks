export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { TemplateDuplicate, TemplateUpdate, templateKey } from '@/lib/commercial/screen-schemas';
import { cmError, cmWrote } from '@/lib/commercial/server';

/**
 * PATCH /api/commercial/templates/:id — edit a project template (CGC-06). A payload change bumps
 * its version (pm.tg_cm_template_version); "Push to open jobs" then re-applies it to every job
 * still on an older version.
 */
export const PATCH = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false, body: TemplateUpdate }, async ({ db, body, params }) => {
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.isActive !== undefined) patch.is_active = body.isActive;
  if (body.payload !== undefined) {
    const cur = await db.schema('pm').from('cm_project_templates').select('payload').eq('id', params.templateId!).maybeSingle();
    if (cur.error) throw cmError(cur.error);
    if (!cur.data) throw new HttpError(404, 'That template was not found.', 'NOT_FOUND');
    patch.payload = { ...((cur.data as { payload: Record<string, unknown> }).payload ?? {}), ...body.payload };
  }
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  return cmWrote<{ id: string; version: number }>(await db.schema('pm').from('cm_project_templates').update(patch).eq('id', params.templateId!).select('id, version').single());
});

/** POST /api/commercial/templates/:id — duplicate as a custom template for a company. */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false, body: TemplateDuplicate }, async ({ db, body, params }) => {
  const pm = db.schema('pm');
  const src = await pm.from('cm_project_templates').select('description, payload').eq('id', params.templateId!).maybeSingle();
  if (src.error) throw cmError(src.error);
  if (!src.data) throw new HttpError(404, 'That template was not found.', 'NOT_FOUND');
  const s = src.data as { description: string | null; payload: Record<string, unknown> };
  const key = templateKey(body.name, `_${Date.now().toString(36).slice(-4)}`);
  return cmWrote<{ id: string }>(await pm.from('cm_project_templates').insert({
    location_id: body.companyId, key, name: body.name, kind: 'CUSTOM', description: s.description, payload: s.payload,
  }).select('id').single());
});
