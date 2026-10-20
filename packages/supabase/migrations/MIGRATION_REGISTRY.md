# Shared Migration Registry — meritbooks monorepo

Two workstreams write into one migration sequence (`packages/supabase/migrations/`):
**MeritBooks** (`apps/web`, schemas `core`/`books`) and **MeritProjects** (`apps/projects`, schema `proj`).

## Number bands (owner decision — session 42)

| Band | Owner | Notes |
|---|---|---|
| `001`–`999` | **MeritBooks** | Organic sequence (~`071`). |
| **`1001`+** | **MeritProjects** | All `proj` migrations. Fully disjoint. |

Projects migrations sort after all Books migrations, which is safe: `proj` depends only on
`core` objects ≤ `061`; Books never depends on `proj`.

## Rules (both sessions)

1. **Schema-tag every filename.** Projects: `NNN_proj_<name>.sql`.
2. **Path-scoped commits only.** Never `git add -A`. Add only your own files.
3. **Idempotent DDL** (`create … if not exists`, `create or replace`, `alter … add column if not exists`,
   `on conflict do nothing`, guarded `create policy`). Apply via Supabase MCP `apply_migration`,
   verify with a rolled-back `DO`-block smoke, then commit.
4. **Additive across the seam.** The three frozen events take only additive nullable payload keys.

## MeritProjects allocation (1001 band)

| # | File | Gate | Status |
|---|---|---|---|
| 1001 | `1001_proj_polymorphic_core.sql` | G1 | ✅ applied — cost_codes, archetype_profiles, job_settings, `job_cap()`, cost_code_id thread, drain enrichment, `v_cost_code_slippage` |
| 1002 | `1002_proj_seam_uuid_hardening.sql` | G1 | ✅ applied — seam bugfix (`uuid_generate_v4`→`gen_random_uuid`) |
| 1003 | `1003_proj_commitments.sql` | G5 | ✅ applied — commitments + drain draw-down + third number (`committed_open`, `projected_final`) |
| 1004 | `1004_proj_billing_engines.sql` | G7 | ✅ applied — SOV (`sov_versions`/`sov_lines` + `v_sov_status`), retainage ledger (`retainage_ledger` + `v_job_retainage`) + `contracts.retention_pct`/`payer_type`/financing, allowances (`allowances` + `v_allowance_status`), `billing_type` widened (`SOV`,`RETAINAGE_RELEASE`,`ALLOWANCE`), `billing_request_lines.sov_line_id`/`line_type`, `billing_requests.retainage_cents`. Engines: `activate_sov_version`, `generate_sov_billing` (AIA progress bill: incremental earned − retainage), `release_retainage`; `approve_and_emit_billing` adds additive-nullable `retainage_cents` seam key. All definer fns org-scoped; RLS+WITH CHECK on 4 new tables. Verified: SOV bill net/retainage math, retainage ledger, cross-org rejection, draft-dedup (re-synced live as `1004b`). Security GO. |
| 1005 | `1005_proj_operational.sql` | G6 | ✅ applied — scheduling/dispatch (crews, work_orders), field (daily_logs, tasks, time_entries dual-rate pinned, field_attachments, `materialize_time_cost`), procurement (reuses `commitments`; adds `po_receipts`, `doc_number_counters`/`next_doc_number`, PO# mint in `approve_commitment`, `ordered_qty`/`uom`), gates/compliance (external_gates, compliance_docs, submittals, rfis + `advance_external_gate`/`payment_eligible`/`draw_precondition_met`/`close_eligible` + presence-based billing precondition in `approve_and_emit_billing` + views). Also backfills `job_settings.uses_external_gates` (latent 1001 gap) and hardens the drain cache refresh (auditor note). |
| 1006 | `1006_proj_security_org_scoping.sql` | hotfix | ✅ applied — SECURITY: org-scope the SECURITY DEFINER mutators (`approve_and_emit_billing`, `approve_commitment`, `advance_external_gate`, `approve_change_order`, `set_contract`, `update_progress`). They fetched by id/job with no org filter; once exposed via write-path routes a cross-org caller could act on / emit money into another tenant. Verified both ways (legit works, cross-org rejected). |
| 1007 | `1007_proj_function_execute_lockdown.sql` | hotfix | ✅ applied 2026-10-20 — SECURITY: revoke PUBLIC/anon EXECUTE on every `proj` function (anon could call unguarded SECURITY DEFINER `emit_job_progress`/`drain_job_costs`/`next_doc_number` over PostgREST → cross-tenant event injection). Org-scoped RPC mutators + invoker-view helpers re-granted to `authenticated`; internals service_role only. Verified: anon → 42501. (Old G8/G9 reservations superseded by the v2 rebuild.) |
| 1008–1099 | _(reserved)_ | legacy | hotfixes to legacy `proj` during coexistence only |

## Merit Projects v2 — schema `pm` (band 1100–1199; blueprint `docs/projects/MERIT-PROJECTS-V2-BLUEPRINT.md`)

| # | File | Status |
|---|---|---|
| 1100 | `1100_pm_foundation.sql` | applying 2026-10-20 (parts 1–3 live via MCP; 4–6 via SQL editor) — schema `pm`, packs, materialized config, job spine, guards, definer fns (apply_pack_plan, create_project, transition_stage, emit_job_progress, set_contract, set_progress, approve/advance_change_order, load_sample_job, remove_sample_data), views. Shared-spine additive: `core_jobs_org_id_id_uidx`. PGlite harness 113/113. |
| 1101 | _(next)_ | commitments + billing (SOV, retainage, deposits) + JOB_COMMITMENT/JOB_BILLING emitters |
| 1102 | _(next)_ | JOB_COST drain (replayable) + job financial views |

> `1004` (G7) built after `1005`/`1006` — independent, idempotent. Legacy `proj` is frozen; new work goes to `pm` (1100+).
>
> **RBAC now CLOSED (session 44):** a Projects RBAC layer (`apps/projects/src/lib/rbac/permissions.ts` + `require-permission.ts`) mirrors the Books role vocabulary (`core.employees.role` normalized), reads the caller's role through the RLS-scoped client (inherently org-scoped, no service-role, fails closed), and gates all 16 mutating proj routes — money/approve surfaces require the `approve` action, specialist can create-not-approve (separation of duties). Follow-up (a) resolved. Security verdict GO (risks A–G clean).
>
> **Known follow-ups (non-blocking):** (b) create routes trust a client `job_id` (FK bypasses RLS) — low impact (row lands in caller's org), fix = job-visibility pre-check or composite FK; (c) work-orders PATCH keys off body id not URL id (RLS keeps it in-org).

## G6 app slices (designed by the parallel builder wave, not yet built as code)

The 1005 schema is live; the `apps/projects` route/component slices are file-disjoint and specced:
`/dispatch` (board), `(field)/field/*` (mobile capture), `/api/procurement/*` (PO/receipts),
`jobs/[jobId]/{gates,compliance,submittals,rfis}` + `/api/{gates,compliance,submittals,rfis}/*`.
These build against the live app (deployed at `meritbooks-projects`) once picked up.
