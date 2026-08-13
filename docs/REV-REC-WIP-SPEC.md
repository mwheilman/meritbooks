# Revenue Recognition & WIP — Policy Capture + Propose-and-Approve Close

Status: spec (owner-approved posture: **propose-and-approve**, both sides always booked).
Scope: how MeritBooks treats earned-but-unbilled (and billed-but-unearned) revenue for
job/contract businesses, from the onboarding policy choice through the monthly close.

## 1. Principle

Under **accrual + percentage-of-completion (cost-to-cost)** the recognition of earned
revenue is not optional and is not a per-transaction user choice — it is the method.
Each period:

    earned revenue = (costs incurred to date / estimated total cost) × contract price

Then earned is compared to billed:

- earned **>** billed → **underbilling** → **contract asset** (Costs & Estimated Earnings
  in Excess of Billings / unbilled receivable, acct **1180**).
- billed **>** earned → **overbilling** → **contract liability** (Billings in Excess /
  deferred revenue, acct **2410**).

The accrual is ALWAYS a balanced double entry — the revenue side and the receivable (or
liability) side are booked together, never one without the other:

- Underbilling: **DR Unbilled Receivable / Contract Asset (1180)  |  CR Revenue**
- Overbilling:  **DR Revenue (defer)  |  CR Deferred Revenue / Billings-in-Excess (2410)**

## 2. Policy is captured in ONBOARDING, behavior follows automatically

Onboarding's "rev-rec inquiry" captures, per company and per revenue stream:

- **Basis:** accrual or cash.
- **Rev-rec method:** POINT_OF_SALE, AS_BILLED (T&M), PCT_COSTS_INCURRED (cost-to-cost),
  PCT_COMPLETE (physical), COMPLETED_CONTRACT, MILESTONE, RATABLY, SUBSCRIPTION, CASH.

That single choice determines whether underbilling accrues at all:

| Basis / method | Underbilling accrual behavior |
|---|---|
| Accrual + PCT_COSTS_INCURRED / PCT_COMPLETE | **Auto-propose every close** (this spec) |
| Accrual + COMPLETED_CONTRACT | No recognition until the job completes → no interim accrual |
| Accrual + AS_BILLED (T&M) | earned ≡ billed → no under/over to accrue |
| Accrual + MILESTONE | Recognize at accepted milestones; accrue only earned-not-yet-billed milestones |
| Cash basis | No accrual of unbilled revenue at all |

The user does not separately "turn on" the accrual — choosing accrual + a %-completion
method IS turning it on. Choosing cash or completed-contract turns it off. This is the
correct home for the decision and removes a class of "the books are wrong between
billings" errors.

## 3. Propose-and-approve at close (owner-chosen posture)

Recognition is **proposed by the system and approved by a human** every period — never
silently auto-posted. Rationale: earned revenue depends on **estimated total cost (EAC)**,
a judgment. A stale EAC is exactly how profit fade and misstated revenue happen, so a
controller must keep eyes on the EAC each month.

Close step ("Recognize revenue / update WIP"):

1. The WIP engine computes, per job: costs-to-date (from the ledger), EAC (maintained
   estimate), % complete, earned revenue, billed-to-date, and the over/under position.
2. The step **proposes** the period entry for every job on an accrual %-completion method:
   underbillings → DR 1180 / CR Revenue; overbillings → DR Revenue / CR 2410; sized as the
   delta needed to bring the contract asset/liability to its target (adjust-to-target).
3. The controller **reviews the WIP schedule + EAC**, can revise an EAC (triggering a
   cumulative catch-up), and **approves**. Approval posts the balanced JEs.
4. SoD preserved: preparer proposes (journal_entries:create-equivalent), approver posts
   (journal_entries:post). Idempotent per job+period via source_ref `rev_rec:<job>:<YYYY-MM>`
   + migration-064 UNIQUE(org_id, source_ref, entry_type).

Optional future posture (not now): a company may opt a mature job stream into
fully-automatic recognition with the exception library flagging outliers. Default and
recommended remains propose-and-approve.

## 4. Both sides — and the full receivable lifecycle

The accrual books the **revenue AND the AR (asset) side** by construction. The unbilled
receivable is a real current asset:

- It sits on the **balance sheet** as a contract asset (1180), distinct from trade AR (1100).
- It appears on the **AR aging** as its own "Unbilled Receivable (Contract Asset)" section,
  aged to the accrual month, rolling into Total Receivables — while staying in its own
  account so the trade-AR subledger still ties to 1100.
- It ties to the GL 1180 balance by construction (role-resolved, balanced, idempotent).

**Billing reclass (the half people get wrong):** when the customer is later invoiced for
work already recognized, the entry MOVES the balance from unbilled to billed and does NOT
re-recognize revenue:

    DR Trade Accounts Receivable (1100)  |  CR Unbilled Receivable / Contract Asset (1180)

Revenue is untouched (it was recognized at the close). Billing is decoupled from
recognition. This reclass must be airtight in the unified close/billing path so recognition
and billing never double-count. On collection: DR Cash / CR 1100 as normal.

## 5. Unify the two mechanisms (fix the current smell)

Today there are two overlapping paths that both touch 1180: the automated rev-rec
recognition engine (`lib/services/rev-rec.ts`) and the standalone manual unbilled-accrual
action (`lib/rev-rec/unbilled-accrual*`). They net against each other to avoid double-count
but are two doors to one room. **Collapse them into ONE method-driven, close-integrated,
propose-and-approve recognition step**; retire the standalone manual accrual (or make it an
alias into the unified step). One mechanism, driven by the onboarding policy.

## 6. Data dependencies (captured in onboarding)

For the accrual to be correct on day one, onboarding must bring in, per job:
contract value + change orders, **budget/EAC by cost code**, costs-to-date, billed-to-date,
retainage (receivable + payable), and the rev-rec method for the stream. Without a
maintained EAC the recognition is only as good as a stale estimate — so the WIP/EAC data
is a first-class onboarding domain, not an afterthought.

## 7. Acceptance criteria

- Choosing accrual + a %-completion method in onboarding makes the close auto-propose the
  recognition entry with no further user action.
- Every proposed entry is balanced (both revenue and 1180/2410 sides) and posts only on
  human approval.
- The unbilled receivable shows on the balance sheet and the AR aging, ties to GL 1180, and
  reclasses to 1100 on billing WITHOUT re-recognizing revenue.
- Recognition is idempotent per job+period and cannot double-post against a re-run.
- Exactly one recognition mechanism exists (the unified close step).
