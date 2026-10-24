import 'server-only';
/**
 * Contacts and sites on the shared master (core.contacts / core.sites, migration 1111) through
 * core.create_contact / core.create_site, which match first and return the existing record on an
 * exact identifier. The contact door also asks core.match_parties itself so a person can choose.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError } from '@/lib/api-errors';
import { createContactArgs, createSiteArgs, type ContactInput, type SiteInput } from '@/lib/crm/contract';

function idOf(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && data !== null && typeof (data as { id?: unknown }).id === 'string') return (data as { id: string }).id;
  return null;
}

export async function createContact(db: SupabaseClient, c: ContactInput): Promise<string> {
  const res = await db.schema('core').rpc('create_contact', createContactArgs(c));
  if (res.error) throw new PmQueryError('add contact', res.error);
  const id = idOf(res.data);
  if (!id) throw new HttpError(500, 'The contact was not added. Try again.', 'CREATE_FAILED');
  return id;
}

export async function createSite(db: SupabaseClient, s: SiteInput): Promise<string> {
  const res = await db.schema('core').rpc('create_site', createSiteArgs(s));
  if (res.error) throw new PmQueryError('add site', res.error);
  const id = idOf(res.data);
  if (!id) throw new HttpError(500, 'The site was not added. Try again.', 'CREATE_FAILED');
  return id;
}

/** One line for the matcher: "12 Elm St, Ames, IA 50010". */
export function addressLine(a: { line1?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string | null {
  const s = [a.line1, a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return s || null;
}
