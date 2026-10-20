# MeritBooks Scheduler (INT-01 / IA M-12)

The scheduler runs MeritBooks' background work on a timetable: nightly control checks, scheduled
report packs, the rev-rec run on the 1st, vendor-compliance chases, and similar jobs. It is the
prerequisite named in `docs/ia/07-INTEGRATIONS-PLAN.md` §1.6 (INT-01) and `docs/ia/IA-SPEC.md`
§1.6 M-12 / §6.

## How it works (one paragraph)

Vercel Cron calls **one** endpoint, `GET /api/cron/tick`, every 5 minutes (`apps/web/vercel.json`).
Each call ("tick") checks the job list in `apps/web/src/lib/scheduler/registry.ts`, works out
which jobs are due for which tenants, and runs them. Before running a job for a tenant it takes a
lock in the database, so two ticks can never run the same job for the same tenant at once. Every
attempt is written to `core.job_runs`, the run log that a future "Automation health" widget reads
through `GET /api/scheduler/runs`.

## Setting it up (plain-English steps for Mike)

You need to do this once. Until it's done, the tick endpoint refuses every call (that's the safe
default) and no scheduled job runs.

1. **Make a secret.** In Terminal run `openssl rand -hex 32` and copy the long string it prints.
   (Any random string of at least 16 characters works. Don't reuse a password.)
2. **Add it to Vercel.** Open vercel.com → the **MeritEnterprise** team → project
   **meritbooks-web** → **Settings** → **Environment Variables** → **Add New**.
   - Key: `CRON_SECRET`
   - Value: the string from step 1
   - Environments: tick **Production** (Preview and Development aren't needed: Vercel only runs crons
     on production).
   - Save.
3. **Check the other variable the jobs need.** On the same page confirm `SUPABASE_JWT_SECRET` exists
   for Production. That's the Supabase "JWT Secret" (Supabase dashboard → Project Settings → API →
   JWT Settings). The tenant jobs use it to read each company's books **through the database's
   tenant walls**. Without it, those jobs record a "failed" run instead of falling back to unsafe
   access. Report packs already need this today.
4. **Redeploy.** Vercel only picks up new environment variables on the next deploy. Either push any
   commit or, in Vercel, open **Deployments** → the latest production deployment → **⋯** →
   **Redeploy**.
5. **Confirm it's running.** In Vercel go to project → **Settings** → **Cron Jobs**. You should see
   `/api/cron/tick` every 5 minutes. Use **Run** to trigger it once by hand. The **Logs** tab shows
   lines starting with `{"evt":"scheduler.tick"`.

Order of operations for the lead: apply migration `162_scheduler.sql` to Supabase **before** the
code that uses it is deployed. If the tables are missing, the tick returns 500 and runs nothing.

### Turning things off (kill switches)

| Want to… | Do this |
|---|---|
| Stop **everything** right now | Vercel env var `SCHEDULER_PAUSED=1`, then redeploy. Or delete `CRON_SECRET`: the tick then returns 401 to Vercel and runs nothing. |
| Stop **one job** everywhere | Vercel env var `SCHEDULER_DISABLED_JOBS=controls.nightly,events.drain` (comma list), then redeploy. Without a deploy: SQL `insert into core.scheduled_jobs (job_key, org_id, enabled) values ('controls.nightly', null, false) on conflict (job_key, org_id, location_id) do update set enabled = false;` |
| Stop one job for **one tenant** | the same SQL, with that tenant's `org_id` instead of `null` |
| Change a job's time | `update core.scheduled_jobs set cron = '30 9 * * *' where job_key = '…' and org_id is null;` (applies to all tenants; a tenant row overrides it for one tenant) |

Overrides resolve **tenant row → platform row (`org_id` null) → code default**. A `null`
`enabled`/`cron` means "inherit". A stub job (not built yet) never runs, whatever the table says.

Only the service role can write these tables. Tenant members can read their own tenant's run log
and nothing else (migration 162).

## Jobs

All times are UTC. Merit's companies are on US Central, 5–6 hours behind, so 08:10 UTC is about
02:10–03:10 CT.

### Running now

