import { isSpecificCompany } from '@/lib/company-scope';

/**
 * The company a URL's `?location_id=` asks for, if it is one of the caller's
 * assigned companies; otherwise null (unknown / unassigned ids are ignored so
 * a link can never scope a user to a company they can't see).
 */
export function companyFromUrl(search: string | URLSearchParams, assignedIds: readonly string[]): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const id = params.get('location_id')?.trim() ?? '';
  if (!isSpecificCompany(id)) return null;
  return assignedIds.includes(id) ? id : null;
}
