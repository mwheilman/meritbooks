import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { must } from '@/lib/api';
import { matchOrCreateCustomer } from '@/lib/parties/server';
import { NewCustomerBody, customerRpcArgs, type NewCustomer } from './schemas';

/** pm.create_customer (1108) for an already-validated customer. Returns the new (or name-matched) id. */
export async function insertCustomer(db: SupabaseClient, c: NewCustomer): Promise<string> {
  const id = must(await db.schema('pm').rpc('create_customer', customerRpcArgs(c)), 'add customer') as string | null;
  if (!id) throw new HttpError(500, 'The customer was not added. Try again.', 'CREATE_FAILED');
  return id;
}

/**
 * A typed customer name → a real core.customers id. Matching at the door first
 * (core.match_parties, SHARED-RECORDS §3): with nobody choosing, an exact identifier match is
 * the existing customer. Otherwise pm.create_customer (1108), which itself links an exact
 * case-insensitive name already on file instead of creating a second row.
 */
export async function createCustomerId(db: SupabaseClient, name: string, companyId: string | null): Promise<string> {
  const parsed = NewCustomerBody.safeParse({ name, companyId });
  if (!parsed.success) throw new HttpError(422, 'Give the customer a name of up to 200 characters.', 'VALIDATION');
  const r = await matchOrCreateCustomer(db, { name: parsed.data.name, email: null, phone: null }, () => insertCustomer(db, parsed.data));
  return r.id;
}