| Key | When (UTC) | What it does | Posts to the GL? |
|---|---|---|---|
| `controls.nightly` | daily 08:10 | Runs the control-exception detectors (duplicate payments, missed accruals, intercompany balance, uncategorized leakage, revenue not recognized, sales-tax nexus, anomalous JEs, cutoff errors, bill anomalies, out-of-policy expenses, cash-application matches) and queues new findings in **Exceptions**. | No. Detect and propose only. |
| `vendors.compliance_scan` | daily 08:30 | Expires lapsed W-9 and COI documents, advances the chase schedule, and escalates high-risk vendors to Exceptions. Sends no messages yet (`requests.remind` will). | No |
| `recurring_je.propose` | daily 09:00 | Stages each due recurring journal entry as a **proposal** for a person to approve and post. | No |
| `reports.packs` | daily 12:00 | Emails each report pack a user scheduled whose next run date has arrived. Ledger reads use the tenant-scoped client. | No |
| `revrec.monthly` | 1st, 07:00 | Previews revenue recognition through the last day of the prior month. | **Only if** the tenant set the *Scheduled revenue recognition* autonomy dial to auto-under-limit **and** the run total is under the cap. Otherwise it records a proposal ("N jobs would recognize $X") and a person posts it from Revenue recognition. |
| `prepaid.amortize` | 1st, 07:30 | Finds due prepaid amortization periods. | **Only if** the *Scheduled prepaid amortization* dial allows (same rule). |
| `events.drain` | hourly at :20 | Checks pending Projects → Books events (job billing, internal invoices, progress). | **Only if** the *Scheduled Projects event drain* dial allows, per event type, against the pending total. Progress events always wait for a person, because their amount isn't known until recognition runs. |
| `scheduler.prune_runs` | daily 10:00 | Deletes run-log rows older than 90 days. Runs once for the whole platform, not per tenant. | No |

The three autonomy dials are in the autonomy catalog (`lib/autonomy/catalog.ts`). They default to
**Propose**, so nothing posts automatically until a tenant admin turns a dial up. The kill switch
blocks them as well.

### Registered but not built yet (never run)

Each stub has a `TODO(owner)` in the registry naming what it needs first.

| Key | Owner | Waiting on |
|---|---|---|
| `bank.daily_pull` | Bank feed / Plaid | an incremental Plaid sync job (cursor already stored) |
| `connectors.sync` | Integrations (07 Phase 0) | connector staging/mapping tables and a worker |
| `requests.remind` | Requests & chase (M-7) | the request engine and an email/SMS sender (client questions, receipt chase, vendor-document chase) |
| `ap.pay_run_propose` | AP | the pay-run proposal recipe on a schedule |
| `ar.recurring` | Invoices | a draft/propose mode (today it issues invoices and posts AR) |
| `ar.dunning` | Collections | drafted dunning plus approve-before-send |
| `close.period_end` | Close | a preview mode for `/api/period-engine` (today it posts directly) |
| `lenders.prepare` | Debt & lender reporting (M-14) | lender obligation calendar and pack drafts |
| `payroll.funding_check` | Payroll | the payroll provider decision |
| `access.expiry_sweep`, `access.review_campaign` | Access & roles (05) | access assignments with end dates |
| `notifications.digest` | Notifications (M-13) | notification preferences and a sender |
| `reports.post_close_bva` | FP&A | post-close trigger and budget-vs-actual push |

## Guarantees

- **Auth:** `/api/cron/tick` accepts only `Authorization: Bearer $CRON_SECRET`, compared in constant
  time. It fails closed with a 401 if the secret is unset, shorter than 16 characters, or wrong.
  Clerk sessions are never accepted. The path is public in `middleware.ts` only so that a
  session-less cron call can reach this check.
- **Single flight:** `core.scheduler_try_lock(job, org, owner, ttl)` atomically claims the job's
  row. The lock expires after the job's timeout plus 60 s, so a run that crashed never blocks the
  job permanently. On the next claim, runs left in `running` by the dead holder are marked failed.
- **Idempotent:** each run carries `job:org:slot` as its key, and the key is unique among
  non-failed runs. A slot that is running or has finished can't start again. A failed slot can
  retry.
- **Retries:** after a failure the job backs off 5, 10, 20, 40, then 60 minutes, up to the job's
  `maxAttempts`, then gives up on that slot. A slot older than `maxLatenessMinutes` is skipped, and
  the job waits for its next slot. There is no thundering-herd catch-up after an outage.
