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
| `requests.remind` | every 15 min | The request & chase engine: sends due asks (W-9 / COI, questions, documents, approvals, receipts, payment reminders) on their cadence, honouring quiet hours, unsubscribes and send quotas; closes what is already answered (incl. a payment reminder for an invoice that got paid); escalates. | No |
| `bank.daily_pull` | daily 11:00 | Incremental Plaid sync per connected bank; flags feeds stale for 48 h. | No |
| `controls.nightly` | daily 08:10 | Runs the control-exception detectors and queues new findings in **Exceptions**. | No. Detect and propose only. |
| `vendors.compliance_scan` | daily 08:30 | Expires lapsed W-9 / COI documents, advances the chase schedule, escalates high-risk vendors. | No |
| `vendors.ai_recheck` | hourly :07 | (2A) Re-reads vendor certificates that arrived while AI was paused. Proposes only. | No |
| `receipts.chase_sync` / `receipts.weekly_digest` | every 15 min / Mon 14:00 | (2B) Receipt chase through the request engine; Monday bookkeeper digest. | No |
| `recurring_je.propose` | daily 09:00 | Stages each due recurring journal entry as a **proposal**. | No |
| `ar.recurring` | daily 12:00 | Generates every recurring invoice that has come due, once per template + period (template advance + `source_ref recurring:<template>:<date>`, unique per org). Each is a **DRAFT** for review unless the template is set to *Post* / *Post and email* **and** the *Scheduled recurring invoices* dial allows that template's total. | **Only if** the template mode posts **and** the dial is auto-under-limit within the cap. |
| `ar.dunning` | daily 14:00 | The dunning ladder (Settings → Automation → Payment reminders): for each open invoice, the next step (courtesy / first / second / third / final notice, days from due) as a `core.requests` row, so the request engine sends it. Stops on payment, promise-to-pay, dispute, excluded customer, minimum balance. Mirrors each send onto the invoice as `REMINDER_SENT`. **Draft** reminders wait in Requests for *Send now*. | No. Sends on its own only when the company policy is *Send* **and** the *Scheduled payment reminders* dial allows that invoice's balance. |
| `ar.late_fees` | daily 14:30 | Proposes late fees under the late-fee policy (flat or % per month, grace, min / max, lifetime cap, customers) — one per invoice per month (unique), never on a finance-charge invoice, never on a disputed invoice. A person approves (→ one posted finance-charge invoice per company + customer) or rejects (never re-proposed for that month). | No (approval posts, by a person). |
| `reports.packs` | daily 12:00 | Emails each scheduled report pack that is due. | No |
| `revrec.monthly` | 1st, 07:00 | Proposes last month's WIP entry per company; posts only when the company is AUTO_POST **and** the *Scheduled revenue recognition* dial allows. | Dial-gated |
| `prepaid.amortize` | 1st, 07:30 | Due prepaid amortization periods. | Dial-gated (*Scheduled prepaid amortization*) |
| `close.depreciation` | 1st, 08:00 | Last month's depreciation (fixed assets) and amortization (intangibles), previewed one line per company with the engines' own schedule math. HARD_CLOSE months are excluded and an asset's catch-up stops there. Reports lease periods due (never auto-posted: they carry the cash leg the bank feed also sees). | Dial-gated (*Scheduled depreciation & amortization*), month total ≤ cap. |
| `insurance.amortize` | 1st, 08:15 | Due prepaid-insurance periods through last month-end. | Dial-gated (*Scheduled insurance amortization*). |
| `close.period_end` | days 2–10, 13:00 | Opens last month's close checklist (one `close_checklists` row per close-graph task) for every company with an open period, refreshes the AUTO answers from the readiness board, and tells admins "N ready, M blocked". Leaves HARD_CLOSE periods alone. | Never |
| `ap.pay_run_propose` | Mondays 13:00 | Starts a PAY_RUN agent run: approved bills due in 7 days plus bills whose early-pay discount date (migration 184 `bills.early_pay_discount_*`) falls in that window, ordered by pay-by date, with the savings. Pauses at release; release only prepares approvals and a second person approves and pays (SoD). One live proposal at a time. | Never (no auto mode for money out) |
| `notifications.digest` | hourly :05 | At 08:00 in each person's time zone (outside their quiet hours), emails a digest of their unread notifications to everyone who chose *daily* (or, Mondays, *weekly*); each item at most once (`emailed_at`). | No |
| `events.drain` | hourly :20 | Pending Projects → Books events. | Dial-gated per event type |
| `access.expiry_sweep` | daily 06:00 | Ends expired access grants and stale access requests. | No |
| `scheduler.prune_runs` | daily 10:00 | Deletes run-log rows older than 90 days (platform). | No |

