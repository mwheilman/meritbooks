/**
 * SQL-emitting helpers for the Merit Projects demo seed (packages/supabase/seed/pm-demo).
 * Every helper returns plpgsql text that runs inside one `do $seed$ … $seed$` block as the
 * tenant's company_admin (role authenticated), so it only uses member RPCs and member grants.
 */

/** A raw SQL expression (not quoted). */
export class Raw {
  constructor(readonly sql: string) {}
}
export const R = (sql: string): Raw => new Raw(sql);

export const q = (s: string | null | undefined): string => (s == null ? 'null' : `'${s.replace(/'/g, "''")}'`);
export const jb = (o: unknown): string => `${q(JSON.stringify(o))}::jsonb`;
/** dollars -> integer cents */
export const usd = (d: number): number => Math.round(d * 100);

export function lit(v: unknown): string {
  if (v instanceof Raw) return v.sql;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return q(v);
  return jb(v);
}

export const values = (rows: unknown[][]): string => rows.map((r) => `(${r.map(lit).join(', ')})`).join(',\n      ');

/** timestamptz for a local Central time on a date expression */
export const at = (dayExpr: string, hhmm: string): string => `((${dayExpr}) + time '${hhmm}') at time zone 'America/Chicago'`;

/** guarded stage transitions; raises with the failing guards */
export function tr(...stages: string[]): string {
  return stages
    .map((s) => `    v_fail := pm.transition_stage(v_job, ${q(s)});
    if cardinality(v_fail) > 0 then raise exception 'DEMO %: move to % blocked by guards %', v_key, ${q(s)}, v_fail; end if;`)
    .join('\n');
}

/** one demo job: created (with everything under it) only when its marker is absent */
export function job(key: string, note: string, body: string): string {
  return `
  -- ------------------------------------------------------------------------
  -- ${key}: ${note}
  -- ------------------------------------------------------------------------
  v_key := ${q(key)};
  select p.job_id into v_job from pm.projects p where p.location_id = c_loc and p.ext ->> '_demo' = v_key;
  if v_job is null then
${body}
    n_jobs := n_jobs + 1;
  end if;
`;
}

export interface SiteInfo { line1: string; city: string; zip: string; start?: number; finish?: number }
export function site(s: SiteInfo): string {
  return `    update pm.projects set site_address_line1 = ${q(s.line1)}, site_city = ${q(s.city)}, site_state = 'IA', site_zip = ${q(s.zip)},
           planned_start = ${s.start === undefined ? 'null' : `current_date + ${s.start}`}, planned_finish = ${s.finish === undefined ? 'null' : `current_date + ${s.finish}`},
           pm_user_id = v_admin
     where job_id = v_job;`;
}

/** ORIGINAL budget by cost code: [code, description, dollars] */
export function budget(label: string, lines: [string, string, number][]): string {
  return `    insert into pm.budgets (job_id, kind, version, status, label, as_of) values (v_job, 'ORIGINAL', 1, 'APPROVED', ${q(label)}, current_date)
      returning id into v_budget;
    insert into pm.budget_lines (budget_id, cost_code_id, description, amount_cents, sort)
    select v_budget, c.id, x.d, x.a::bigint, x.s
      from (values
      ${values(lines.map(([code, d, dollars], i) => [code, d, usd(dollars), i + 1]))}) x(code, d, a, s)
      join pm.cost_codes c on c.location_id = c_loc and c.job_id is null and c.code = x.code;
    get diagnostics v_n = row_count;
    if v_n <> ${lines.length} then raise exception 'DEMO %: budget matched % of ${lines.length} cost codes', v_key, v_n; end if;`;
}

