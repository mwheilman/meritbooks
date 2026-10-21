import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { must } from '@/lib/api';
import { NewCustomerBody, customerRpcArgs } from './schemas';

/**
 * A typed customer name → a real core.customers id via pm.create_customer (1108). The function
 * dedupes on an exact case-insensitive name in the workspace, so a name already on file links
 * to that customer instead of creating a second one.
 */
export async function createCustomerId(db: SupabaseClient, name: string, companyId: string | null): Promise<string> {
  const parsed = NewCustomerBody.safeParse({ name, companyId });
  if (!parsed.success) throw new HttpError(422, 'Give the customer a name of up to 200 characters.', 'VALIDATION');
  const id = must(await db.schema('pm').rpc('create_customer', customerRpcArgs(parsed.data)), 'add customer') as string | null;
  if (!id) throw new HttpError(500, 'The customer was not added. Try again.', 'CREATE_FAILED');
  return id;
}
