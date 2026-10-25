export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { siteLabels } from '@/lib/residential/field-i18n';
import { resRpc } from '@/lib/residential/rpc';

const Uuid = z.string().uuid();

export interface FieldSiteCard {
  job_id: string;
  job_number: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  codes: { lockbox?: string; gate?: string; garage?: string; alarm?: string };
  home: Record<string, string | boolean>;
  rrp: boolean;
  deliveries: Array<{ description: string; expected_on: string | null; status: string; tracking: string | null }>;
  checks_open: Array<{ id: string; kind: string; date: string }>;
  tasks_today: Array<{ id: string; title: string; status: string }>;
}

/**
 * GET /api/field/site?jobs=a,b&day=YYYY-MM-DD&lang=es — additive to /api/field/today (RES-68): the
 * lead carpenter's site cards for the jobs on today's bundle — address, gate / lockbox codes, the
 * homeowner's notes and occupied-home rules, deliveries today and tomorrow, protection checks due,
 * today's tasks — plus the card labels in English and Spanish. No money. Only jobs the caller
 * reaches (pm.res_field_sites filters by pm.my_job_ids); the phone caches the answer offline.
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false,
  query: z.object({ jobs: z.string().max(2000), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), lang: z.enum(['en', 'es']).default('en') }) },
  async ({ db, query }) => {
    const ids = [...new Set(query.jobs.split(',').map((s) => s.trim()).filter((s) => Uuid.safeParse(s).success))].slice(0, 50);
    const cards = ids.length ? await resRpc<FieldSiteCard[]>(db, 'res_field_sites', { p_jobs: ids, p_day: query.day ?? null }) : [];
    return { cards, labels: siteLabels(query.lang), labelsAlt: siteLabels(query.lang === 'es' ? 'en' : 'es') };
  });