export interface EstLine { code: string | null; d: string; qty: number; uom: string; cost: number; price: number; allowance?: boolean }
/** estimate header + lines (unit amounts in cents); sets v_est (or the named variable) */
export function estimate(opts: { v?: string; title: string; retainage?: number | null; valid: string; notes?: string; lines: EstLine[] }): string {
  const v = opts.v ?? 'v_est';
  const rows = opts.lines.map((l, i) => [i + 1, l.code, l.d, l.qty, l.uom, l.cost, l.price, Math.round(l.qty * l.cost), Math.round(l.qty * l.price), !!l.allowance]);
  return `    insert into pm.estimates (job_id, title, retainage_pct, valid_until, notes)
      values (v_job, ${q(opts.title)}, ${opts.retainage ?? 'null'}, ${opts.valid}, ${q(opts.notes ?? null)}) returning id into ${v};
    insert into pm.estimate_lines (estimate_id, line_no, sort, cost_code_id, description, qty, uom, unit_cost_cents, unit_price_cents, cost_cents, amount_cents, is_allowance)
    select ${v}, x.n, x.n, c.id, x.d, x.qty::numeric, x.uom, x.uc::bigint, x.up::bigint, x.cost::bigint, x.amt::bigint, x.allow
      from (values
      ${values(rows)}) x(n, code, d, qty, uom, uc, up, cost, amt, allow)
      left join pm.cost_codes c on c.location_id = c_loc and c.job_id is null and c.code = x.code;
    get diagnostics v_n = row_count;
    if v_n <> ${rows.length} or exists (select 1 from pm.estimate_lines l where l.estimate_id = ${v} and l.cost_code_id is null and l.cost_cents <> 0) then
      raise exception 'DEMO %: estimate lines did not resolve their cost codes', v_key;
    end if;`;
}
export const estTotal = (lines: EstLine[]): number => lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0);
export const estCost = (lines: EstLine[]): number => lines.reduce((s, l) => s + Math.round(l.qty * l.cost), 0);

