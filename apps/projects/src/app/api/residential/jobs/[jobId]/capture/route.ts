export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Text, Uuid } from '@/lib/residential/schemas';

export interface SiteCaptureRow {
  id: string;
  status: 'DRAFT' | 'FINAL';
  rooms: Array<{ name: string; length_in: number | null; width_in: number | null; height_in: number | null; notes?: string | null }>;
  utilities: Record<string, string>;
  conditions: Record<string, string | number | boolean | null>;
  photo_document_ids: string[];
  transcript: string | null;
  measure_id: string | null;
  created_at: string;
  finalized_at: string | null;
}

/** In-home measure and site captures on a job (RES-11). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ db, params }) => {
  const rows = resWrote<SiteCaptureRow[]>(await pm(db).from('res_site_captures')
    .select('id, status, rooms, utilities, conditions, photo_document_ids, transcript, measure_id, created_at, finalized_at').eq('job_id', params.jobId!).order('created_at', { ascending: false }));
  return { captures: rows };
});

const Room = z.object({ name: Text(80).min(1, 'Name the room'), length_in: z.number().min(0).max(100000).nullish(), width_in: z.number().min(0).max(100000).nullish(),
  height_in: z.number().min(0).max(10000).nullish(), notes: Text(500).nullish() });
const Data = z.object({
  appointment_id: Uuid.nullish(),
  rooms: z.array(Room).max(100).optional(),
  utilities: z.record(z.string().max(60), z.string().max(300)).optional(),
  conditions: z.record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).optional(),
  photo_document_ids: z.array(Uuid).max(200).optional(),
  video_document_ids: z.array(Uuid).max(20).optional(),
  lidar_document_id: Uuid.nullish(),
  voice_document_id: Uuid.nullish(),
  transcript: Text(20000).nullish(),
});
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('save'), captureId: Uuid.nullish(), data: Data }),
  z.object({ op: z.literal('finalize'), captureId: Uuid }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: Body }, async ({ db, params, body }) => {
  if (body.op === 'save') return { captureId: await resRpc<string>(db, 'res_save_site_capture', { p_job: params.jobId!, p_capture: body.captureId ?? null, p_data: body.data }) };
  return resRpc(db, 'res_finalize_site_capture', { p_capture: body.captureId });
});
