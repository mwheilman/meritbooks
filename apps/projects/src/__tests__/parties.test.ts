/**
 * Customers and vendors on the one shared master (owner ruling 2026-10-21): the create-flow
 * schemas, the RPC argument mapping against the 1108 signatures, and that no app path writes a
 * provisional customer name any more.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NewCustomerBody, NewVendorBody, VENDOR_COMPLIANCE_NOTE, customerRpcArgs, sameName, vendorKindFor, vendorRpcArgs,
} from '@/lib/pm/parties/schemas';
import { customerPending, customerPendingMessage } from '@/components/jobs/CustomerPicker';

const MIG = resolve(__dirname, '../../../../packages/supabase/migrations');
const sql = readFileSync(resolve(MIG, '1108_pm_parties_and_labor.sql'), 'utf8');
const C = '0bf579d0-7e25-421c-956c-4f1be58fa640';

const params = (fn: string) => {
  const m = new RegExp(`create or replace function pm\\.${fn}\\(([\\s\\S]*?)\\) returns`).exec(sql);
  expect(m).not.toBeNull();
  return [...m![1]!.matchAll(/(p_[a-z_]+)\s/g)].map((x) => x[1]);
};

describe('customer create flow', () => {
  it('trims, blanks become null, the company is optional', () => {
    const r = NewCustomerBody.parse({ name: '  Harbor Holdings LLC ', email: '', phone: ' 515-555-0100 ', companyId: C });
    expect(r).toEqual({ name: 'Harbor Holdings LLC', email: null, phone: '515-555-0100', companyId: C, contactFirst: null, contactLast: null });
    expect(NewCustomerBody.parse({ name: 'Solo' }).companyId).toBeNull();
  });
  it('rejects a blank name, a bad email and an over-long name', () => {
    expect(NewCustomerBody.safeParse({ name: '   ' }).success).toBe(false);
    expect(NewCustomerBody.safeParse({ name: 'X', email: 'not-an-email' }).success).toBe(false);
    expect(NewCustomerBody.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(NewCustomerBody.safeParse({ name: 'X', companyId: 'nope' }).success).toBe(false);
  });
  it('maps to pm.create_customer exactly (names and order of the SQL signature)', () => {
    const args = customerRpcArgs(NewCustomerBody.parse({ name: 'Harbor', email: 'ap@harbor.example', contactFirst: 'Hana', contactLast: 'Harbor', companyId: C }));
    expect(Object.keys(args)).toEqual(params('create_customer'));
    expect(args).toEqual({ p_name: 'Harbor', p_email: 'ap@harbor.example', p_phone: null, p_location: C, p_contact_first: 'Hana', p_contact_last: 'Harbor' });
  });
  it('a typed name without a picked customer must be added or picked first', () => {
    expect(customerPending({ id: null, name: 'New Co' })).toBe(true);
    expect(customerPending({ id: C, name: 'New Co' })).toBe(false);
    expect(customerPending({ id: null, name: '  ' })).toBe(false);
    expect(customerPendingMessage({ id: null, name: ' New Co ' })).toBe('Add “New Co” as a new customer, or pick one from the list.');
  });
  it('dedupe matches the function: case and inner whitespace do not matter', () => {
    expect(sameName('  harbor   HOLDINGS llc ', 'Harbor Holdings LLC')).toBe(true);
    expect(sameName('Harbor Holdings', 'Harbor Holdings LLC')).toBe(false);
    expect(sql).toContain("lower(regexp_replace(btrim(coalesce(p_name, '')), '\\s+', ' ', 'g'))");
  });
});

describe('vendor create flow', () => {
  it('kind defaults to subcontractor; a PO is with a supplier', () => {
    expect(NewVendorBody.parse({ name: 'Pipes Plus' }).kind).toBe('SUBCONTRACTOR');
    expect(NewVendorBody.safeParse({ name: 'X', kind: 'LANDLORD' }).success).toBe(false);
    expect(vendorKindFor('PO')).toBe('SUPPLIER');
    expect(vendorKindFor('SUBCONTRACT')).toBe('SUBCONTRACTOR');
  });
  it('maps to pm.create_vendor exactly', () => {
    const args = vendorRpcArgs(NewVendorBody.parse({ name: 'Pipes Plus', email: 'office@pipes.example', kind: 'SUPPLIER', companyId: C }));
    expect(Object.keys(args)).toEqual(params('create_vendor'));
    expect(args).toEqual({ p_name: 'Pipes Plus', p_email: 'office@pipes.example', p_phone: null, p_kind: 'SUPPLIER', p_location: C });
  });
  it('vendors are provisional (W-9 MISSING) and Books-owned columns are never written', () => {
    const body = sql.slice(sql.indexOf('create or replace function pm.create_vendor('), sql.indexOf('end $$;', sql.indexOf('create or replace function pm.create_vendor(')));
    expect(body).toContain("insert into core.vendors (id, org_id, name, email, phone, w9_status, created_by)");
    expect(body).toContain("'MISSING'");
    expect(body).not.toMatch(/insert into core\.vendors[^;]*(tin_encrypted|is_1099_eligible|payment_terms_days|default_retainage_pct|default_account_id)/);
    expect(VENDOR_COMPLIANCE_NOTE).toBe('Merit Books will request their W-9 and certificate of insurance.');
  });
});

describe('no provisional customer names from the app', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
  it('job create, work-order new job and the import call create_customer, not a name-only set_job_customer', () => {
    for (const f of ['app/api/jobs/route.ts', 'lib/pm/ops/jobs.ts', 'app/api/onboarding/import/commit/route.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/set_job_customer/);
      expect(src, f).toMatch(/create_customer|createCustomerId/);
    }
    const patch = read('app/api/jobs/[jobId]/route.ts');
    expect(patch).toContain('p_customer_name: null');
  });
});
