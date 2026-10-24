import 'server-only';
/** Tie-out reads (pm.v_job_tieout), masked per row by the money the caller holds at that job's company. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Access } from '@/lib/access/types';
import { moneyVisFor } from '@/components/money/visibility';
import { PmQueryError } from '@/lib/api-errors';
import { TIEOUT_COLS, T, isMissingContract } from './contract';
import { maskTieout, parseTieout, type TieoutLoad, type TieoutRow } from './tieout';
import { openDuplicateCount } from './customers';

export type { TieoutLoad };

async function read(db: SupabaseClient, jobIds: ReadonlyArray<string>): Promise<TieoutRow[] | 'not_live'> {
  const out: TieoutRow[] = [];
  for (let i = 0; i < jobIds.length; i += 200) {
    const res = await db.schema(T.jobTieout.schema).from(T.jobTieout.table).select(`${TIEOUT_COLS}, as_of`).in('job_id', jobIds.slice(i, i + 200));
    if (res.error) {
      // as_of is an addition the contract may not carry: retry without it.
      if (res.error.code === '42703' || res.error.code === 'PGRST204') {
        const r2 = await db.schema(T.jobTieout.schema).from(T.jobTieout.table).select(TIEOUT_COLS).in('job_id', jobIds.slice(i, i + 200));
        if (r2.error) {
          if (isMissingContract(r2.error)) return 'not_live';
          throw new PmQueryError('tie-out', r2.error);
        }
        out.push(...parseTieout(r2.data));
        continue;
      }
      if (isMissingContract(res.error)) return 'not_live';
      throw new PmQueryError('tie-out', res.error);
    }
    out.push(...parseTieout(res.data));
  }
  return out;
}

export async function loadJobTieout(db: SupabaseClient, access: Access, jobId: string, companyId: string): Promise<TieoutLoad> {
  try {
    const rows = await read(db, [jobId]);
    if (rows === 'not_live') return { kind: 'not_live' };
    return { kind: 'ready', rows: maskTieout(rows, moneyVisFor(access, companyId)) };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[projects] job tie-out', e);
    return { kind: 'error', message: 'We couldn’t check this job against Merit Books.' };
  }
}

export interface CompanyTieoutLoad {
  load: TieoutLoad;
  pendingDuplicates: number | null;
}

/** Every job in view (by id → company), each row masked at its own company. */
export async function loadCompanyTieout(db: SupabaseClient, access: Access, jobs: ReadonlyMap<string, string>): Promise<CompanyTieoutLoad> {
  const pendingDuplicates = await openDuplicateCount(db).catch(() => null);
  try {
    const rows = await read(db, [...jobs.keys()]);
    if (rows === 'not_live') return { load: { kind: 'not_live' }, pendingDuplicates };
    const masked = rows.flatMap((r) => maskTieout([r], moneyVisFor(access, jobs.get(r.jobId) ?? null)));
    return { load: { kind: 'ready', rows: masked }, pendingDuplicates };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[projects] company tie-out', e);
    return { load: { kind: 'error', message: 'We couldn’t check your jobs against Merit Books.' }, pendingDuplicates };
  }
}
