/**
 * Industry titles for personas (spec §2.2 "Industry titles … in each pack manifest (`roles` slot)").
 *
 * The pack manifest schema (packages/industry-packs) has no `roles` slot yet, so this reads it
 * structurally and returns null when absent; callers then fall back to the granting role's name,
 * then to the persona label. Accepted shapes, so the slot can land in either direction:
 *   roles: [{ title: 'Technician', template: 'projects_labor' }, …]   (also key/persona/role_key, label/name)
 *   roles: { Technician: 'projects_labor', … }                         (title → template)
 *   roles: { projects_labor: 'Technician', … }                         (template → title)
 * When several titles map to one template, the first wins.
 */
import type { PersonaKey } from './types';
import { isPersonaKey } from './templates';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function packRoleTitle(manifest: unknown, persona: PersonaKey): string | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const roles = (manifest as { roles?: unknown }).roles;
  if (Array.isArray(roles)) {
    for (const r of roles) {
      if (typeof r !== 'object' || r === null) continue;
      const o = r as Record<string, unknown>;
      const tpl = str(o.template) ?? str(o.persona) ?? str(o.role_key) ?? str(o.key);
      const title = str(o.title) ?? str(o.label) ?? str(o.name);
      if (tpl === persona && title) return title;
    }
    return null;
  }
  if (typeof roles === 'object' && roles !== null) {
    const rec = roles as Record<string, unknown>;
    const direct = str(rec[persona]);
    if (direct && !isPersonaKey(direct)) return direct;
    for (const [title, tpl] of Object.entries(rec)) if (tpl === persona && !isPersonaKey(title)) return title;
  }
  return null;
}
