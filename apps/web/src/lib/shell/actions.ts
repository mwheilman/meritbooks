'use server';

import { z } from 'zod';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { getOrgToday } from '@/lib/dates/org-today';
import { assertClientInScope } from '@/lib/rbac/client-scope';

/**
 * Shell context reads for the merit-ui bar (Redesign R1): what the ⌘J context
 * chip says about the client you are working in — its current period status (the
 * chip's pip + "Oct open") and whether it is the tenant's OWN books (the Electric
 * own-books bar, IA-SPEC §3.1). Read-only, RLS-scoped through the caller's own
 * Supabase client, and the client must be in the caller's scope (IA M-4).
 *
 * Fails quiet: any error returns null and the chip simply shows the name.
 */

export type ShellPeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';

export interface ShellClientContext {
  id: string;
  /** "2026-10" — the org-calendar month the status is for. */
  month: string;
  periodStatus: ShellPeriodStatus;
  /** core.locations.is_tenant_own_books (generated from is_management_company, mig 156). */
  isOwnBooks: boolean;
}

const LocationId = z.string().uuid();

export async function getShellClientContext(locationId: string): Promise<ShellClientContext | null> {
  const parsed = LocationId.safeParse(locationId);
  if (!parsed.success) return null;
  try {
    const supabase = await createAuthedServerSupabase();
    if (!supabase) return null;
    const scope = await assertClientInScope({ supabase }, parsed.data, 'active_company');
    if (!scope.allowed) return null;

    const today = await getOrgToday(supabase, null);
    const [year, month] = today.split('-').map(Number);
    const [locRes, periodRes] = await Promise.all([
      supabase.schema('core').from('locations').select('id, is_tenant_own_books').eq('id', parsed.data).maybeSingle(),
      supabase
        .from('fiscal_periods')
        .select('status')
        .eq('location_id', parsed.data)
        .eq('period_year', year)
        .eq('period_month', month)
        .maybeSingle(),
    ]);
    if (locRes.error || !locRes.data) return null;
    const loc = locRes.data as { id: string; is_tenant_own_books: boolean | null };
    const status = (periodRes.data as { status?: string } | null)?.status;
    const periodStatus: ShellPeriodStatus =
      status === 'OPEN' || status === 'SOFT_CLOSE' || status === 'HARD_CLOSE' ? status : 'NO_PERIOD';
    return {
      id: loc.id,
      month: `${year}-${String(month).padStart(2, '0')}`,
      periodStatus,
      isOwnBooks: loc.is_tenant_own_books === true,
    };
  } catch {
    return null;
  }
}
