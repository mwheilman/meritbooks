import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { write } from '@/lib/pm/ops/rpc';
import { Day, Need, SkillCode, Uuid } from '@/lib/pm/ops/schemas';

/**
 * Board setup: crews (with daily capacity), crew members, the skill list and who holds which
 * skill. These tables are member-writable in 1104 (pm.crews, crew_members, skills, employee_skills);
 * RLS keeps every row in the caller's org.
 */
const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_crew'),
    companyId: Uuid,
    name: Need(80, 'Name the crew'),
    kind: z.enum(['TECH', 'INSTALL', 'SHOP']).default('TECH'),
    capacityMinutes: z.number().int().min(0).max(1440).default(480),
  }),
  z.object({ op: z.literal('update_crew'), crewId: Uuid, name: Need(80, 'Name the crew').optional(), capacityMinutes: z.number().int().min(0).max(1440).optional(), isActive: z.boolean().optional() }),
  z.object({ op: z.literal('add_member'), crewId: Uuid, employeeId: Uuid, role: z.enum(['LEAD', 'MEMBER', 'APPRENTICE']).default('MEMBER') }),
  z.object({ op: z.literal('remove_member'), crewId: Uuid, employeeId: Uuid }),
  z.object({ op: z.literal('add_skill'), code: SkillCode, name: Need(80, 'Name the skill'), kind: z.enum(['SKILL', 'LICENSE', 'CERTIFICATION', 'BRAND']).default('SKILL') }),
  z.object({ op: z.literal('grant_skill'), employeeId: Uuid, skillId: Uuid, expiresOn: Day.nullish() }),
  z.object({ op: z.literal('revoke_skill'), employeeId: Uuid, skillId: Uuid }),
]);

export const POST = route({ body: Op }, async ({ db, body, tenant }) => {
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_crew':
      assertCompany(tenant, body.companyId);
      await write(pm.from('crews').insert({ location_id: body.companyId, name: body.name, kind: body.kind, capacity_minutes_per_day: body.capacityMinutes }).select('id'), 'add crew');
      return { ok: true };
    case 'update_crew': {
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.capacityMinutes !== undefined) patch.capacity_minutes_per_day = body.capacityMinutes;
      if (body.isActive !== undefined) patch.is_active = body.isActive;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      const r = await write<unknown[]>(pm.from('crews').update(patch).eq('id', body.crewId).select('id'), 'update crew');
      if (!r.length) throw new HttpError(404, 'That crew was not found.', 'NOT_FOUND');
      return { ok: true };
    }
    case 'add_member': {
      // one primary crew per person (unique index): a second crew makes them a non-primary member
      const existing = await pm.from('crew_members').select('crew_id').eq('employee_id', body.employeeId).eq('is_primary', true).limit(1);
      const primary = !(existing.data && existing.data.length > 0);
      await write(pm.from('crew_members').upsert({ crew_id: body.crewId, employee_id: body.employeeId, role: body.role, is_primary: primary }, { onConflict: 'crew_id,employee_id' }).select('crew_id'), 'add crew member');
      return { ok: true };
    }
    case 'remove_member':
      await write(pm.from('crew_members').delete().eq('crew_id', body.crewId).eq('employee_id', body.employeeId).select('crew_id'), 'remove crew member');
      return { ok: true };
    case 'add_skill':
      await write(pm.from('skills').insert({ code: body.code, name: body.name, kind: body.kind }).select('id'), 'add skill');
      return { ok: true };
    case 'grant_skill':
      await write(pm.from('employee_skills').upsert({ employee_id: body.employeeId, skill_id: body.skillId, expires_on: body.expiresOn ?? null }, { onConflict: 'employee_id,skill_id' }).select('skill_id'), 'grant skill');
      return { ok: true };
    case 'revoke_skill':
      await write(pm.from('employee_skills').delete().eq('employee_id', body.employeeId).eq('skill_id', body.skillId).select('skill_id'), 'revoke skill');
      return { ok: true };
  }
});