- **Time limits:** the route has `maxDuration = 300`. A tick spends at most 240 s and starts at
  most 40 job-tenant units, three at a time. A unit only starts if its full timeout fits in the
  time left. Anything left over is still due, and the next tick (5 minutes later) picks it up,
  oldest first.
- **Errors stay contained:** a job that throws, times out, or returns `failed` is logged in
  `core.job_runs.error`. Other jobs in the same tick still run.
- **Tenant isolation:** jobs that read a tenant's books use a per-tenant RLS-scoped client
  (`createOrgScopedSupabase`). They fail closed, never falling back to the service role. The event
  drains use the service role exactly as their routes do: every read and write inside them is
  pinned to the event's own `org_id`, and the job passes the tenant filter.
- **Logs:** each tick and each run writes one JSON line to the console:
  `scheduler.tick`, `scheduler.run`, `scheduler.unit_error`.

## Reading the run log

`GET /api/scheduler/runs?job_key=&status=&limit=&before=` requires a signed-in user with
`settings_system:view`, scoped to the caller's own tenant. It returns:

- `jobs`: every registered job with its effective on/off state for this tenant, cron, last run,
  next run, consecutive failures, and a `state` of `running_normally`, `failing`, `disabled`,
  `not_built`, or `never_run`.
- `runs`: the newest runs first, with counts, summary, and error.
- `nextCursor`: pass it back as `before` to get the next page.

## How to add a job

1. **Write the job** in `apps/web/src/lib/scheduler/jobs/<area>.ts` as
   `async (ctx: JobContext) => JobResult`.
   - For tenant data, start with `scopedOrFail(ctx)` (`jobs/shared.ts`). It hands you the RLS-scoped
     client, or returns a failed result if one can't be minted. Never read tenant books with
     `ctx.admin`.
   - Call an **existing engine**. Don't write accounting logic inside the job.
   - If the engine can post to the GL: preview first, then call
     `postingGate(ctx.admin, orgId, FEATURE, amountCents)` and post only when `allowed`. Add the
     feature key to `lib/autonomy/catalog.ts` with `defaultMode: 'PROPOSE'`.
   - In long loops, check `ctx.signal.aborted` and stop cleanly.
   - Return `ok` (including "proposed only"), `partial`, `skipped` (nothing to do), or `failed`, with
     a one-line `summary` a bookkeeper can read.
2. **Register it** in `registry.ts`. Pick a `key` in `area.verb` form that matches the DB check
   `^[a-z0-9_]+(\.[a-z0-9_:-]+)+$` (use the IA §6 name if it has one). Then set:
   - `cron` in UTC
   - `timeoutMs` of 240 000 ms or less
   - `maxLatenessMinutes`
   - `maxAttempts`
   - `postsToGl` and `autonomyFeature`
   - `owner` and `ownerCapability`

   To replace a stub, swap the `stub(...)` entry for a full definition.
3. **Test it.** `registry.test.ts` enforces unique, valid keys and crons, timeouts within budget,
   and that every GL-posting job has a catalogued autonomy feature. Add a job-level test with a fake
   client, as `registry.test.ts` does for rev-rec and the event drain.
4. **No migration is needed** to add a job. State rows are created the first time a job runs.

## Files

| Path | Role |
|---|---|
| `packages/supabase/migrations/162_scheduler.sql` | `core.scheduled_jobs`, `core.job_runs`, `core.scheduler_try_lock`, RLS and grants |
| `apps/web/vercel.json` | the Vercel Cron entry (`*/5 * * * *` → `/api/cron/tick`) |
| `apps/web/src/app/api/cron/tick/route.ts` | the dispatcher (secret-gated) |
| `apps/web/src/app/api/scheduler/runs/route.ts` | the run-log read API |
| `apps/web/src/lib/scheduler/` | `cron.ts` (parser), `run.ts` (runner), `store.ts` (DB), `registry.ts`, `posting-gate.ts`, `cron-auth.ts`, `dispatch.ts`, `health.ts`, `jobs/*` |
| `apps/web/src/lib/reports/compiler/scheduled-delivery.tsx` | pack delivery engine, shared with the legacy `/api/reports/packs/run-scheduled` |

**Vercel plan note:** a cron more frequent than once a day needs a Pro (or Enterprise) team. On
Hobby, Vercel rejects the deployment. If that happens, change the schedule in `vercel.json` to
`0 * * * *` (or daily) and the jobs simply run later.
