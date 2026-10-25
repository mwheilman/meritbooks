/**
 * 1114 suite notifications against the full migration chain (Books 178 + 1110 … 1124):
 * recipe fan-out by role, money masking, preferences / mandatory / muted, quiet hours, frequency
 * caps, batching, digests, customer messages held until go-live, SMS consent + STOP, the inbox
 * under RLS (incl. Projects-only seats), the worker surface and the registry guards.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildFixture, as, q, errorOf, type Fixture, type Persona, ORG_A, ORG_B, L1, L2, LB, J1, J2, J3 } from './fixture';
import { applyMigration, listMigrationFiles } from './pg';
import { recipeDefaults } from '../../../apps/projects/src/lib/notify/recipes';

let f: Fixture;
const forbidden = /PM_FORBIDDEN/;
const TOKEN = (p: string) => `ExponentPushToken[${p}0000000000xyz]`;

interface NoteRow {
  id: string; membership_id: string; event_type: string; title: string; body: string | null; delivery: string;
  money_masked: boolean; item_count: number; read_at: string | null; job_id: string | null;
}

async function notes(event: string, where = '', params: unknown[] = []): Promise<NoteRow[]> {
  return q<NoteRow>(f.db, `select id, membership_id, event_type, title, body, delivery, money_masked, item_count, read_at, job_id
                             from core.notifications where event_type = $1 ${where} order by created_at`, [event, ...params]);
}
const byMember = (rows: NoteRow[], p: Persona) => rows.filter((r) => r.membership_id === f.membership[p]);

async function pushes(p: Persona): Promise<Array<{ status: string; status_reason: string | null; event_type: string; not_before: string }>> {
  return q(f.db, `select status, status_reason, event_type, not_before::text from core.outbound_messages
                   where channel = 'push' and membership_id = $1 order by created_at`, [f.membership[p]]);
}

/** Run as postgres but with a member's JWT (the actor for triggers), no SET ROLE. */
async function actingAs<T>(p: Persona | null, fn: () => Promise<T>, role: 'authenticated' | 'service_role' = 'authenticated'): Promise<T> {
  await f.db.query(`select set_config('request.jwt.claims', $1, false)`,
    [p ? JSON.stringify({ sub: f.clerk[p], org_id: ORG_A, role }) : '{}']);
  try {
    return await fn();
  } finally {
    await f.db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

/** A pending approval request (1113 table) with one current step, submitted by `by`. */
async function approvalRequest(o: { job: string; title: string; amount: number; by: Persona; cap?: string | null; roles?: string[] }): Promise<string> {
  const r = await q<{ id: string }>(f.db,
    `insert into pm.approval_requests (org_id, location_id, job_id, object_type, object_id, title, summary, amount_cents, preparers, submitted_by, snapshot_hash, money_cap)
     select $1, j.location_id, j.id, 'commitment', gen_random_uuid(), $3, 'Lumber order', $4, array[$5::text], $5, 'h', 'projects.financials' from core.jobs j where j.id = $2
     returning id`, [ORG_A, o.job, o.title, o.amount, f.clerk[o.by]]);
  await f.db.query(`insert into pm.approval_request_steps (org_id, request_id, step_order, label, approver_roles, approver_capability, status)
                    values ($1, $2, 1, 'Manager approval', $3::text[], $4, 'PENDING')`, [ORG_A, r[0]!.id, o.roles ?? [], o.cap === undefined ? 'projects.commitments:approve' : o.cap]);
  return r[0]!.id;
}

beforeAll(async () => {
  f = await buildFixture();
  // The chain through 1124: 1111 shared records, 1112 schedule, 1113 approvals (approval
  // notifications are built from its requests), 1114 notifications, then every later Projects
  // migration up to 1124, whose W1b block seeds the Wave C role recipes — so the DB == code parity
  // below covers every platform recipe row. All must apply (none is skipped).
  for (const file of listMigrationFiles().filter((x) => { const n = parseInt(x, 10); return n >= 1111 && n <= 1124; })) await applyMigration(f.db, file);
  for (const p of ['gm', 'pm', 'dispatcher', 'labor', 'supervisor', 'owner'] as const) {
    await as(f, p, async () => {
      await f.db.query(`select pm.notify_register_device($1, 'ios', 'Phone', '1.0')`, [TOKEN(p)]);
    });
  }
}, 600_000);

afterAll(async () => {
  await f?.db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('guards: every new table protected, every member RPC guarded or allowlisted', () => {
  it('no unguarded pm RPC, no unprotected core table, no unregistered crm/core RPC', async () => {
    expect(await q(f.db, `select * from pm.access_unguarded_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_seat_unprotected_tables()`)).toEqual([]);
    expect(await q(f.db, `select * from crm.access_unregistered_rpcs()`)).toEqual([]);
    expect(await q(f.db, `select * from pm.access_unclassified_tables()`)).toEqual([]);
  });
  it('the engine is service-only; members get only the pm.notify_* surface; anon nothing', async () => {
    const r = await q<{ sig: string; auth: boolean; anon: boolean }>(f.db,
      `select p.oid::regprocedure::text sig, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('anon', p.oid, 'execute') anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'core' and (p.proname like 'notify\\_%' or p.proname like 'tg\\_notify\\_%') and p.proname <> 'notify_caller_membership')
           or (n.nspname = 'pm' and p.proname like 'notify\\_%')`);
    expect(r.length).toBeGreaterThan(25);
    for (const x of r) {
      expect(x.anon, x.sig).toBe(false);
      expect(x.auth, x.sig).toBe(x.sig.startsWith('pm.'));
    }
  });
  it('members cannot write any notification table directly, and cannot read push tokens', async () => {
    for (const t of ['notifications', 'outbound_messages', 'push_devices', 'sms_consents', 'notification_settings', 'notification_pref_rules', 'notification_recipes']) {
      const err = await as(f, 'owner', async () => errorOf(f.db, `delete from core.${t}`));
      expect(err, t).toMatch(/permission denied/);
    }
    expect(await as(f, 'gm', async () => errorOf(f.db, `select token from core.push_devices`))).toMatch(/permission denied/);
    const own = await as(f, 'gm', async () => q<{ membership_id: string }>(f.db, `select membership_id from core.push_devices`));
    expect(own.map((r) => r.membership_id)).toEqual([f.membership.gm]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recipes: DB == code (apps/projects/src/lib/notify/recipes.ts)', () => {
  it('every platform default matches RECIPE_CODES', async () => {
    const rows = await q<{ persona_key: string; event_type: string; in_app: string; push: string; email: string; sms: string }>(f.db,
      `select persona_key, event_type, in_app, push, email, sms from core.notification_recipes where org_id is null`);
    const db = new Map(rows.map((r) => [`${r.persona_key}|${r.event_type}`, r]));
    const code = recipeDefaults();
    expect(rows.length).toBe(code.length);
    for (const c of code) {
      const r = db.get(`${c.persona}|${c.event}`);
      expect({ in_app: r?.in_app, push: r?.push, email: r?.email, sms: r?.sms }, `${c.persona} ${c.event}`)
        .toEqual({ in_app: c.in_app, push: c.push, email: c.email, sms: c.sms });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recipe fan-out by role', () => {
  it('job.assigned: the person added gets it (push for crew); the actor never does', async () => {
    await as(f, 'owner', async () => {
      await f.db.query(`select pm.job_team_upsert($1, $2, 'crew')`, [J1, f.membership.labor]);
      await f.db.query(`select pm.job_team_upsert($1, $2, 'superintendent')`, [J1, f.membership.supervisor]);
      await f.db.query(`select pm.job_team_upsert($1, $2, 'pm')`, [J2, f.membership.owner]);
    });
    const rows = await notes('job.assigned');
    expect(byMember(rows, 'labor').map((r) => r.title)).toEqual(['You were added to J1']);
    expect(byMember(rows, 'supervisor')).toHaveLength(1);
    expect(byMember(rows, 'owner')).toHaveLength(0); // the actor
    expect((await pushes('labor')).map((p) => [p.event_type, p.status])).toEqual([['job.assigned', 'queued']]);
  });

  it('change_order.signed: job team + billing approvers, per-role channels; labor (—) gets nothing', async () => {
    // the 1113 engine executes the approval (service context, on behalf of the PM)
    await actingAs('pm', async () => {
      await f.db.query(`update pm.change_orders set stage = 'APPROVED', approved_at = now() where id = $1`, [f.ids[`co:${J1}`]]);
    }, 'service_role');
    const rows = await notes('change_order.signed');
    const who = (p: Persona) => byMember(rows, p)[0];
    expect(who('pm')).toBeUndefined();                       // the actor
    expect(who('labor')).toBeUndefined();                    // crew: never (§2e)
    expect(who('dispatcher')).toBeUndefined();               // not on the team, no billing approval
    expect(who('legacyPm')?.delivery).toBe('instant');       // PM on the job: P
    expect(who('gm')?.delivery).toBe('instant');             // GM: P
    expect(who('accountant')?.delivery).toBe('instant');     // PA: I
    expect(who('owner')?.delivery).toBe('digest');           // Owner: D
    expect(who('supervisor')?.delivery).toBe('digest');      // Super on the team: D
    expect((await pushes('gm')).map((p) => p.event_type)).toContain('change_order.signed');
    expect((await pushes('owner')).map((p) => p.event_type)).not.toContain('change_order.signed');
    expect((await pushes('accountant'))).toEqual([]);
  });

  it('a second approval of the same change order notifies nobody twice (dedupe)', async () => {
    const before = (await notes('change_order.signed')).length;
    await actingAs('pm', async () => {
      await f.db.query(`update pm.change_orders set stage = 'PCO', approved_at = null where id = $1`, [f.ids[`co:${J1}`]]);
      await f.db.query(`update pm.change_orders set stage = 'APPROVED', approved_at = now() where id = $1`, [f.ids[`co:${J1}`]]);
    }, 'service_role');
    expect((await notes('change_order.signed')).length).toBe(before);
  });

  it('time.submitted: approvers who reach the job, batched into one row per approver', async () => {
    for (let i = 0; i < 2; i++) {
      await actingAs('labor', async () => {
        await f.db.query(`insert into pm.time_entries (org_id, job_id, employee_id, work_date, hours, approval_state) values ($1, $2, $3, current_date - $4::int, 4, 'SUBMITTED')`,
          [ORG_A, J2, f.employee.labor, i + 1]);
      });
    }
    const rows = await notes('time.submitted');
    expect(byMember(rows, 'gm')).toHaveLength(1);
    expect(byMember(rows, 'gm')[0].item_count).toBe(2);
    expect(byMember(rows, 'gm')[0].body).toMatch(/^2 updates\. Latest:/);
    expect(byMember(rows, 'pm')).toHaveLength(0);          // time:approve, but J2 is not their job
    expect(byMember(rows, 'supervisor')).toHaveLength(0);  // same
    expect(byMember(rows, 'labor')).toHaveLength(0);       // the submitter
    expect(byMember(rows, 'legacyStaff')[0]?.delivery).toBe('instant'); // backfilled projects_pm (all jobs): I
  });

  it('task.assigned / punch.assigned reach the assignee (employee or user)', async () => {
    await f.db.query(`insert into pm.tasks (org_id, job_id, title, assignee_employee_id) values ($1, $2, 'Hang doors', $3)`, [ORG_A, J2, f.employee.labor]);
    await f.db.query(`insert into pm.punch_items (org_id, job_id, title, assignee_user_id) values ($1, $2, 'Touch up paint', $3)`, [ORG_A, J1, f.clerk.supervisor]);
    expect(byMember(await notes('task.assigned'), 'labor').map((r) => r.title)).toEqual(['New task: Hang doors']);
    expect(byMember(await notes('punch.assigned'), 'supervisor').map((r) => r.title)).toEqual(['Punch item: Touch up paint']);
  });

  it('schedule.changed: an assigned open task that moves later notifies its assignee', async () => {
    const t = await q<{ id: string }>(f.db, `select id from pm.tasks where job_id = $1 and assignee_user_id = $2 limit 1`, [J1, f.clerk.supervisor]);
    await f.db.query(`update pm.tasks set start_on = current_date + 3, due_on = current_date + 5 where id = $1`, [t[0].id]);
    await f.db.query(`update pm.tasks set start_on = current_date + 6, due_on = current_date + 9 where id = $1`, [t[0].id]);
    const rows = byMember(await notes('schedule.changed'), 'supervisor');
    expect(rows).toHaveLength(1);           // batched (60-minute window)
    expect(rows[0].title).toBe('Schedule changed on J1');
  });

  it('lead.assigned: the owner of the lead; estimated value only with contract_value', async () => {
    const pl = await q<{ pipeline_id: string; stage_id: string }>(f.db,
      `select p.id pipeline_id, s.id stage_id from crm.pipelines p join crm.pipeline_stages s on s.pipeline_id = p.id
        where p.location_id = $1 and p.is_default and s.kind = 'open' order by s.sort limit 1`, [L1]);
    const ins = async (title: string, owner: Persona) => (await q<{ id: string }>(f.db,
      `insert into crm.leads (org_id, location_id, pipeline_id, stage_id, title, owner_membership_id, estimated_value_cents, created_at)
       values ($1, $2, $3, $4, $5, $6, 4200000, now() - interval '3 hours') returning id`,
      [ORG_A, L1, pl[0].pipeline_id, pl[0].stage_id, title, f.membership[owner]]))[0].id;
    f.ids.leadD = await ins('Kitchen remodel — Smith', 'dispatcher');
    f.ids.leadG = await ins('Basement — Lee', 'gm');
    const rows = await notes('lead.assigned');
    const d = byMember(rows, 'dispatcher')[0];
    const g = byMember(rows, 'gm')[0];
    expect(d.money_masked).toBe(true);
    expect(d.body ?? '').not.toMatch(/\$/);
    expect(g.money_masked).toBe(false);
    expect(g.body).toContain('$42,000.00');
    expect((await pushes('dispatcher')).map((p) => p.event_type)).toContain('lead.assigned');
  });

  it('speed-to-lead breach: owner + sales managers, once per lead', async () => {
    const n1 = (await q<{ n: number }>(f.db, `select core.notify_sweep(now()) n`))[0].n;
    expect(n1).toBeGreaterThan(0);
    const rows = await notes('lead.sla_breach');
    expect(byMember(rows, 'dispatcher').map((r) => r.title)).toEqual([expect.stringMatching(/^Lead waiting 3 h: Kitchen remodel/)]);
    expect(byMember(rows, 'owner').length).toBe(2);              // a manager at L1, digest (D)
    expect(byMember(rows, 'owner')[0].delivery).toBe('digest');
    expect((await q<{ n: number }>(f.db, `select core.notify_sweep(now()) n`))[0].n).toBe(0);
    // a lead with a logged call is not a breach
    await f.db.query(`insert into crm.activities (org_id, location_id, lead_id, kind) values ($1, $2, $3, 'call')`, [ORG_A, L1, f.ids.leadG]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('money masking (a notification never carries money the recipient cannot see)', () => {
  it('the change order amount reaches contract_value holders only', async () => {
    const rows = await notes('change_order.signed');
    for (const p of ['gm', 'accountant', 'owner', 'legacyPm'] as const) {
      expect(byMember(rows, p)[0].title, p).toContain('(+$1,000.00)');
      expect(byMember(rows, p)[0].money_masked, p).toBe(false);
    }
    const sup = byMember(rows, 'supervisor')[0];
    expect(sup.title).toBe('CO-101 signed on J1');
    expect(sup.money_masked).toBe(true);
  });

  it('approval.requested: text and amount come from the approval request; eligible approvers only; money per recipient', async () => {
    const req = await approvalRequest({ job: J1, title: 'PO 1007 Lumber', amount: 1250000, by: 'supervisor' });
    f.ids.req1 = req;
    // the submitter raises it; the caller's own title / money text is ignored; recipients narrow to eligible approvers
    const n = await as(f, 'supervisor', async () => (await q<{ n: number }>(f.db,
      `select pm.notify_emit('approval.requested', $1, null, 'approval_request', $2, $3::uuid[], 'URGENT: wire money', 'Reply to evil@example.test',
                             'URGENT ($1)', null, '//evil.test', 'x', null) n`,
      [J1, req, [f.membership.owner, f.membership.pm, f.membership.labor, f.membership.dispatcher]]))[0].n);
    expect(n).toBe(2); // owner + PM approve commitments on J1; labor / dispatcher cannot
    const rows = await notes('approval.requested');
    expect(byMember(rows, 'owner')[0]?.title).toBe('PO 1007 Lumber needs your approval ($12,500.00)');
    expect(byMember(rows, 'pm')[0]?.title).toBe('PO 1007 Lumber needs your approval ($12,500.00)');
    expect(byMember(rows, 'labor')).toEqual([]);
    expect(rows.every((r) => !/URGENT|evil/.test(`${r.title} ${r.body}`))).toBe(true);
    const link = await q<{ deep_link: string }>(f.db, `select deep_link from core.notifications where event_type = 'approval.requested'`);
    expect(new Set(link.map((l) => l.deep_link))).toEqual(new Set(['/approvals?tab=mine']));
    // empty recipients = every eligible approver; nobody twice (dedupe on request / round / step)
    await as(f, 'supervisor', async () => f.db.query(`select pm.notify_emit('approval.requested', null, null, 'approval_request', $1, '{}'::uuid[], 'x')`, [req]));
    expect(byMember(await notes('approval.requested'), 'owner')).toHaveLength(1);
    expect(byMember(await notes('approval.requested'), 'gm')).toHaveLength(1);
    const meta = await q<{ meta: Record<string, unknown> }>(f.db, `select meta from core.notifications where event_type = 'approval.requested'`);
    for (const m of meta) expect(Object.keys(m.meta).some((k) => /cents|amount/.test(k))).toBe(false);
  });

  it('security review L: nobody outside the approval can raise it, and there is no free-text approval path', async () => {
    // the probe: labor sends a "mandatory" approval with arbitrary text — refused
    expect(await as(f, 'labor', async () => errorOf(f.db,
      `select pm.notify_emit('approval.requested', $1, null, null, null, $2::uuid[], 'URGENT: wire $48,000 to new vendor acct today', 'Reply to accounting@evil.example', null, null, '/approvals', 'x1')`,
      [J2, [f.membership.owner, f.membership.gm, f.membership.accountant]]))).toMatch(/name the approval request/);
    // a real request, but the caller is not on it
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.notify_emit('approval.requested', null, null, 'approval_request', $1, '{}'::uuid[], 'x')`, [f.ids.req1])))
      .toMatch(forbidden);
    // decided: only once decided; goes to the submitter, with the server's wording
    expect(await as(f, 'supervisor', async () => errorOf(f.db, `select pm.notify_emit('approval.decided', null, null, 'approval_request', $1, '{}'::uuid[], 'x')`, [f.ids.req1])))
      .toMatch(/not decided yet/);
    await f.db.query(`update pm.approval_requests set status = 'REJECTED', decided_by = $2, decided_at = now(), reject_reason = 'Use the other supplier' where id = $1`, [f.ids.req1, f.clerk.pm]);
    const n = await as(f, 'pm', async () => (await q<{ n: number }>(f.db, `select pm.notify_emit('approval.decided', null, null, 'approval_request', $1, $2::uuid[], 'ignored') n`,
      [f.ids.req1, [f.membership.owner]]))[0].n);
    expect(n).toBe(1);
    const d = byMember(await notes('approval.decided'), 'supervisor')[0];
    expect(d?.title).toBe('PO 1007 Lumber was sent back'); // supervisor has no financials: plain variant (1113's wording)
    expect(d?.body).toMatch(/sent it back: Use the other supplier$/);
    expect(d?.money_masked).toBe(true);
    expect(byMember(await notes('approval.decided'), 'owner')).toEqual([]);
  });

  it('mentions are templated, never mandatory, at most 20 people, rate-limited per member', async () => {
    await as(f, 'owner', async () => f.db.query(`select pm.notify_configure($1, '{"mandatory_events":["comment.mention"]}'::jsonb)`, [L1]));
    await as(f, 'pm', async () => f.db.query(`select pm.notify_save_prefs($1::jsonb, null, null, null, null, null)`,
      [JSON.stringify([{ event_type: 'comment.mention', channel: 'in_app', mode: 'off' }, { event_type: 'comment.mention', channel: 'push', mode: 'off' }])]));
    await as(f, 'owner', async () => f.db.query(`select pm.notify_emit('comment.mention', $1, null, 'comment', null, $2::uuid[], 'ignored title', 'Can you check   the
 header?', 'money $9', null, '/jobs', 'c1')`,
      [J1, [f.membership.pm, f.membership.supervisor]]));
    const rows = await notes('comment.mention');
    expect(byMember(rows, 'pm')).toEqual([]); // the PM turned mentions off; a member-raised event is never mandatory
    expect(byMember(rows, 'supervisor').map((r) => [r.title, r.body])).toEqual([['T owner mentioned you on J1', '“Can you check the header?”']]);
    await as(f, 'owner', async () => f.db.query(`select pm.notify_configure($1, '{"mandatory_events":[]}'::jsonb)`, [L1]));
    const many = Array.from({ length: 21 }, () => f.membership.supervisor);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_emit('comment.mention', $1, null, null, null, $2::uuid[], 'x')`, [J1, many]))).toBeNull(); // duplicates collapse to 1
    const distinct21 = [f.membership.supervisor, f.membership.pm, f.membership.gm, f.membership.accountant, f.membership.dispatcher, f.membership.labor,
      f.membership.legacyOwner, f.membership.legacyStaff, f.membership.legacyPm, ...Array.from({ length: 12 }, () => crypto.randomUUID())];
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_emit('comment.mention', $1, null, null, null, $2::uuid[], 'x')`, [J1, distinct21]))).toMatch(/between 1 and 20/);
    await f.db.query(`insert into core.notifications (org_id, membership_id, kind, title, event_type, actor_membership_id, source_app)
                      select $1, $2, 'comment.mention', 'x', 'comment.mention', $3, 'projects' from generate_series(1, 100)`, [ORG_A, f.membership.gm, f.membership.owner]);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_emit('comment.mention', $1, null, null, null, $2::uuid[], 'x')`, [J1, [f.membership.supervisor]])))
      .toMatch(/too many notifications/);
    await f.db.query(`delete from core.notifications where membership_id = $1 and title = 'x' and event_type = 'comment.mention'`, [f.membership.gm]);
  });

  it('pm.notify_emit never reaches someone who cannot reach the job, and refuses other jobs / trigger-only events', async () => {
    const before = byMember(await notes('comment.mention'), 'pm').length;
    await as(f, 'owner', async () => f.db.query(`select pm.notify_emit('comment.mention', $1, null, null, null, $2::uuid[], 'Owner mentioned you')`, [J2, [f.membership.pm]]));
    expect(byMember(await notes('comment.mention'), 'pm').length).toBe(before); // J2 is not the PM's job
    expect(await as(f, 'labor', async () => errorOf(f.db, `select pm.notify_emit('comment.mention', $1, null, null, null, $2::uuid[], 'x')`, [J3, [f.membership.owner]])))
      .toMatch(forbidden); // J3 is not one of labor's jobs
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_emit('change_order.signed', $1, null, null, null, $2::uuid[], 'fake')`, [J1, [f.membership.pm]])))
      .toMatch(/cannot be sent from the app/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('preferences: person matrix, Books muted kinds, mandatory events', () => {
  it('a person turns push off for an event: the inbox copy stays, no push is queued', async () => {
    await as(f, 'labor', async () => {
      await f.db.query(`select pm.notify_save_prefs($1::jsonb, null, null, null, null, null)`,
        [JSON.stringify([{ event_type: 'task.assigned', channel: 'push', mode: 'off' }])]);
    });
    const before = (await pushes('labor')).filter((p) => p.event_type === 'task.assigned').length;
    await f.db.query(`insert into pm.tasks (org_id, job_id, title, assignee_employee_id) values ($1, $2, 'Set cabinets', $3)`, [ORG_A, J2, f.employee.labor]);
    expect(byMember(await notes('task.assigned'), 'labor').map((r) => r.title)).toContain('New task: Set cabinets');
    expect((await pushes('labor')).filter((p) => p.event_type === 'task.assigned').length).toBe(before);
  });

  it('in-app off + Books muted kind silence an event entirely', async () => {
    await f.db.query(`update core.notification_prefs set muted_kinds = array['punch.assigned'] where membership_id = $1`, [f.membership.labor]);
    await f.db.query(`insert into pm.punch_items (org_id, job_id, title, assignee_user_id) values ($1, $2, 'Muted punch', $3)`, [ORG_A, J2, f.clerk.labor]);
    expect(byMember(await notes('punch.assigned'), 'labor')).toEqual([]);
  });

  it('mandatory: platform-mandatory approvals ignore the person; an org-mandatory event beats a mute', async () => {
    await as(f, 'labor', async () => {
      await f.db.query(`select pm.notify_save_prefs($1::jsonb, null, null, null, null, null)`,
        [JSON.stringify([{ event_type: 'approval.requested', channel: 'in_app', mode: 'off' }])]);
    });
    const req = await approvalRequest({ job: J2, title: 'Crew sheet', amount: 0, by: 'owner', cap: 'projects.time:create' });
    await as(f, 'owner', async () => f.db.query(`select pm.notify_emit('approval.requested', null, null, 'approval_request', $1, $2::uuid[], 'x')`, [req, [f.membership.labor]]));
    expect(byMember(await notes('approval.requested'), 'labor').map((r) => r.title)).toContain('Crew sheet needs your approval');

    await as(f, 'owner', async () => f.db.query(`select pm.notify_configure($1, '{"mandatory_events":["punch.assigned"]}'::jsonb)`, [L1]));
    await f.db.query(`insert into pm.punch_items (org_id, job_id, title, assignee_user_id) values ($1, $2, 'Safety rail', $3)`, [ORG_A, J2, f.clerk.labor]);
    expect(byMember(await notes('punch.assigned'), 'labor').map((r) => r.title)).toEqual(['Punch item: Safety rail']);
    await as(f, 'owner', async () => f.db.query(`select pm.notify_configure($1, '{"mandatory_events":[]}'::jsonb)`, [L1]));
  });

  it('only the owner of the prefs writes them; settings need projects.settings:configure', async () => {
    const rules = await as(f, 'gm', async () => q(f.db, `select * from core.notification_pref_rules`));
    expect(rules).toEqual([]); // labor's rules are not the GM's to read
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.notify_configure($1, '{"customer_messages_live":true}'::jsonb)`, [L1]))).toMatch(forbidden);
    expect(await as(f, 'gm', async () => errorOf(f.db, `select pm.notify_set_recipe('projects_labor', 'task.assigned', 'instant', 'off', 'off', 'off')`))).toMatch(forbidden);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_set_recipe('projects_labor', 'job.assigned', 'instant', 'off', 'off', 'off')`))).toBeNull();
    const m = await q<{ push: string }>(f.db, `select push from core.notify_modes($1, 'job.assigned', $2)`, [f.membership.labor, L1]);
    expect(m[0].push).toBe('off'); // the org override wins over the platform default
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('quiet hours and frequency caps', () => {
  it('core.notify_quiet_end: same-day and overnight windows', async () => {
    const r = await q<{ a: string; b: string; c: string; d: string }>(f.db, `select
      core.notify_quiet_end('2026-10-24 23:30+00', '22:00', '07:00', 'UTC')::text a,
      core.notify_quiet_end('2026-10-25 03:00+00', '22:00', '07:00', 'UTC')::text b,
      core.notify_quiet_end('2026-10-24 12:00+00', '22:00', '07:00', 'UTC')::text c,
      core.notify_quiet_end('2026-10-24 13:00+00', '12:00', '14:00', 'UTC')::text d`);
    expect(r[0]).toEqual({ a: '2026-10-25 07:00:00+00', b: '2026-10-25 07:00:00+00', c: '2026-10-24 12:00:00+00', d: '2026-10-24 14:00:00+00' });
  });

  it('a push during the member\'s quiet hours waits until they end; the inbox row is immediate', async () => {
    await as(f, 'supervisor', async () => {
      await f.db.query(`select pm.notify_save_prefs('[]'::jsonb, null,
                          ((now() at time zone 'UTC') - interval '1 hour')::time, ((now() at time zone 'UTC') + interval '2 hours')::time, 'UTC', null)`);
    });
    await f.db.query(`insert into pm.tasks (org_id, job_id, title, assignee_user_id) values ($1, $2, 'Night task', $3)`, [ORG_A, J1, f.clerk.supervisor]);
    expect(byMember(await notes('task.assigned'), 'supervisor').map((r) => r.title)).toContain('New task: Night task');
    const p = (await pushes('supervisor')).filter((x) => x.event_type === 'task.assigned');
    expect(p).toHaveLength(1);
    const wait = await q<{ mins: number }>(f.db, `select extract(epoch from ($1::timestamptz - now())) / 60 as mins`, [p[0].not_before]);
    expect(Number(wait[0].mins)).toBeGreaterThan(100);
  });

  it('over the company push cap the push is skipped (recorded), the inbox row still lands', async () => {
    await as(f, 'owner', async () => f.db.query(`select pm.notify_configure($1, '{"push_per_hour":1}'::jsonb)`, [L1]));
    try {
      await f.db.query(`insert into pm.tasks (org_id, job_id, title, assignee_user_id) values ($1, $2, 'Capped task', $3)`, [ORG_A, J1, f.clerk.supervisor]);
      const p = (await pushes('supervisor')).filter((x) => x.event_type === 'task.assigned');
      expect(p.map((x) => [x.status, x.status_reason])).toEqual([['queued', null], ['skipped', 'frequency cap']]);
      expect(byMember(await notes('task.assigned'), 'supervisor').map((r) => r.title)).toContain('New task: Capped task');
    } finally {
      await as(f, 'owner', async () => f.db.query(`select pm.notify_configure($1, '{"push_per_hour":6}'::jsonb)`, [L1]));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the inbox under RLS (bell API reads)', () => {
  it('a Projects-only Labor seat reads its own inbox, nobody else\'s, and marks it read', async () => {
    const mine = await as(f, 'labor', async () => q<{ membership_id: string }>(f.db, `select membership_id from core.notifications`));
    expect(mine.length).toBeGreaterThan(2);
    expect(new Set(mine.map((r) => r.membership_id))).toEqual(new Set([f.membership.labor]));
    const unread = async () => as(f, 'labor', async () => (await q<{ n: number }>(f.db, `select count(*)::int n from core.notifications where read_at is null`))[0].n);
    expect(await unread()).toBeGreaterThan(0);
    const one = await as(f, 'labor', async () => q<{ id: string }>(f.db, `select id from core.notifications order by created_at limit 1`));
    expect(await as(f, 'labor', async () => (await q<{ n: number }>(f.db, `select pm.notify_mark($1::uuid[], 'done') n`, [[one[0].id]]))[0].n)).toBe(1);
    await as(f, 'labor', async () => f.db.query(`select pm.notify_mark(null, 'read_all')`));
    expect(await unread()).toBe(0);
    // marking someone else's row does nothing
    const gmRow = (await q<{ id: string }>(f.db, `select id from core.notifications where membership_id = $1 limit 1`, [f.membership.gm]))[0].id;
    expect(await as(f, 'labor', async () => (await q<{ n: number }>(f.db, `select pm.notify_mark($1::uuid[], 'read') n`, [[gmRow]]))[0].n)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('digests', () => {
  it('collects per member at 08:00 local (owner weekly on Monday), groups items, claims once, stamps on send', async () => {
    const at = (await q<{ t: string }>(f.db,
      `select ((date_trunc('week', now() at time zone 'America/Chicago') + interval '7 days 8 hours 30 minutes') at time zone 'America/Chicago')::text t`))[0].t;
    const rows = await q<{ digest_id: string; membership_id: string; cadence: string; items: Array<{ eventType: string; jobLabel: string | null; id: string }> }>(f.db,
      `select digest_id, membership_id, cadence, items from core.notify_digest_collect($1::timestamptz)`, [at]);
    const owner = rows.find((r) => r.membership_id === f.membership.owner);
    expect(owner?.cadence).toBe('weekly');
    const kinds = new Set(owner?.items.map((i) => i.eventType));
    expect(kinds.has('change_order.signed')).toBe(true);
    expect(kinds.has('time.submitted')).toBe(true);
    expect(owner?.items.find((i) => i.eventType === 'change_order.signed')?.jobLabel).toBe('J1');
    // instant-only members (no digest items) get none; a rerun claims nothing new
    expect(rows.find((r) => r.membership_id === f.membership.labor)).toBeUndefined();
    const again = await q(f.db, `select * from core.notify_digest_collect($1::timestamptz)`, [at]);
    expect(again.find((r) => (r as { membership_id: string }).membership_id === f.membership.owner)).toBeUndefined();
    await f.db.query(`select core.notify_digest_done($1, true, 'msg_1', null)`, [owner?.digest_id]);
    const stamped = await q<{ n: number }>(f.db, `select count(*)::int n from core.notifications where id = any($1::uuid[]) and emailed_at is not null`,
      [owner?.items.map((i) => i.id)]);
    expect(stamped[0].n).toBe(owner?.items.length);
  });
  it('not the digest hour → nothing', async () => {
    const rows = await q(f.db, `select * from core.notify_digest_collect(now(), 25)`);
    expect(rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('customer-facing messages: held until go-live, consent, STOP', () => {
  beforeAll(async () => {
    const c = await q<{ id: string }>(f.db, `insert into core.customers (org_id, name, location_id) values ($1, 'Smith Home', $2) returning id`, [ORG_A, L1]);
    const ct = await q<{ id: string }>(f.db,
      `insert into core.contacts (org_id, customer_id, first_name, email, phone) values ($1, $2, 'Pat', 'pat@example.test', '(515) 555-0142') returning id`, [ORG_A, c[0].id]);
    f.ids.contact = ct[0].id;
  });
  const send = (p: Persona, channel: string, dedupe: string) => as(f, p, async () => (await q<{ r: { id: string; status: string; reason: string | null } }>(f.db,
    `select pm.notify_customer_message('customer.on_my_way', $1, null, $2, $3, 'On the way', 'Pat, your installer is 20 minutes out.', null, $4) r`,
    [channel, L1, f.ids.contact, dedupe]))[0].r);

  it('before go-live every customer email is HELD; nothing is queued for a customer', async () => {
    const r = await send('dispatcher', 'email', 'e1');
    expect(r.status).toBe('held');
    expect(r.reason).toMatch(/held until this company goes live/);
    expect(await as(f, 'pm', async () => errorOf(f.db, `select pm.notify_customer_message('customer.on_my_way', 'email', null, $1, $2, 's', 'b')`, [L1, f.ids.contact])))
      .toMatch(forbidden); // PM has customers:view only
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select pm.notify_customer_message('approval.requested', 'email', null, $1, $2, 's', 'b')`, [L1, f.ids.contact])))
      .toMatch(/not a customer message/);
  });

  it('held messages are visible to settings holders only; release needs go-live', async () => {
    expect(await as(f, 'dispatcher', async () => q(f.db, `select id from core.outbound_messages where status = 'held'`))).toEqual([]);
    const held = await as(f, 'owner', async () => q<{ id: string }>(f.db, `select id from core.outbound_messages where status = 'held'`));
    expect(held).toHaveLength(1);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_held_action($1::uuid[], 'release')`, [[held[0].id]]))).toMatch(/not live/);
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select pm.notify_held_action($1::uuid[], 'release')`, [[held[0].id]]))).toMatch(forbidden);
    const live = await as(f, 'owner', async () => (await q<{ s: { customer_messages_live: boolean; live_at: string | null } }>(f.db,
      `select pm.notify_configure($1, '{"customer_messages_live":true}'::jsonb) s`, [L1]))[0].s);
    expect(live.customer_messages_live).toBe(true);
    expect(live.live_at).not.toBeNull();
    expect(await as(f, 'owner', async () => (await q<{ n: number }>(f.db, `select pm.notify_held_action($1::uuid[], 'release') n`, [[held[0].id]]))[0].n)).toBe(1);
    expect((await send('dispatcher', 'email', 'e2')).status).toBe('queued');
    expect((await send('dispatcher', 'email', 'e2')).status).toBe('queued'); // same dedupe → same row
    expect((await q<{ n: number }>(f.db, `select count(*)::int n from core.outbound_messages where dispatch_key like 'customer:customer.on_my_way:e2'`))[0].n).toBe(1);
  });

  it('texts need consent and texting set up; STOP opts out everywhere (incl. the Books suppression list)', async () => {
    expect((await send('dispatcher', 'sms', 's1')).status).toBe('suppressed');
    await as(f, 'dispatcher', async () => f.db.query(`select pm.notify_record_sms_consent($1, '515-555-0142', $2, 'opted_in', 'web_form', 'Yes, text me about my appointment and job updates.')`, [L1, f.ids.contact]));
    expect((await send('dispatcher', 'sms', 's2')).reason).toMatch(/Texting is not set up/);
    // security review M: the number is asked for, verified by the service role, and only then usable
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_configure($1, '{"sms_from_number":"+15155550100"}'::jsonb)`, [L1]))).toMatch(/verifying it/);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_configure($1, '{"sms_enabled":true}'::jsonb)`, [L1]))).toMatch(/verify a texting number/);
    const ask = await as(f, 'owner', async () => (await q<{ r: { id: string; status: string } }>(f.db, `select pm.notify_request_sender($1, '(515) 555-0100') r`, [L1]))[0].r);
    expect(ask.status).toBe('pending');
    expect(await errorOf(f.db, `update core.notification_settings set sms_from_number = '+15155550100' where org_id = $1`, [ORG_A])).toMatch(/not verified/);
    expect(await as(f, 'gm', async () => errorOf(f.db, `select core.notify_verify_sender($1, true, 'PN1', null)`, [ask.id]))).toMatch(/permission denied/);
    await f.db.query(`select core.notify_verify_sender($1, true, 'PN123', 'twilio confirmed')`, [ask.id]);
    await as(f, 'owner', async () => f.db.query(`select pm.notify_configure($1, '{"sms_enabled":true}'::jsonb)`, [L1]));
    const ok = await send('dispatcher', 'sms', 's3');
    expect(ok.status).toBe('queued');
    const r = (await q<{ r: { action: string; reply: string } }>(f.db, `select core.notify_inbound_sms('+15155550142', '+15155550100', ' stop ') r`))[0].r;
    expect(r.action).toBe('opt_out');
    expect(r.reply).toMatch(/Reply START/);
    const c = await q<{ status: string }>(f.db, `select status from core.sms_consents where phone = '+15155550142'`);
    expect(c[0].status).toBe('opted_out');
    expect((await q(f.db, `select 1 from core.request_suppressions where channel = 'sms' and address = '+15155550142' and reason = 'stop'`))).toHaveLength(1);
    const after = await q<{ status: string }>(f.db, `select status from core.outbound_messages where id = $1`, [ok.id]);
    expect(after[0].status).toBe('suppressed');
    expect((await send('dispatcher', 'sms', 's4')).status).toBe('suppressed');
    // START resubscribes
    expect((await q<{ r: { action: string } }>(f.db, `select core.notify_inbound_sms('+15155550142', '+15155550100', 'START') r`))[0].r.action).toBe('opt_in');
    expect((await q<{ status: string }>(f.db, `select status from core.sms_consents where phone = '+15155550142'`))[0].status).toBe('opted_in');
  });

  it('security review M: another tenant cannot claim, verify or receive STOPs for a verified number', async () => {
    expect(await as(f, 'bOwner', async () => errorOf(f.db, `select pm.notify_request_sender($1, '+15155550100')`, [LB]))).toMatch(/another workspace/);
    expect(await as(f, 'bOwner', async () => errorOf(f.db, `select pm.notify_configure($1, '{"sms_from_number":"+15155550100","sms_enabled":true}'::jsonb)`, [LB]))).toMatch(/verifying it/);
    // even a stray pending row for B can never be verified while A holds the number
    const stray = await q<{ id: string }>(f.db, `insert into core.sms_sender_numbers (org_id, location_id, phone) values ($1, $2, '+15155550100') returning id`, [ORG_B, LB]);
    expect(await errorOf(f.db, `select core.notify_verify_sender($1, true, 'PN999', null)`, [stray[0]!.id])).toMatch(/another workspace/);
    expect(await errorOf(f.db, `update core.notification_settings set sms_from_number = '+15155550100' where org_id = $1`, [ORG_B])).toBeNull(); // no B row yet: nothing to update
    expect(await errorOf(f.db, `insert into core.notification_settings (org_id, location_id, sms_from_number) values ($1, $2, '+15155550100')`, [ORG_B, LB])).toMatch(/not verified/);
    // inbound resolves exactly one tenant (A); an unknown number changes nothing
    await f.db.query(`insert into core.sms_consents (org_id, phone, status, source, consented_at) values ($1, '+15155550199', 'opted_in', 'web_form', now())`, [ORG_B]);
    const r = (await q<{ r: { action: string; orgs: number } }>(f.db, `select core.notify_inbound_sms('+15155550199', '+15155550100', 'STOP') r`))[0].r;
    expect(r.orgs).toBe(1);
    expect((await q<{ status: string }>(f.db, `select status from core.sms_consents where org_id = $1 and phone = '+15155550199'`, [ORG_B]))[0]?.status).toBe('opted_in');
    expect((await q<{ r: { action: string } }>(f.db, `select core.notify_inbound_sms('+15155550199', '+15155550111', 'STOP') r`))[0].r.action).toBe('ignored');
    // members of B see none of A's numbers
    expect(await as(f, 'bOwner', async () => q(f.db, `select phone from core.sms_sender_numbers where status = 'verified'`))).toEqual([]);
  });

  it('security review note: outbound text is masked per reader (customer text needs contract_value; internal text never)', async () => {
    expect(await as(f, 'owner', async () => errorOf(f.db, `select body from core.outbound_messages limit 1`))).toMatch(/permission denied/);
    const own = await as(f, 'owner', async () => q<{ audience: string; body: string | null; body_masked: boolean; to_address: string | null }>(f.db,
      `select audience, body, body_masked, to_address from pm.notify_outbound_messages(null, 500)`));
    expect(own.some((r) => r.audience === 'customer' && r.body !== null && !r.body_masked)).toBe(true);
    expect(own.filter((r) => r.audience === 'internal').every((r) => r.body === null && r.body_masked && r.to_address === null)).toBe(true);
    // the same holder without contract_value at the company: customer text masked too
    const asg = await q<{ id: string }>(f.db, `select a.id from core.access_assignments a join core.role_definitions rd on rd.id = a.role_id
                                                where a.membership_id = $1 and rd.key = 'projects_owner'`, [f.membership.owner]);
    await f.db.query(`update core.access_assignments set muted = '{"projects.contract_value":["view"]}'::jsonb where id = any($1::uuid[])`, [asg.map((a) => a.id)]);
    try {
      const masked = await as(f, 'owner', async () => q<{ body: string | null; body_masked: boolean }>(f.db, `select body, body_masked from pm.notify_outbound_messages(null, 500) where audience = 'customer'`));
      expect(masked.length).toBeGreaterThan(0);
      expect(masked.every((r) => r.body === null && r.body_masked)).toBe(true);
    } finally {
      await f.db.query(`update core.access_assignments set muted = '{}'::jsonb where id = any($1::uuid[])`, [asg.map((a) => a.id)]);
    }
    expect(await as(f, 'dispatcher', async () => errorOf(f.db, `select * from pm.notify_outbound_messages()`))).toMatch(forbidden);
  });

  it('a contact flagged sms_consent (1111 / 1117 flag) counts as consent until a STOP', async () => {
    const ct = await q<{ id: string }>(f.db,
      `insert into core.contacts (org_id, customer_id, first_name, phone, sms_consent, consent_at)
       select $1, customer_id, 'Sam', '515-555-0177', true, now() from core.contacts where id = $2 returning id`, [ORG_A, f.ids.contact]);
    const r = await as(f, 'dispatcher', async () => (await q<{ r: { status: string } }>(f.db,
      `select pm.notify_customer_message('customer.message', 'sms', null, $1, $2, null, 'Sam, we are 10 minutes out.', null, 'flag-1') r`, [L1, ct[0].id]))[0].r);
    expect(r.status).toBe('queued');
    await f.db.query(`select core.notify_inbound_sms('+15155550177', '+15155550100', 'STOP')`);
    const r2 = await as(f, 'dispatcher', async () => (await q<{ r: { status: string } }>(f.db,
      `select pm.notify_customer_message('customer.message', 'sms', null, $1, $2, null, 'Again', null, 'flag-2') r`, [L1, ct[0].id]))[0].r);
    expect(r2.status).toBe('suppressed');
    expect((await q<{ sms_consent: boolean }>(f.db, `select sms_consent from core.contacts where id = $1`, [ct[0].id]))[0].sms_consent).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('worker surface', () => {
  it('claims due queued rows with live push tokens, records results, retries with backoff', async () => {
    const rows = await q<{ id: string; channel: string; membership_id: string; push_tokens: string[] | null; attempts: number }>(f.db,
      `select id, channel, membership_id, push_tokens, attempts from core.notify_outbound_claim(500)`);
    const pushRow = rows.find((r) => r.channel === 'push' && r.membership_id === f.membership.gm);
    expect(pushRow?.push_tokens).toEqual([TOKEN('gm')]);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    // the supervisor's quiet-hours push is not due yet: still queued, not claimed
    const night = await q<{ status: string }>(f.db, `select o.status from core.outbound_messages o join core.notifications n on n.id = o.notification_id
                                                       where o.channel = 'push' and n.title = 'New task: Night task'`);
    expect(night).toEqual([{ status: 'queued' }]);
    await f.db.query(`select core.notify_outbound_result($1, 'sent', 'expo', 'ticket-1', null)`, [pushRow?.id]);
    const other = rows.find((r) => r.id !== pushRow?.id);
    await f.db.query(`select core.notify_outbound_result($1, 'failed', 'expo', null, 'timeout', true)`, [other?.id]);
    const st = await q<{ id: string; status: string; later: boolean }>(f.db,
      `select id, status, not_before > now() later from core.outbound_messages where id = any($1::uuid[])`, [[pushRow?.id, other?.id]]);
    expect(st.find((x) => x.id === pushRow?.id)?.status).toBe('sent');
    expect(st.find((x) => x.id === other?.id)).toMatchObject({ status: 'queued', later: true });
    await f.db.query(`select core.notify_revoke_push_token($1, 'DeviceNotRegistered')`, [TOKEN('gm')]);
    expect((await q(f.db, `select 1 from core.push_devices where token = $1 and revoked_at is not null`, [TOKEN('gm')]))).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('secret-bearing customer messages (runs after the worker test: it claims the queue)', () => {
  it('portals review CRITICAL: one-time codes never land in outbound_messages; admins never read them; deleted after send', async () => {
    const mk = async (loc: string, code: string, dedupe: string) => (await q<{ r: { outbound_id: string; status: string } }>(f.db,
      `select core.notify_customer_secret($1, $2, null, 'customer.portal_access', 'email', $3, 'Your sign-in code',
              'Portal sign-in code (sent directly; the code is never stored).', $4, $5, 'portal') r`,
      [ORG_A, loc, f.ids.contact, `Your code is ${code}. It expires in 20 minutes.`, dedupe]))[0].r;
    const a = await mk(L1, '481516', 'sec-1');
    expect(a.status).toBe('queued');
    const row = await q<{ body: string; data: { secret?: boolean } }>(f.db, `select body, data from core.outbound_messages where id = $1`, [a.outbound_id]);
    expect(row[0]?.body).not.toContain('481516');
    expect(row[0]?.data.secret).toBe(true);
    // members / admins: no table access to secrets; the admin log masks the text
    expect(await as(f, 'owner', async () => errorOf(f.db, `select body from core.outbound_secrets`))).toMatch(/permission denied/);
    expect(await as(f, 'owner', async () => errorOf(f.db, `select core.notify_secret_take($1)`, [a.outbound_id]))).toMatch(/permission denied/);
    const log = await as(f, 'owner', async () => q<{ body: string | null; subject: string | null; body_masked: boolean }>(f.db,
      `select body, subject, body_masked from pm.notify_outbound_messages(null, 500) where id = $1`, [a.outbound_id]));
    expect(log).toEqual([{ body: null, subject: null, body_masked: true }]);
    // the worker gets the real text at claim time; once sent the secret is gone
    const claimed = await q<{ id: string; body: string }>(f.db, `select id, body from core.notify_outbound_claim(500) where id = $1`, [a.outbound_id]);
    expect(claimed[0]?.body).toBe('Your code is 481516. It expires in 20 minutes.');
    await f.db.query(`select core.notify_outbound_result($1, 'sent', 'resend', 'em_9', null)`, [a.outbound_id]);
    expect(await q(f.db, `select 1 from core.outbound_secrets where outbound_id = $1`, [a.outbound_id])).toEqual([]);
    // direct send: taken once, then nothing
    const b = await mk(L1, '271828', 'sec-2');
    const take = (await q<{ t: { body: string; to: string } | null }>(f.db, `select core.notify_secret_take($1) t`, [b.outbound_id]))[0]?.t;
    expect(take?.body).toContain('271828');
    expect(take?.to).toBe('pat@example.test');
    expect((await q<{ t: unknown }>(f.db, `select core.notify_secret_take($1) t`, [b.outbound_id]))[0]?.t).toBeNull();
    expect(await q(f.db, `select 1 from core.outbound_secrets where outbound_id = $1`, [b.outbound_id])).toEqual([]);
    // expired before sending → cancelled, the placeholder is never sent
    const c = await mk(L1, '314159', 'sec-3');
    await f.db.query(`update core.outbound_secrets set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where outbound_id = $1`, [c.outbound_id]);
    expect(await q(f.db, `select id from core.notify_outbound_claim(500) where id = $1`, [c.outbound_id])).toEqual([]);
    expect((await q<{ status: string }>(f.db, `select status from core.outbound_messages where id = $1`, [c.outbound_id]))[0]?.status).toBe('cancelled');
    // a held company (L2 not live) never stores the secret, and the message cannot be released later
    const h = await mk(L2, '161803', 'sec-4');
    expect(h.status).toBe('held');
    expect(await q(f.db, `select 1 from core.outbound_secrets where outbound_id = $1`, [h.outbound_id])).toEqual([]);
    await as(f, 'owner', async () => f.db.query(`select pm.notify_configure($1, '{"customer_messages_live":true}'::jsonb)`, [L2]));
    expect(await as(f, 'owner', async () => errorOf(f.db, `select pm.notify_held_action($1::uuid[], 'release')`, [[h.outbound_id]]))).toMatch(/not released later/);
    // a public text that leaks the secret is refused
    expect(await errorOf(f.db, `select core.notify_customer_secret($1, $2, null, 'customer.portal_access', 'email', $3, 's', 'code 999', '999', null, 'portal')`,
      [ORG_A, L1, f.ids.contact])).toMatch(/must not contain the secret/);
  });
});
