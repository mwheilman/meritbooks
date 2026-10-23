# FPB — Bank-feed & card-feed split transactions (Wave 1C)

Status: **DRAFT for owner approval** · Gap keys: BF-01 (P0), GL-01 (P0, bank/card part), BF-11 (card-line split) ·
Migration **177** · Governing: Posting Engine Spec Part G (override at review: "line splits"), Part E §6
(multi-line / multi-job / multi-dimension splits), canon §3 (balanced, period-locked, accounts by role).

## 1. Purpose
One bank or card line often pays for several things: a Verizon bill shared by two departments, a Home Depot
run for two jobs, a card charge where part belongs to a sister company. Today approving a feed line always
posts exactly two GL lines (`api/bank-feed/approve`), so every mixed purchase needs a manual journal entry.
This brief makes a split a first-class review action on the bank feed and the credit-card feed.

## 2. Persona
Bookkeeper / processor (cockpit density) working the feed queue; controller reviewing intercompany positions.

## 3. Benchmark (named deltas)
| | QBO | Xero | Intacct | **MeritBooks (this brief)** |
|---|---|---|---|---|
| Split a bank line across accounts | Yes | Yes | Yes | Yes |
| Split by % | No (amounts only) | No | Allocations (setup heavy) | **$ or % per split, live** |
| Per-line class/department/job | Class/location | Tracking cats | Dimensions | Dept, class, job + cost code |
| Cross-entity split with due-to/due-from | No | No | Yes (IC module) | **Yes, inline, both books balanced** |
| Remember split for a vendor | Bank rules (fixed %) | Bank rules | Allocations | **"Remember this split" + suggest from history** |
| Edit after posting | Silent edit | Silent edit | Reverse | **Reverse-and-re-post only (immutability, mig 153)** |

## 4. UI (what the owner sees)
- **Edit panel → "Split" button.** Opens the split grid in place of the single GL-account field.
- **Grid row** = one split line: amount **or** %, GL account (vendor recents first, then search), company,
  department, class, job + cost code (job columns only when the line's company has jobs), memo. Add / remove lines.
- **Remaining-to-allocate meter**: "Remaining $12.40 of $186.40" — turns to "Fully allocated" at $0.00.
  Save & Approve is disabled until remaining = $0.00 and every line is valid.
- **Mode toggle $ / %.** In % mode amounts are derived; rounding remainder lands on the last line.
- **Keyboard**: Enter / ↓ next line, ↑ previous line, Alt+N add line, Alt+Backspace remove line,
  Alt+R fill the remaining amount into the focused line. Esc still closes the panel.
- **Suggestion banner**: "Suggested split for Verizon — saved rule '60/40 HVAC/Plumbing'" or
  "…from your last split of this vendor" → one click **Apply**. Rule suggestions offer **Forget rule**.
- **"Remember this split for <vendor>"** checkbox → saves a % rule on approve.
- **Save split (draft)** keeps the split without posting; **Unsplit** returns to one line.
- **Feed table** shows a "Split · N lines" tag (and "· 2 companies" when cross-company) on draft and posted splits,
  on both /bank-feed and /credit-cards.
- **Posted line → "Reverse & edit"**: voids the posted entries (open/soft-closed period only) and returns the line
  to review with the split intact for editing.

## 5. Accounting behaviour (deterministic engine — AI never writes debits/credits)
Let the bank (or card) account belong to company **A**; amount `T` (absolute cents).
- **Same-company split** (all lines in A): ONE JE in A. Outflow: DR each line / CR bank-or-card `T`. Inflow mirrored.
- **Cross-company split** (some lines in B, C…): one JE **per company**, all linked by `source_module='BANK_FEED'`,
  `source_id=<bank txn>`.
  - Outflow, A: DR A's lines; DR **Intercompany Receivable** (role `INTERCOMPANY_AR`) Σ(B) with
    `counterparty_location_id=B`; CR cash/card `T`. B: DR B's lines / CR **Intercompany Payable** (role
    `INTERCOMPANY_AP`) Σ(B), counterparty A. (Same shape as `EXPENSE_ON_BEHALF` in `lib/services/intercompany.ts`.)
  - Inflow, A: DR cash `T`; CR A's lines; CR IC Payable Σ(B) cp B. B: DR IC Receivable Σ(B) cp A / CR B's lines.
  - Every JE balances on its own; due-to/due-from net to zero in consolidation and in EC-3.
