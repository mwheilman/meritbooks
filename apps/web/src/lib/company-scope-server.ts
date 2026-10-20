import { cookies } from 'next/headers';
import { ACTIVE_COMPANY_COOKIE, ALL_COMPANIES, isSpecificCompany } from '@/lib/company-scope';
import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { assertClientInScope } from '@/lib/rbac/client-scope';

/**
 * Server-side seed for the active company (audit 06 §L.3 L1).
 *
 * The client provider used to initialise from `document.cookie` in its useState
 * initializer, so the server rendered "All Companies" while the first client
 * render used the cookie's company — a text mismatch (React #425/#418) that made
 * React discard the server HTML (#423) and left the header on "All Companies"
 * until /api/me resolved. The app layout now reads the same cookie on the
 * server and passes it down, so both renders start from the same value, and the
 * company's display name is known on first paint.
 */
export interface InitialCompany {
  id: string;
  /** Null when the name couldn't be resolved server-side (no token / not visible). */
  name: string | null;
  shortCode: string | null;
}

export async function readInitialCompany(): Promise<InitialCompany> {
  let id: string = ALL_COMPANIES;
  try {
    const raw = cookies().get(ACTIVE_COMPANY_COOKIE)?.value;
    id = raw ? decodeURIComponent(raw) || ALL_COMPANIES : ALL_COMPANIES;
  } catch {
    return { id: ALL_COMPANIES, name: null, shortCode: null };
  }
  if (!isSpecificCompany(id)) return { id: ALL_COMPANIES, name: null, shortCode: null };

  try {
    const supabase = await createAuthedServerSupabase();
    if (!supabase) return { id, name: null, shortCode: null };
    // Client scope (IA M-4, mig 163): a cookie naming a client outside the caller's
    // assignments falls back to consolidated under `enforce` (shadow logs would_deny and
    // keeps today's behaviour; off is unchanged).
    const scope = await assertClientInScope({ supabase }, id, 'active_company');
    if (!scope.allowed) return { id: ALL_COMPANIES, name: null, shortCode: null };
    const { data } = await supabase
      .schema('core')
      .from('locations')
      .select('id, name, short_code')
      .eq('id', id)
      .maybeSingle();
    const row = data as { id: string; name: string; short_code: string | null } | null;
    if (!row) return { id, name: null, shortCode: null };
    return { id, name: row.name, // Same derivation as ActiveCompanyProvider so server and client agree.
    shortCode: (row.short_code || row.name).slice(0, 3).toUpperCase() };
  } catch {
    return { id, name: null, shortCode: null };
  }
}
