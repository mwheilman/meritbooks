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
| 1004 | _(reserved)_ | G7 | SOV (`sov_versions`, `sov_lines`) + retainage + allowances + `billing_type` enum + payer columns |
| 1005 | `1005_proj_operational.sql` | G6 | ✅ applied — scheduling/dispatch (crews, work_orders), field (daily_logs, tasks, time_entries dual-rate pinned, field_attachments, `materialize_time_cost`), procurement (reuses `commitments`; adds `po_receipts`, `doc_number_counters`/`next_doc_number`, PO# mint in `approve_commitment`, `ordered_qty`/`uom`), gates/compliance (external_gates, compliance_docs, submittals, rfis + `advance_external_gate`/`payment_eligible`/`draw_precondition_met`/`close_eligible` + presence-based billing precondition in `approve_and_emit_billing` + views). Also backfills `job_settings.uses_external_gates` (latent 1001 gap) and hardens the drain cache refresh (auditor note). |
| 1006 | `1006_proj_security_org_scoping.sql` | hotfix | ✅ applied — SECURITY: org-scope the SECURITY DEFINER mutators (`approve_and_emit_billing`, `approve_commitment`, `advance_external_gate`, `approve_change_order`, `set_contract`, `update_progress`). They fetched by id/job with no org filter; once exposed via write-path routes a cross-org caller could act on / emit money into another tenant. Verified both ways (legit works, cross-org rejected). |
| 1007 | _(reserved)_ | G8 | recurring_service + entitlements + routes + generator + `RECURRING` billing_type |
| 1008 | _(reserved)_ | G9 | engagement stitching (`core.jobs.parent_job_id` [CORE]) + warranty + `v_job_margin` child rollup |

> `1004` (G7 SOV) reserved and built after `1005`/`1006` — independent, idempotent. **Next free: `1004` (G7), then `1007` (G8), `1008` (G9).**
>
> **Known follow-ups (security agent, non-blocking after 1006):** (a) no RBAC permission gate on the money/approve routes yet — any authenticated member can issue a draw (intra-org; Projects has no role layer yet, mirrors Books' open RBAC gate); (b) create routes trust a client `job_id` (FK bypasses RLS) — low impact (row lands in caller's org), fix = job-visibility pre-check or composite FK; (c) work-orders PATCH keys off body id not URL id (RLS keeps it in-org).

## G6 app slices (designed by the parallel builder wave, not yet built as code)

The 1005 schema is live; the `apps/projects` route/component slices are file-disjoint and specced:
`/dispatch` (board), `(field)/field/*` (mobile capture), `/api/procurement/*` (PO/receipts),
`jobs/[jobId]/{gates,compliance,submittals,rfis}` + `/api/{gates,compliance,submittals,rfis}/*`.
These build against the live app (deployed at `meritbooks-projects`) once picked up.
