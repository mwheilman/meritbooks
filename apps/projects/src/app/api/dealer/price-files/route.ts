export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { xcall, xrows } from '@/lib/dealer/rpc';
import { PRICE_FILE_FORMATS, parsePriceFile, supersessionLoops } from '@/lib/dealer/price-files';
import { CompanyOnlyQ, IsoDate, Req, Text, Uuid } from '@/lib/dealer/schemas';

export interface PriceFileRowOut {
  id: string;
  manufacturer: string;
  format: string;
  file_name: string;
  effective_on: string;
  status: string;
  row_count: number;
  summary: Record<string, number>;
  created_at: string;
  applied_at: string | null;
}

/** Staged and applied OEM price files for a company, newest first. */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'part', query: CompanyOnlyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const files = await xrows<PriceFileRowOut>(db.schema('pm').from('dlr_price_files')
    .select('id, manufacturer, format, file_name, effective_on, status, row_count, summary, created_at, applied_at')
    .eq('location_id', query.company).order('created_at', { ascending: false }).limit(100), 'price files');
  return { files };
});

const Stage = z.object({
  companyId: Uuid,
  manufacturer: Req(20, 'The manufacturer line code'),
  format: z.enum(PRICE_FILE_FORMATS),
  fileName: Req(200, 'The file name'),
  effectiveOn: IsoDate.nullish(),
  text: z.string().min(1, 'The file is empty').max(12_000_000, 'Split files over 12 MB'),
  vendorId: Uuid.nullish(),
  note: Text(200).nullish(),
});

/** Map the file in the app (lib/dealer/price-files), stage it in the database (nothing changes until applied). */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'part', body: Stage }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const parsed = parsePriceFile(body.text, body.format);
  if (!parsed.rows.length) throw new HttpError(422, parsed.issues[0]?.message ?? 'No part rows were found in that file.', 'VALIDATION');
  const loops = supersessionLoops(parsed.rows);
  if (loops.length) throw new HttpError(422, `Supersessions loop back on themselves: ${loops.slice(0, 3).map((l) => l.join(' → ')).join('; ')}. Fix the file and try again.`, 'PM_SUPERSESSION_LOOP');
  if (parsed.rows.length > 50_000) throw new HttpError(422, 'At most 50,000 rows per file. Split the file.', 'VALIDATION');
  const staged = await xcall<{ file_id: string } & Record<string, number | string>>(db, 'dlr_stage_price_file', {
    p_location: body.companyId, p_manufacturer: body.manufacturer, p_format: body.format, p_file_name: body.fileName,
    p_effective_on: body.effectiveOn ?? parsed.effectiveOn ?? null, p_rows: parsed.rows, p_mfr_vendor: body.vendorId ?? null,
  });
  return { ...staged, issues: parsed.issues.slice(0, 200) };
});
