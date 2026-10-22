import { createAuthedServerSupabase } from '@/lib/supabase/authed';
import { isSpecificCompany } from '@/lib/company-scope';

/**
 * Server read of "is the Dealer Pack on for this client?" (dealer_pack_settings.enabled,
 * mig 169 — member-readable under RLS, so this runs as the signed-in user). Used to
 * seed pack-gated UI on first paint (the reports menu) so the server HTML and the
 * first client render agree. Fails quiet to OFF: a usability lens, not a security
 * boundary — every dealer page / API guards itself.
 */
export async function readDealerPackEnabled(locationId: string | null | undefined): Promise<boolean> {
  if (!locationId || !isSpecificCompany(locationId)) return false;
  try {
    const supabase = await createAuthedServerSupabase();
    if (!supabase) return false;
    const { data, error } = await supabase
      .from('dealer_pack_settings')
      .select('enabled')
      .eq('location_id', locationId)
      .maybeSingle();
    if (error) return false;
    return (data as { enabled: boolean | null } | null)?.enabled === true;
  } catch {
    return false;
  }
}
