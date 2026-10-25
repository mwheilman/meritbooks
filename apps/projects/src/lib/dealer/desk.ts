import 'server-only';
import { z, type ZodTypeAny } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertCompany, type ReadyTenant } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { xcall } from './rpc';

/**
 * Multi-operation "desk" routes for the 1125 screens (dealer + manufacturing completion). Each
 * operation is one pm definer function: a Zod schema for its body, the function name, and the
 * argument mapping. The route parses `{ op }` first (so route()'s per-op grant runs), then the
 * operation's own schema, checks any company against the tenant, and calls the function on the
 * caller's RLS client. The database guard is the boundary; nothing here widens access.
 */

/** A prepared call: the operation's own schema already applied (typed where it is declared). */
export interface DeskCall {
  fn: string;
  prepare: (raw: unknown) => { args: Record<string, unknown>; company: string | null };
}

function issue(err: z.ZodError, what: string): HttpError {
  const first = err.issues[0];
  return new HttpError(422, first ? `${first.path.join('.') || what}: ${first.message}` : `Check the ${what.toLowerCase()}.`, 'VALIDATION');
}

function companyOf(data: unknown, key: 'companyId' | 'company'): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

/** One POST operation. */
export function op<S extends ZodTypeAny>(fn: string, schema: S, args: (b: z.infer<S>) => Record<string, unknown>): DeskCall {
  return {
    fn,
    prepare: (raw) => {
      const p = schema.safeParse(raw);
      if (!p.success) throw issue(p.error, 'Request');
      return { args: args(p.data), company: companyOf(p.data, 'companyId') };
    },
  };
}

/** One GET view (`?view=<key>` plus its own fields). */
export function view<S extends ZodTypeAny>(fn: string, schema: S, args: (q: z.infer<S>) => Record<string, unknown>): DeskCall {
  return {
    fn,
    prepare: (raw) => {
      const p = schema.safeParse(raw);
      if (!p.success) throw issue(p.error, 'Filter');
      return { args: args(p.data), company: companyOf(p.data, 'company') };
    },
  };
}

/** `{ op: <one of the keys> }` with the rest passed through to the op's own schema. */
export function deskBody<K extends string>(ops: Readonly<Record<K, DeskCall>>) {
  const keys = Object.keys(ops) as [K, ...K[]];
  return z.object({ op: z.enum(keys) }).passthrough();
}

export function deskQuery<K extends string>(views: Readonly<Record<K, DeskCall>>) {
  const keys = Object.keys(views) as [K, ...K[]];
  return z.object({ view: z.enum(keys) }).passthrough();
}

async function run(spec: DeskCall, raw: unknown, db: SupabaseClient, tenant: ReadyTenant): Promise<unknown> {
  const { args, company } = spec.prepare(raw);
  if (company) assertCompany(tenant, company);
  return xcall(db, spec.fn, args);
}

export function runOp<K extends string>(ops: Readonly<Record<K, DeskCall>>, body: { op: K }, db: SupabaseClient, tenant: ReadyTenant): Promise<unknown> {
  return run(ops[body.op], body, db, tenant);
}

export function runView<K extends string>(views: Readonly<Record<K, DeskCall>>, query: { view: K }, db: SupabaseClient, tenant: ReadyTenant): Promise<unknown> {
  return run(views[query.view], query, db, tenant);
}