export interface TaskRow { t: string; s: number; d: number; st: 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE'; pct?: number | null; ms?: boolean; who?: 'admin' | 'tech' | null }
export function tasks(rows: TaskRow[]): string {
  return `    insert into pm.tasks (job_id, title, status, is_milestone, start_on, due_on, duration_days, pct_complete, sort, completed_at, assignee_user_id, assignee_employee_id)
    select v_job, x.t, x.st, x.ms, current_date + x.s, current_date + x.d, x.d - x.s, x.pct::numeric, x.n,
           case when x.st = 'DONE' then now() end, case when x.who = 'admin' then v_admin end, case when x.who = 'tech' then v_tech end
      from (values
      ${values(rows.map((r, i) => [i + 1, r.t, r.st, !!r.ms, r.s, r.d, r.st === 'DONE' ? 1 : (r.pct ?? null), r.who ?? null]))}) x(n, t, st, ms, s, d, pct, who);`;
}

export interface LogRow { body: string; wx: string; hi: number; lo: number; crew: number }
/** daily logs on the last N weekdays before today (most recent first) */
export function dailyLogs(rows: LogRow[], offsetDays = 0): string {
  return `    insert into pm.field_logs (job_id, kind, log_date, body, weather, crew_count, hours, ext)
    select v_job, 'DAILY', w.d, x.body, jsonb_build_object('summary', x.wx, 'high_f', x.hi, 'low_f', x.lo), x.crew, x.crew * 8,
           jsonb_build_object('manpower', x.crew, 'weather', x.wx || ', ' || x.hi || '°F / ' || x.lo || '°F')
      from (select g::date as d, row_number() over (order by g desc) as rn
              from generate_series(current_date - ${offsetDays + 14}, current_date - ${offsetDays + 1}, interval '1 day') g
             where extract(isodow from g) < 6) w
      join (values
      ${values(rows.map((r, i) => [i + 1, r.body, r.wx, r.hi, r.lo, r.crew]))}) x(rn, body, wx, hi, lo, crew) on x.rn = w.rn;`;
}

/** change order (member insert = PCO); `cor` advances it to COR (submitted to the owner) */
export function changeOrder(o: { title: string; desc: string; reason: string; amount: number; cost: number; days?: number; cor?: boolean }): string {
  return `    insert into pm.change_orders (job_id, contract_id, title, description, reason, amount_cents, cost_impact_cents, schedule_days)
      values (v_job, pm.primary_contract_id(c_org, v_job), ${q(o.title)}, ${q(o.desc)}, ${q(o.reason)}, ${usd(o.amount)}, ${usd(o.cost)}, ${o.days ?? 'null'})
      returning id into v_co;${o.cor ? `
    perform pm.advance_change_order(v_co, 'COR');` : ''}`;
}

/** commitment (DRAFT) with lines: [code, description, dollars] */
export function commitment(o: { type: 'PO' | 'SUBCONTRACT'; vendor: string; title: string; desc?: string; retainage: number; lines: [string, string, number][] }): string {
  return `    insert into pm.commitments (job_id, vendor_id, commitment_type, title, description, retainage_pct)
      values (v_job, ${o.vendor}, ${q(o.type)}, ${q(o.title)}, ${q(o.desc ?? null)}, ${o.retainage}) returning id into v_cmt;
    insert into pm.commitment_lines (commitment_id, line_no, cost_code_id, description, amount_cents)
    select v_cmt, x.n, c.id, x.d, x.a::bigint
      from (values
      ${values(o.lines.map(([code, d, dollars], i) => [i + 1, code, d, usd(dollars)]))}) x(n, code, d, a)
      join pm.cost_codes c on c.location_id = c_loc and c.job_id is null and c.code = x.code;
    get diagnostics v_n = row_count;
    if v_n <> ${o.lines.length} then raise exception 'DEMO %: commitment lines matched % of ${o.lines.length} cost codes', v_key, v_n; end if;`;
}

/** time entries (SUBMITTED; rates are pinned only at approval by someone other than the preparer) */
export function timeEntries(rows: { day: number; hours: number; pay?: string; code: string; notes: string; wo?: string | null }[]): string {
  return `    insert into pm.time_entries (job_id, employee_id, work_date, hours, pay_type, cost_code_id, notes, approval_state, work_order_id)
    select v_job, v_tech, current_date + x.day, x.h::numeric, x.pay, c.id, x.notes, 'SUBMITTED', x.wo::uuid
      from (values
      ${values(rows.map((r) => [r.day, r.hours, r.pay ?? 'REG', r.code, r.notes, r.wo ? R(`${r.wo}::text`) : null]))}) x(day, h, pay, code, notes, wo)
      join pm.cost_codes c on c.location_id = c_loc and c.job_id is null and c.code = x.code;`;
}

export interface Party { v: string; name: string; email?: string; phone?: string; first?: string; last?: string; kind?: 'SUBCONTRACTOR' | 'SUPPLIER' | 'OTHER' }

/** read-only lookup of an existing demo party (run before the role switch; nothing is written) */
export function lookupCustomer(p: Party): string {
  return `  select c.id into ${p.v} from core.customers c
   where c.org_id = c_org and c.deleted_at is null and lower(regexp_replace(btrim(c.name), '\\s+', ' ', 'g')) = lower(${q(p.name)})
   order by c.is_active desc, c.created_at, c.id limit 1;`;
}
export function lookupVendor(p: Party): string {
  return `  select v.id into ${p.v} from core.vendors v
   where v.org_id = c_org and v.deleted_at is null and lower(regexp_replace(btrim(v.name), '\\s+', ' ', 'g')) = lower(${q(p.name)})
   order by v.is_active desc, v.created_at, v.id limit 1;`;
}
export function createCustomer(p: Party): string {
  return `  if ${p.v} is null then
    ${p.v} := pm.create_customer(${q(p.name)}, ${q(p.email ?? null)}, ${q(p.phone ?? null)}, c_loc, ${q(p.first ?? null)}, ${q(p.last ?? null)});
    n_cust := n_cust + 1;
  end if;`;
}
export function createVendor(p: Party): string {
  return `  if ${p.v} is null then
    ${p.v} := pm.create_vendor(${q(p.name)}, ${q(p.email ?? null)}, ${q(p.phone ?? null)}, ${q(p.kind ?? 'SUBCONTRACTOR')}, c_loc);
    n_vend := n_vend + 1;
  end if;`;
}

export interface FileSpec {
  title: string;
  orgId: string;
  locationId: string;
  shortCode: string;
  packKey: string;
  plan: unknown;
  customers: Party[];
  vendors: Party[];
  /** extra declare lines */
  declare?: string[];
  /** company-level setup run after parties (labor, assets, stock locations …) */
  setup: string;
  jobs: string;
}

/** The single do-block for one company. */
export function seedFile(f: FileSpec): string {
  const planJson = JSON.stringify(f.plan);
  if (planJson.includes('$plan$')) throw new Error('plan json contains the dollar-quote tag');
  const partyVars = [...f.customers, ...f.vendors].map((p) => `  ${p.v} uuid;`).join('\n');
  return `-- ============================================================================
-- Merit Projects demo seed — ${f.title}
-- GENERATED by packages/supabase/seed/pm-demo/generate.ts — do not edit by hand.
--
-- Runs as the tenant's active company_admin (looked up below; role authenticated, JWT sub only)
-- and writes ONLY through pm member RPCs and the tables members may write. Idempotent: the pack
-- is applied only when the company has no ACTIVE primary install, parties are reused by name,
-- and every job is guarded by pm.projects.ext->>'_demo', so a second run inserts nothing.
-- ============================================================================
do $seed$
declare
  c_org  constant uuid := '${f.orgId}';
  c_loc  constant uuid := '${f.locationId}';
  c_pack constant text := '${f.packKey}';
  v_plan jsonb := $plan$${planJson}$plan$::jsonb;
  v_admin       text;     -- Clerk user id of the company_admin we run as (never printed)
  v_admin_emp   uuid;
  v_admin_label text;
  v_tech        uuid;     -- an existing active core.employees row used as the field tech / installer
  v_tech_label  text;
  v_pack        text;
  v_install     uuid;
  v_applied     boolean := false;
  v_job uuid; v_key text; v_est uuid; v_est2 uuid; v_j jsonb; v_budget uuid; v_sov uuid; v_bill uuid;
  v_cmt uuid; v_cmt2 uuid; v_doc uuid; v_co uuid; v_wo uuid; v_wo2 uuid; v_res jsonb; v_sel uuid; v_sel2 uuid;
  v_opt uuid; v_item uuid; v_meas uuid; v_asset uuid; v_agr uuid; v_card uuid; v_card2 uuid; v_stock uuid;
  v_fail text[]; v_n int; v_amt bigint;
  v_thu date := current_date + ((10 - extract(isodow from current_date)::int) % 7) + 1;   -- next Thursday (1–7 days out)
  v_tue date := current_date + ((8 - extract(isodow from current_date)::int) % 7) + 1;    -- next Tuesday (1–7 days out)
  v_period_end date := case when extract(day from current_date) <= 25
                            then date_trunc('month', current_date)::date + 24
                            else (date_trunc('month', current_date) + interval '1 month')::date + 24 end;  -- pay-app cutoff (25th)
  n_jobs int := 0; n_cust int := 0; n_vend int := 0;
${partyVars}
${(f.declare ?? []).map((d) => `  ${d}`).join('\n')}
begin
  -- ---- 0. who we run as (read-only lookups as the migration owner; nothing is written here) ----
  select e.clerk_user_id, e.id, e.role || ' ' || e.first_name || ' ' || e.last_name
    into v_admin, v_admin_emp, v_admin_label
    from core.employees e
   where e.org_id = c_org and e.role = 'company_admin' and e.is_active and e.clerk_user_id is not null
   order by e.created_at, e.id limit 1;
  if v_admin is null then
    raise exception 'DEMO: org % has no active company_admin with a Clerk user id; nothing seeded', c_org;
  end if;
  -- field tech: an existing active employee other than the admin (Core owns employees; never inserted here)
  select e.id, e.role || ' ' || e.first_name || ' ' || e.last_name into v_tech, v_tech_label
    from core.employees e
   where e.org_id = c_org and e.is_active and e.id <> v_admin_emp
   order by (lower(e.first_name || ' ' || e.last_name) ~ '(install|tech|service)') desc, e.created_at, e.id limit 1;
  if v_tech is null then v_tech := v_admin_emp; v_tech_label := v_admin_label || ' (only employee)'; end if;
  -- existing demo parties (reused by name so a rerun calls no RPC and writes no activity)
${[...f.customers.map(lookupCustomer), ...f.vendors.map(lookupVendor)].join('\n')}

  -- ---- 1. become the company_admin ----
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.get_org_id() is distinct from c_org then
    raise exception 'DEMO: the company_admin does not resolve to org % (active in more than one org?)', c_org;
  end if;

  -- ---- 2. pack ----
  select i.pack_key into v_pack from pm.pack_installs i
   where i.location_id = c_loc and i.role = 'primary' and i.status = 'ACTIVE';
  if v_pack is null then
    v_install := pm.apply_pack_plan(v_plan, 'primary');
    v_applied := true;
  elsif v_pack <> c_pack then
    raise exception 'DEMO: ${f.shortCode} already runs primary pack % (expected %); not seeding over it', v_pack, c_pack;
  end if;

  -- ---- 3. customers and vendors (shared master via pm.create_customer / pm.create_vendor) ----
${[...f.customers.map(createCustomer), ...f.vendors.map(createVendor)].join('\n')}

  -- ---- 4. company setup ----
${f.setup}

  -- ---- 5. jobs ----
${f.jobs}

  -- ---- 6. summary ----
  raise notice 'DEMO ${f.shortCode}: ran as %; field tech %; pack % (%); this run created % job(s), % customer(s), % vendor(s)',
    v_admin_label, v_tech_label, c_pack, case when v_applied then 'applied now' else 'already installed' end, n_jobs, n_cust, n_vend;
  raise notice 'DEMO ${f.shortCode} totals: % demo jobs (% sample, % real); % tasks; % budget lines; % estimates (% accepted); % change orders; % commitments; % work orders (% dispatched); % billing requests; % deposit requests; % selections; % assets; % agreements; % time entries; % daily logs; % Books events from demo jobs',
    (select count(*) from pm.projects p where p.location_id = c_loc and p.ext ? '_demo'),
    (select count(*) from pm.projects p where p.location_id = c_loc and p.ext ? '_demo' and p.is_sample),
    (select count(*) from pm.projects p where p.location_id = c_loc and p.ext ? '_demo' and not p.is_sample),
    (select count(*) from pm.tasks t join pm.projects p on p.job_id = t.job_id where p.location_id = c_loc and p.ext ? '_demo'),
    (select count(*) from pm.budget_lines l join pm.budgets b on b.id = l.budget_id join pm.projects p on p.job_id = b.job_id where p.location_id = c_loc and p.ext ? '_demo'),
    (select count(*) from pm.estimates e where e.location_id = c_loc),
    (select count(*) from pm.estimates e where e.location_id = c_loc and e.status = 'ACCEPTED'),
    (select count(*) from pm.change_orders x join pm.projects p on p.job_id = x.job_id where p.location_id = c_loc and p.ext ? '_demo'),
    (select count(*) from pm.commitments x where x.location_id = c_loc),
    (select count(*) from pm.work_orders w where w.location_id = c_loc),
    (select count(distinct d.work_order_id) from pm.dispatch_assignments d join pm.work_orders w on w.id = d.work_order_id where w.location_id = c_loc and d.status <> 'CANCELLED'),
    (select count(*) from pm.billing_requests r where r.location_id = c_loc),
    (select count(*) from pm.deposit_requests r where r.location_id = c_loc),
    (select count(*) from pm.selections s join pm.projects p on p.job_id = s.job_id where p.location_id = c_loc),
    (select count(*) from pm.assets a where a.location_id = c_loc),
    (select count(*) from pm.service_agreements a where a.location_id = c_loc),
    (select count(*) from pm.time_entries t join pm.projects p on p.job_id = t.job_id where p.location_id = c_loc and p.ext ? '_demo'),
    (select count(*) from pm.field_logs l join pm.projects p on p.job_id = l.job_id where p.location_id = c_loc and p.ext ? '_demo'),
    (select count(*) from core.events e where e.org_id = c_org and e.source_module = 'PROJECTS'
        and e.payload ->> 'job_id' in (select p.job_id::text from pm.projects p where p.location_id = c_loc and p.ext ? '_demo'));
end
$seed$;
`;
}
