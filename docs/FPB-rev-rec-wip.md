# FPB — Revenue recognition election & monthly WIP (accrue revenue / accrue AR for underbillings)

Status: **promoted from `docs/REV-REC-WIP-SPEC.md`** (owner-approved posture: propose-and-approve,
both sides always booked). Wave 1E. Audit rows RR-01, RR-02, RR-05, RR-06 (`docs/audit-2026-10/FEATURE-GAP-AUDIT.md` §2.5).
Migration **179**. Persona: the business owner (sets the policy once, in plain English) and the
controller / CPA (reviews the WIP schedule and approves the month-end entry).

## 1. Purpose

A contractor's books are wrong between billings unless earned-but-unbilled revenue (underbillings)
and billed-but-unearned revenue (overbillings) are booked every month. MeritBooks already had the
math (9 methods) but hid the choice in a Settings tab, had two overlapping 1180 mechanisms, and the
monthly run had never run. This brief makes the election visible, merges the mechanisms into one
canonical engine, and puts the WIP entry in the close.

## 2. Benchmark (named deltas)

| Product | What they do | Our delta |
|---|---|---|
| Foundation / Sage 100 Contractor | WIP schedule → manual over/under JE, reversed next month | Same entry, **computed and proposed for you**, tied to GL 1180/2410 on screen, one-click approve, auto-reverse. |
| QuickBooks Online | No POC; "progress invoicing" only; users hand-book WIP in Excel | Native method-per-job (9 methods), inheritance company → job type → job. |
| Sage Intacct Construction | WIP + contract module, heavy setup | Plain-English election card with a worked example entry in cents. |

## 3. Policy (per company) — `public.rev_rec_policies`

| Field | Values | Default | Meaning (owner wording) |
|---|---|---|---|
| Recognition basis | the 9 methods (`core.locations.rev_rec_method`, unchanged home) | `PCT_COSTS_INCURRED` | "How do you recognize revenue on jobs?" |
| `accrue_underbillings` | on/off | on | "Book earned-but-not-yet-billed revenue as Unbilled AR (1180) each month." |
| `defer_overbillings` | on/off | on | "Hold billed-but-not-yet-earned revenue as a liability (2410) each month." |
| `loss_provision` | on/off | on | "If a job's estimated cost passes its contract, book the whole expected loss now (GAAP)." |
| `run_cadence` | `MONTHLY_AT_CLOSE` · `ON_DEMAND` | `MONTHLY_AT_CLOSE` | Scheduler proposes on the 1st, or only when someone clicks. |
| `posting_mode` | `PROPOSE` · `AUTO_POST` | `PROPOSE` | AUTO_POST only posts when the tenant's `SCHEDULED_REV_REC` autonomy dial also allows (the stricter wins). |
| `materiality_cents` | ≥ 0 | 0 | Job adjustments smaller than this are left out of the entry (shown "below threshold"). |
| `retainage_presentation` | `SEPARATE` · `INCLUDED_IN_AR` | `SEPARATE` | Display of retainage on the schedule; billings are always gross of retainage. |

Overrides: per **job type** (`rev_rec_method_map.accrue_underbillings / defer_overbillings`, nullable)
and per **job** (`public.rev_rec_job_overrides`: the two switches nullable + `exclude_from_wip`).
Resolution for each switch: job → job type → company → default; the UI shows "inherits from company".
Method resolution is unchanged (job override → revenue type → job type → company default).

## 4. The canonical engine (one mechanism)

`lib/rev-rec/wip-engine.ts` (pure) + `lib/rev-rec/wip-run-service.ts` (I/O). Per job, as of period end:

- earned = `earnedToDate(method)` (rev-rec.ts stays the method authority); EAC = max(estimate, cost to date);
  % complete; billed (gross, incl. retainage); under = max(0, earned − billed); over = max(0, billed − earned);
  loss provision = max(0, (EAC − contract) − max(0, cost to date − earned)) for contract methods;
  est. gross profit = contract − EAC; fade/gain = est. GP − last month's est. GP.
