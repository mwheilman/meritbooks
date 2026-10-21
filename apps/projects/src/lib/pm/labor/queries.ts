import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { one, pm, rows } from '@/lib/pm/db';
import {
  EMPLOYEE_CARD_COLS, LABOR_RATE_COLS, LABOR_SETTINGS_COLS,
  type EmployeeCardRow, type LaborRateRow, type LaborSettingsRow,
} from './types';

/** The company's labor defaults; null until someone saves them (burden and overhead then count as 0). */
export async function getLaborSettings(db: SupabaseClient, companyId: string): Promise<LaborSettingsRow | null> {
  return one<LaborSettingsRow>(await pm(db).from('labor_settings').select(LABOR_SETTINGS_COLS).eq('location_id', companyId).maybeSingle(), 'labor settings');
}

/** Rate cards with both rates side by side (pm.v_labor_rates, RLS). */
export async function listLaborRates(db: SupabaseClient, companyId: string, f: { activeOnly?: boolean } = {}): Promise<LaborRateRow[]> {
  let q = pm(db).from('v_labor_rates').select(LABOR_RATE_COLS).eq('location_id', companyId);
  if (f.activeOnly) q = q.eq('is_active', true);
  return rows<LaborRateRow>(await q.order('label'), 'labor rates');
}

export async function listEmployeeCards(db: SupabaseClient, companyId: string): Promise<EmployeeCardRow[]> {
  return rows<EmployeeCardRow>(await pm(db).from('employee_rate_cards').select(EMPLOYEE_CARD_COLS).eq('location_id', companyId), 'employee rate cards');
}