Every dial defaults to **Propose**, so nothing posts or auto-sends until a tenant admin raises it
(Settings → Autonomy). The kill switch blocks them all. Jobs that only propose still tell the
tenant's admins in-app ("October depreciation is ready to post: $X across N companies"), and the
digest folds those notes into email.

### Registered but not built yet (never run)

| Key | Owner | Waiting on |
|---|---|---|
| `connectors.sync` | Integrations (07 Phase 0) | connector staging/mapping tables and a worker |
| `lenders.prepare` | Debt & lender reporting (M-14) | lender obligation calendar and pack drafts |
| `payroll.funding_check` | Payroll | the payroll provider decision (task #32) |
| `access.review_campaign` | Access & roles (05) | the quarterly campaign opener |
| `reports.post_close_bva` | FP&A | post-close trigger and budget-vs-actual push |

## The Automation screen (Settings → Automation, `/settings/automation`)

- **Scheduled jobs** — every job with its state (running / failing / off / waiting for first run /
  not built), schedule in plain English, last run (outcome, items, by hand or not), next run, an
  on/off switch per tenant (`PUT /api/scheduler/jobs`, writes the tenant override; `null` = back to
  the default) and **Run now** (`POST /api/scheduler/run-now`, confirmed). Both need
  `settings_system:edit`. Run now takes the same single-flight lock as the tick, records a
  `trigger: 'manual'` run with the person as actor, and does not touch the cron slot bookkeeping.
  The selected job's run history shows summaries, counts and errors.
- **Payment reminders** — the dunning ladder per tenant or per company (`dunning_policies`).
- **Late fees** — the late-fee policy per tenant or per company (`late_fee_policies`) and the
  approval queue (`GET/POST /api/collections/late-fees`, approve needs `invoices:approve`).
- `POST /api/collections/dispute` marks / clears an invoice dispute (holds dunning + late fees).

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
| `packages/supabase/migrations/184_automation_policies.sql` | dunning / late-fee policies, late-fee proposals, recurring `generate_mode`, invoice dispute marker, bill early-pay discount |
| `apps/web/src/lib/scheduler/manual.ts` | Run now + the tenant on/off switch |
| `apps/web/src/app/(app)/settings/automation/` | the Automation screen |
| `apps/web/vercel.json` | the Vercel Cron entry (`*/5 * * * *` → `/api/cron/tick`) |
| `apps/web/src/app/api/cron/tick/route.ts` | the dispatcher (secret-gated) |
| `apps/web/src/app/api/scheduler/runs/route.ts` | the run-log read API (jobs carry `lastRun`) |
| `apps/web/src/app/api/scheduler/run-now/route.ts`, `.../scheduler/jobs/route.ts` | Run now, on/off |
| `apps/web/src/lib/scheduler/` | `cron.ts` (parser), `run.ts` (runner), `store.ts` (DB), `registry.ts`, `posting-gate.ts`, `cron-auth.ts`, `dispatch.ts`, `health.ts`, `jobs/*` |
| `apps/web/src/lib/reports/compiler/scheduled-delivery.tsx` | pack delivery engine, shared with the legacy `/api/reports/packs/run-scheduled` |

**Vercel plan note:** a cron more frequent than once a day needs a Pro (or Enterprise) team. On
Hobby, Vercel rejects the deployment. If that happens, change the schedule in `vercel.json` to
`0 * * * *` (or daily) and the jobs simply run later.