- Two entries per company per month, in ONE proposal:
  1. **WIP adjustment — self-reversing** (entry_type `ADJUSTING`, source_module `REV_REC_WIP`): per job
     DR 1180 / CR Revenue (under), DR Revenue / CR 2410 (over), DR Contract loss (COGS) / CR Provision for
     contract losses (loss), all by ROLE. It brings the job's WIP-module balances to target, so a re-run
     after posting books only the true-up. A **reversal** (entry_type `REVERSING`) is posted dated the
     first day of the next month at the same time.
  2. **Billings reclass — permanent** (source_module `REV_REC_WIP_RECLASS`): moves any non-WIP 1180/2410
     balance on the job (deferred billings, legacy recognition, the retired manual accrual) into revenue,
     so the reversing entry measures over/under against billings. Revenue is never double counted:
     at every month end revenue on the job = earned to date, 1180 = under, 2410 = over (netted per contract).
- Idempotent per company+period+revision: source_refs `rev_rec_wip:<loc>:<YYYY-MM>:r<n>` (+ `:reversal`,
  `:reclass`) under migration 064's UNIQUE(org_id, source_ref, entry_type).
- The standalone 1180 accrual (`unbilled-accrual-service`) and the batch `recognizeRun` are **retired**;
  `/api/rev-rec/run` and `/api/rev-rec/accrue-unbilled` are aliases into the canonical step.
  The Projects-seam `JOB_PROGRESS` consumer still pins inputs and may post interim recognition; the
  month-end reclass + WIP adjustment trues it up by construction (adjust-to-target on GL balances).

## 5. Close integration

New blocking AUTO close task **`wip_accrual_reviewed` — "WIP: review proposed accrual"** (FINAL phase,
after AR/AP tie, before final review). Passes when the company has no WIP jobs / both switches off, or
the period's run is POSTED, NO_CHANGE, or DISMISSED **with a reason (≥ 4 chars)**. Blocks hard close when
the run is PROPOSED or not yet run. Deep link `/jobs/wip`.

## 6. Screens

- **"How do you recognize revenue?" card** (Revenue recognition → Policy, and Settings → Revenue recognition):
  plain-English method choices, each with a worked example in cents computed by the engine; the three
  switches; cadence / posting mode / materiality / retainage; job-type and job overrides with
  "inherits from company".
- **WIP schedule `/jobs/wip`** (merit-ui): period selector, per-job schedule (contract, EAC, cost, %,
  earned, billed, retainage, under, over, loss, fade/gain vs last month), totals, **tie-out to GL 1180/2410
  (difference shown)**, prior-month comparison, the proposal with per-job drill-down, Propose / Approve &
  post / Dismiss-with-reason, CSV export, drill to job.
- **Revenue recognition `/rev-rec`**: the month-end proposal, run history, next scheduled run.

## 7. Acceptance criteria (testable)

1. Each of the 9 methods' earned amount is computed in integer cents (unit test per method).
2. An underbilled job proposes DR 1180 / CR Revenue; an overbilled job DR Revenue / CR 2410; both balanced;
   the reversal flips every line and is dated the 1st of the next month; across two simulated months
   revenue per month = Δ earned and month-end 1180/2410 = under/over.
3. A loss job (EAC > contract) books the full remaining anticipated loss; switch off → no loss lines.
4. Switch / exclusion resolution: job → job type → company → default (unit test, incl. "inherits").
5. Tie-out: schedule under/over vs GL 1180/2410 job balances, difference = 0 after posting (unit test).
6. Close: PROPOSED or not-run → `wip_accrual_reviewed` blocks `readyToHardClose`; POSTED / DISMISSED / not
   applicable → passes (unit test). Dismiss without a reason is refused (API + DB CHECK).
7. Scheduler `revrec.monthly` (key unchanged): proposes for every MONTHLY_AT_CLOSE company; posts only when
   policy is AUTO_POST **and** the autonomy dial allows under the cap; kill switch → never posts (unit test).
8. Every new table: RLS on, member SELECT only, writes via the service role after permission + org pin +
   client-scope assert (business-write-lock ratchet stays green).
9. Existing rev-rec / job-progress / billing-consumer / projects-seam tests stay green.

## 8. Out of scope / follow-ups

- Cost-code-level EAC (RR-07), change-order log (RR-08), ASC 606 POB allocation (RR-11).
- Billing tie: billed-to-date comes from the job record; a GL-billings reconciliation tile is a follow-up.
- Make the `JOB_PROGRESS` consumer pin-only for MONTHLY_AT_CLOSE companies (removes interim noise).
