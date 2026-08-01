# Shared Migration Registry — meritbooks monorepo

This monorepo hosts **two workstreams writing into one migration sequence**
(`packages/supabase/migrations/`), per the one-schema / one-Postgres
architecture:

- **MeritBooks** (`apps/web`, schemas `core` / `books`)
- **MeritProjects** (`apps/projects`, schema `proj`)

Because both author migrations independently, a shared linear number sequence
races. This registry + the rules below make collisions impossible.

## Number bands (owner decision — session 42)

| Band | Owner | Notes |
|---|---|---|
| `001`–`999` | **MeritBooks** | Organic sequence. Currently ~`071`. Keep going here. |
| **`1001`+** | **MeritProjects** | All `proj` migrations. Fully disjoint — no adjacency to Books. |

MeritProjects deliberately jumps to a high, reserved band so the two
workstreams never negotiate a number again. Projects migrations sort *after*
all Books migrations, which is safe: `proj` depends only on `core` objects that
already exist (≤ `061`); Books never depends on `proj`.

## Rules (both sessions)

1. **Schema-tag every filename.** Projects: `NNN_proj_<name>.sql`. Books: keep
   its existing descriptive names (non-`proj`). Identical filenames are the only
   thing git can silently clobber — tagging guarantees uniqueness, so a number
   race surfaces as a git conflict instead of a lost migration.
2. **Path-scoped commits only.** Never `git add -A`. Add exactly your own files:
   - Projects: `git add packages/supabase/migrations/NNN_proj_*.sql apps/projects/…`
   - Books: `git add` its own paths.
3. **Idempotent DDL.** `create … if not exists`, `create or replace`,
   `alter … add column if not exists`, `on conflict do nothing`, and guarded
   `create policy` (catch `duplicate_object`). Re-running any migration is a
   no-op. This is the real safety net given the applied-ledger uses MCP-generated
   timestamp versions, not the numeric filename prefix.
4. **Additive across the seam.** The three frozen events (JOB_COST, JOB_BILLING,
   JOB_PROGRESS) take only additive, nullable, back-compatible payload keys.
   Never change a key, direction, lifecycle, or keying.

## MeritProjects allocation (1001 band)

| # | File | Gate | Status |
|---|---|---|---|
| 1001 | `1001_proj_polymorphic_core.sql` | G1 | ✅ applied — cost_codes, archetype_profiles, job_settings, `job_cap()`, cost_code_id thread, drain enrichment, `v_cost_code_slippage` |
| 1002 | `1002_proj_seam_uuid_hardening.sql` | G1 | ✅ applied — seam bugfix (`uuid_generate_v4`→`gen_random_uuid` in emit/billing fns) |
| 1003 | `1003_proj_commitments.sql` | G5 | ✅ applied — `commitments`, `commitment_lines`, `commitment_line_id` thread + drain draw-down, `v_commitment_status`, third number (`committed_open_cents` + `projected_final_cents`) on `v_job_operational_cost`/`v_job_margin`, `approve_commitment()` |
| 1004 | _(reserved)_ | G7 | SOV (`sov_versions`, `sov_lines`) + retainage (`retainage_ledger`, `contracts.retention_pct`) + allowances + `billing_type` enum + payer columns |
| 1005 | _(reserved)_ | G6/G7 | compliance_docs + financing + cost_plus_terms + draw builders + operational tables |
| 1006 | _(reserved)_ | G8 | recurring_service + entitlements + routes + generator + `RECURRING` billing_type |
| 1007 | _(reserved)_ | G9 | engagement stitching (`core.jobs.parent_job_id` [CORE]) + warranty + `v_job_margin` child rollup |

> Reserved rows are the planned foundational-model sequence (Master Build Plan
> Part 1, rebased onto the 1001 band). Claim the next free number here + `ls`
> the folder before authoring. **Next free: `1004`.**