- **Card lines** use the same path (cash side = the card's liability account on the bank_accounts row).
- **Job lines**: GL line carries `job_id`; a `job_cost_entries` row per job line (with cost code) and a CLEARED
  JOB_COST attribution per job line (gate BANKFEED_CATEGORIZATION), in that line's company.
- **Bill-settling lines** (`match_type=BILL_PAYMENT`) cannot be split (settlement clears AP, never re-expenses).

## 6. Data model (migration 177)
- `bank_transaction_splits` — one row per split line: `bank_transaction_id`, `line_no`, `status`
  (DRAFT/POSTED), `amount_cents` (>0), `percent_bp` (basis points, optional), `account_id`,
  `allocation_location_id` (the company the line books to), `department_id`, `class_id`, `job_id`,
  `cost_code_id`, `memo`, `posting_version`, `gl_entry_id`, `gl_entry_line_id`, `split_rule_id`.
  `location_id` = the transaction's company (owning client for client-scope RLS).
- `split_rules` — vendor and/or description pattern → `allocations` jsonb of `{percent_bp, account_id,
  allocation_location_id, department_id?, class_id?, job_id?, cost_code_id?, memo?}`; one active rule per
  vendor per company; `times_applied`, `last_applied_at`.
- Both: RLS org isolation + client scope; members SELECT only; writes via service role after permission check,
  org pin, client-scope assert (business-write-lock pattern). POSTED split rows cannot be deleted.

## 7. Validation / gates
- Permission `bank_feed:approve` to post / reverse; `bank_feed:edit` to save a draft split or a rule.
- Σ line amounts = `T` exactly (integer cents), each line > 0, 1–50 lines; % mode Σ = 100.00%.
- Every referenced id (account, company, department, class, job, cost code) belongs to the org; the account is
  org-wide or owned by the line's company; job and department belong to the line's company; caller has client
  scope on every company the split books to.
- COGS line requires a job when the line's company has jobs. Company `require_department/require_class`
  and the DB `validate_dimensions` trigger apply per line.
- Period lock per company (`postJournalEntry` + `enforce_period_lock`): a hard-closed period in ANY company
  rejects the whole split; nothing is left half-posted (already-posted legs are voided).
- Idempotency: each posting stamps `source_ref = bankfeed:<txn>:v<n>[:<company>]`; the partial unique index
  `uq_gl_entries_org_source_type` (mig 064) makes a concurrent second approve fail without posting.

## 8. Acceptance criteria (testable)
1. AC-1 `% 33.33/33.33/33.34` of $100.00 allocates 3333/3333/3334 cents; `1/3 each of $0.10` → 3/3/4 (remainder to last).
2. AC-2 A 3-line same-company split posts ONE balanced JE with 4 lines (3 DR + 1 CR cash) carrying per-line dims.
3. AC-3 A cross-company outflow split posts 2 JEs; A: DR own + DR IC-AR (cp B) = CR cash; B: DR lines = CR IC-AP (cp A);
   each JE balances; IC-AR(A) = IC-AP(B).
4. AC-4 Cross-company inflow split mirrors AC-3 (A: DR cash = CR own + CR IC-AP; B: DR IC-AR = CR lines).
5. AC-5 Sum ≠ total, a zero line, or a foreign/company-mismatched account is rejected before any GL write.
6. AC-6 A hard-closed period in the second company rejects the split and leaves no POSTED BANK_FEED entry.
7. AC-7 A second approve of the same posting version fails on the unique source_ref and posts nothing new.
8. AC-8 Applying a 60/40 rule to $123.45 yields 7407/4938; rule matching prefers vendor+company over vendor-only
   over description pattern.
9. AC-9 Reverse voids every POSTED BANK_FEED entry for the txn, returns it to CATEGORIZED with the split as DRAFT
   (version +1), and a re-approve posts a fresh balanced set.
10. AC-10 Existing two-line approve, bill-payment settlement and batch approve keep working unchanged.

## 9. Deferred (named)
- Receipt-line splits and the one shared split component on bills/expense reports (GL-01 remainder) — the grid is
  built as a reusable component (`split-grid.tsx`) so those can adopt it.
- Split-rule management screen (rules are created from the panel and can be forgotten there).
- An `intercompany_transactions` parent row for split-created IC pairs — deliberately not created: voiding it from
  /intercompany would void the whole bank-feed JE. Pairs are linked by source and tagged by counterparty, which is
  what consolidation and EC-3 read.
