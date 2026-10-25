import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { fsOwn, fsWrite } from '@/lib/fieldservice/rpc';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const Limit = z.object({
  businessUnitId: Uuid,
  zoneId: Uuid.nullish(),
  arrivalWindowId: Uuid,
  dayOfWeek: z.number().int().min(1).max(7).nullish(),
  onDate: Day.nullish(),
  maxJobs: z.number().int().min(0).max(500).nullish(),
  maxMinutes: z.number().int().min(0).max(100000).nullish(),
  note: Text(200).nullish(),
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('upsert'), companyId: Uuid, limits: z.array(Limit).min(1).max(500) }),
  z.object({ op: z.literal('delete'), companyId: Uuid, id: Uuid }),
  z.object({ op: z.literal('zone'), companyId: Uuid, id: Uuid.nullish(), code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/, 'Letters, digits, - and _'), name: Text(80).min(1), zips: z.array(z.string().regex(/^\d{5}$/)).max(2000), color: Text(20).nullish() }),
  z.object({ op: z.literal('window'), companyId: Uuid, id: Uuid.nullish(), label: Text(40).min(1), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/), daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7), isAfterHours: z.boolean().default(false), online: z.boolean().default(true) }),
]);

/**
 * Capacity, zones and arrival windows (FS-15/16): class S tables written through RLS — the
 * database refuses the write without projects.dispatch:edit at the company.
 */
export const POST = route({ access: { cap: 'projects.dispatch', action: 'edit' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const pm = db.schema('pm');
  switch (body.op) {
    case 'upsert': {
      for (const l of body.limits) {
        if (l.dayOfWeek && l.onDate) throw new HttpError(422, 'A limit is for a weekday or for a date, not both.', 'VALIDATION');
        if (l.maxJobs == null && l.maxMinutes == null) throw new HttpError(422, 'Set jobs or minutes.', 'VALIDATION');
      }
      // replace by key: delete the matching rows, then insert (keeps the unique key simple and idempotent)
      for (const l of body.limits) {
        let del = pm.from('capacity_limits').delete().eq('location_id', body.companyId).eq('business_unit_id', l.businessUnitId).eq('arrival_window_id', l.arrivalWindowId);
        del = l.zoneId ? del.eq('zone_id', l.zoneId) : del.is('zone_id', null);
        del = l.dayOfWeek ? del.eq('day_of_week', l.dayOfWeek) : del.is('day_of_week', null);
        del = l.onDate ? del.eq('on_date', l.onDate) : del.is('on_date', null);
        await fsWrite(del.select('id'), 'replace capacity');
      }
      await fsWrite(pm.from('capacity_limits').insert(body.limits.map((l) => ({
        location_id: body.companyId, business_unit_id: l.businessUnitId, zone_id: l.zoneId ?? null, arrival_window_id: l.arrivalWindowId,
        day_of_week: l.dayOfWeek ?? null, on_date: l.onDate ?? null, max_jobs: l.maxJobs ?? null, max_minutes: l.maxMinutes ?? null, note: l.note || null,
      }))).select('id'), 'save capacity');
      return { saved: body.limits.length };
    }
    case 'delete': {
      const row = await fsOwn<{ id: string; location_id: string }>(db, 'capacity_limits', 'id, location_id', body.id, 'That limit was not found.');
      assertCompany(tenant, row.location_id);
      await fsWrite(pm.from('capacity_limits').delete().eq('id', body.id).select('id'), 'delete capacity');
      return { ok: true };
    }
    case 'zone': {
      const row = { location_id: body.companyId, code: body.code.toUpperCase(), name: body.name, zips: [...new Set(body.zips)], color: body.color || null };
      if (body.id) await fsWrite(pm.from('service_zones').update(row).eq('id', body.id).select('id'), 'save zone');
      else await fsWrite(pm.from('service_zones').insert(row).select('id'), 'add zone');
      return { ok: true };
    }
    case 'window': {
      if (body.endTime <= body.startTime) throw new HttpError(422, 'The window ends before it starts.', 'VALIDATION');
      const row = { location_id: body.companyId, label: body.label, start_time: body.startTime, end_time: body.endTime, days_of_week: [...new Set(body.daysOfWeek)].sort(), is_after_hours: body.isAfterHours, online: body.online };
      if (body.id) await fsWrite(pm.from('arrival_windows').update(row).eq('id', body.id).select('id'), 'save window');
      else await fsWrite(pm.from('arrival_windows').insert(row).select('id'), 'add window');
      return { ok: true };
    }
  }
});
