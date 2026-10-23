# FPB — Check processing: print, register, void, positive pay (Wave 2C)

Status: **DRAFT for owner approval** · Gap keys: CK-01 (P0), CK-03 (P0), CK-04 (P0), CK-05 (P0), CK-06 (P0),
CK-07 (P1); CK-02 (mail provider) is an adapter only, behind the owner's decision ·
Migration **182** · Governing: canon §3 (settlement clears AP, never re-expenses; period locks; money SoD reconciles
to core identity), migrations 042/170/174 (approvals state machine + approver-release threshold), 152/153 (period lock,
posted-GL immutability), 167 (field masks), 171 (business write locks), 163 (client scope).

## 1. Purpose
Today `/checks` runs a 5-step pay run (queue → approve → review → export → release). Release posts DR A/P / CR Cash.
For checks the human then hand-writes a check and types its number (`disbursement_check_numbers`, a reference only).
There is no printing, no MICR line, no check-number sequence, no register, no void, and the "positive pay" CSV has
no check or account number. This brief makes MeritBooks a real check processor: released check payments print on
blank check stock with a MICR line, numbers come from a per-account sequence with no gaps or duplicates, every check
lives in a register until it clears, a void reverses the payment and reopens the bill, and the bank gets a
positive-pay issue file in its format.

The owner has **not** decided between in-house printing and a print-and-mail service. In-house printing is built in
full; mailing is a provider-agnostic adapter with no provider wired (the UI shows "Not configured").

## 2. Persona
- **Check processor / AP clerk** (`payments_clerk`, cockpit density) — prints, spoils, reprints, marks mailed.
- **Controller / owner** — releases, voids, owns check stock settings (MICR numbers, signatures), sends positive pay.
- **Auditor** — reads the register, gaps report, void trail.

## 3. Benchmark (named deltas)
| | QBO | Sage Intacct | Bill.com | **MeritBooks (this brief)** |
|---|---|---|---|---|
| Print on blank stock with MICR | Pre-printed stock only | Yes (add-on) | Mails for you | **Yes, blank stock, MICR E-13B line, per-account layout** |
| Voucher layouts | Voucher / standard / wallet | Several | n/a | **Check on top / middle / bottom + 3-per-page** |
| Alignment test | Yes | Yes | n/a | **Yes, with x/y nudge saved per account** |
| Second signature over $X | No | Yes | Approval rule | **Yes, image or blank line + "Two signatures required"** |
| Number sequence per account | Per account, editable, gaps possible | Yes | n/a | **Atomic DB allocation — no gaps, no duplicates; jumps are logged** |
| Spoil / reprint | Reprint reuses number or next | Yes | n/a | **Reprint always spoils the old number (audit-visible)** |
| Void reverses payment + reopens bill | Yes (same-period edit) | Yes | Yes | **Yes; closed period → reversing entry in the open period** |
| Register with cleared/stale | Reconcile screen only | Yes | Partial | **Register: printed/issued/mailed/cleared/void/spoiled + stale > N days, gap check** |
| Auto-clear from bank feed | Match on reconcile | Yes | n/a | **Bank line with the check number + exact amount clears it automatically** |
| Positive pay file | No | Yes | Bank-side | **Generic CSV + two fixed-width layouts + custom mapping, incl. voids, "since last file"** |
| SoD on printing | No | Role-based | Approvals | **Printer ≠ preparer; approver only within the tenant's release threshold** |

## 4. UI (what the owner sees) — `/checks`, merit-ui v2.3, `density-cockpit`
Tabs: **Print checks** (home) · **Register** · **Positive pay** · **Check stock** · **Pay run** (the existing 5-step run).

**4.1 Print checks (home)**
- Bank-account picker (company-scoped). Header figure: "**N checks ready to print · $X**" (released CHECK payments,
  grouped one check per vendor unless the account prints one check per bill).
- Ready list: payee, bills on the check, amount, released by, release date. Select all / some (keyboard: x toggles,
  shift+a selects all). Rows the current user may not print (SoD) are shown with the reason and cannot be selected.
- "Next check number: 1043 · will print 1043–1050" (live from the sequence). Check date (default today).
- **Print alignment test** → PDF on plain paper: field boxes, crosshairs, a ruler, MICR clear band, "ALIGNMENT TEST —
  NOT A CHECK". Consumes no number.
- **Print N checks** → confirmation ("This uses check numbers 1043–1050 on Operating ••4821. Load blank stock, check
  side up.") → PDF opens in a new tab. Numbers are consumed at that moment; every check is PRINTED.
- If the account has no MICR numbers or no signature yet, a notice links to **Check stock**; printing is refused
  without routing + account numbers.
- **Mail with a service** button, disabled, with "Not configured — your administrator hasn't chosen a mail service."

**4.2 Register**
- Per bank account; filters: status (all / outstanding / cleared / void / spoiled / stale), date range, search payee or
  number; paginated 50/page; sortable by number, date, amount.
- Columns: number, date, payee, amount, status pill (Printed · Issued · Mailed · Cleared · Voided · Spoiled, plus a
  **Stale** flag when outstanding longer than the account's stale threshold, default 180 days), bills paid, cleared
  date/bank line, printed by.
- Summary strip: outstanding count + $ (feeds bank reconciliation's "outstanding checks"), cleared this month,
  stale count, **gap check** ("No gaps in 1001–1050" or "Missing: 1017, 1018").
- Row actions: **Mark mailed / handed out**, **Void** (reason required), **Spoil** (printed, never issued), **Reprint**
  (= spoil + returns the payments to Ready). **Export CSV** of the filtered register. **Match cleared checks** button
  runs the bank-feed matcher now.

**4.3 Positive pay**
- Per bank account: format (from the account's setting), "Since last file" (default) or a date range; preview count of
  issues and voids and totals; **Download file**. History table of previous files (who, when, counts, totals).

**4.4 Check stock** (per bank account)
- Layout (check on top / middle / bottom, 3 per page), printer nudge x/y (points, ±72), payer name + address, logo
  URL (tenant branding), bank name, bank address, fraction code, routing number + account number (entered once,
  shown masked ••4821 afterwards; replacing them is logged), signature image upload (PNG/JPEG ≤ 512 KB, private
  storage, never shown back — only "Signature on file, uploaded Oct 23 by …"), optional second signature + threshold,
  "Void after N days" printed text (default 90), stale threshold (default 180), one check per bill toggle, positive-pay
  format + custom column mapping, next check number (can only move forward; the jump is logged as a declared skip).

## 5. Accounting behaviour (deterministic engine)
- **Printing posts nothing.** The GL entry already exists: release posted DR A/P / CR Cash (the bank account's GL
  account) for each bill. A check bundles one or more of those released `bill_payments`.
- **Spoil** (PRINTED only): consumes the number, no GL effect, the payments go back to Ready.
- **Void** (PRINTED / ISSUED / MAILED; refused once CLEARED):
  for every payment on the check, if the payment JE's period is **OPEN** the JE is voided in place (status VOIDED, drops
  out of every POSTED-only report); otherwise (SOFT_CLOSE / HARD_CLOSE) a **reversing entry** (entry_type REVERSING,
  DR Cash / CR A/P, same accounts and dimensions, `source_ref = check_void:<bill_payment_id>`) posts on the void date in
  its open period. The bill_payment becomes VOIDED; the bill's paid amount is recomputed from its remaining POSTED
  payments (status back to APPROVED or PARTIALLY_PAID, `paid_at` cleared); the pay-run approval moves RELEASED →
  RETURNED so the bill can be queued again. If the void date's period is hard-closed or missing, nothing changes.
  Every step is idempotent (retry continues where it stopped).
- **Clear**: a bank-feed outflow on the same bank account whose check number (column or description, e.g. "CHECK
  1043") and amount match exactly marks the check CLEARED, links the bank line to the existing payment
  (`match_type = BILL_PAYMENT`, `gl_entry_id` = the payment JE, so the feed never posts it again), and moves the
  approvals RELEASED → SETTLED. A bank line that was already posted elsewhere is linked but flagged
  "posted separately — check for a double entry".

## 6. Data model (migration 182)
- `bank_check_sequences` — per bank account `next_number` (1–99,999,999). Only changed by the DB functions.
- `check_sequence_events` — declared jumps (from, to, reason, actor) — the gap check ignores declared skips.
- `check_stock_profiles` — per bank account layout, nudge, payer/bank blocks, `routing_mask`/`account_mask` (last 4),
  `micr_secret_ref` (Vault pointer to the full numbers; column revoked from members), signature storage paths (column
  revoked), second-signature threshold, void/stale days, positive-pay format + mapping.
- `check_print_runs` — one row per print (CHECKS or ALIGNMENT): count, total, first/last number, layout, printer.
- `ap_checks` — the register row: number (unique per bank account), date, payee snapshot, amount, status, print run,
  issued/mailed/cleared/void fields, reversal mode + entry ids, reprint chain, positive-pay export links.
- `ap_check_payments` — check ↔ `bill_payments` (+ approval, bill, amount); a payment is on at most one current check
  (partial unique index).
- `positive_pay_exports` — file history.
- Private Storage bucket `check-signatures` (service role only — no member object policies).
- `approvals` uniqueness becomes "one OPEN approval per bill" (REJECTED / RETURNED no longer block re-queuing).
- Functions (service_role only, M1): `issue_check_print_run` (atomic allocate + insert + SoD), `set_check_sequence`.
- Guard trigger on `ap_checks`: legal status transitions only; number / account / amount / payee / date immutable;
  no deletes (purge GUC and cascades excepted).
- All tables: RLS on, member SELECT only (+ client scope), writes through the service role after the route's permission
  check, org pin and client-scope assert (`lib/db/scoped-writer.ts`).

## 7. Validation & gates
- Permissions: view = `checks:view`; print / spoil / void / mark mailed / positive pay / check-stock changes =
  money-movement release authority (`ap_disbursement_release:run`, degrading to `payments:run`, then
  `checks:create`). Print, void, positive pay and check-stock changes also run `assertSessionMeetsPolicy` (MFA/step-up).
- **SoD (print)**: the printer is treated as the releaser of the paper instrument — never the payment's preparer; the
  approver only when the tenant allows the approver to release (any amount / up to the 174 threshold). Enforced in the
  app (per row) and again in `issue_check_print_run`.
- A check needs ≥ 1 released, POSTED, CHECK-method payment drawn on that bank account's GL account; all payments on a
  check have the same vendor; the check amount = Σ payments; amount ≤ $99,999,999.99 and ≤ the account's optional max.
- The client's "expected first number" must equal the sequence (stale screen → 409 "numbers changed").
- MICR: routing number 9 digits with a valid ABA checksum; account 4–17 digits; check number ≤ 8 digits.
- Void: reason ≥ 3 chars; void date ≥ check date and not in the future; refused when CLEARED or terminal.
- Positive pay reveals the full account number → written to `core.field_reveals` before the file is returned.

## 8. MICR line (ANSI X9.13 positions, counted from the right edge)
`⑈<check#>⑈ ⑆<routing>⑆ <account>⑈` — on-us symbol at position 14 with the account to its left (positions 14–32),
transit field positions 33–43 (⑆ at 43 and 33, routing digits 42–34), a blank at 44, auxiliary on-us (check number,
zero-padded to the account's digit count, default 6) ending at position 45. Position 1 starts 5/16" from the right edge;
pitch 0.125" (8 cpi); baseline 3/16" from the check's bottom edge, inside the 5/8" clear band. Amount field (1–12) is
left blank for the bank of first deposit.

**Font**: no OFL-licensed E-13B TrueType exists. The built-in renderer draws E-13B glyphs as vector shapes authored in
this repo on the standard's 0.013" grid (no third-party font, no licence). These shapes are an approximation and are
**not** certified for magnetic read: production printing must (a) use MICR toner, and (b) either drop a licensed E-13B
TTF at `apps/web/src/lib/ap/check-print/fonts/micr-e13b.ttf` (auto-detected) or pass the bank's MICR test with the
built-in glyphs. The Check stock screen states this.

## 9. Acceptance criteria (testable)
- **AC-1** 20 concurrent `issue_check_print_run` calls on one account return 20 distinct, consecutive numbers with no
  gap; a duplicate number is impossible (unique index); a stale expected-first is refused.
- **AC-2** `amountToWords`: 0.05 → "Zero and 05/100"; 1,234.56 → "One Thousand Two Hundred Thirty-Four and 56/100";
  1,000,000.00 → "One Million and 00/100"; 99,999,999.99 handled; negative / zero refused.
- **AC-3** Protective numeric amount `**1,234.56` padded with asterisks to a fixed width.
- **AC-4** MICR composition puts ⑈check#⑈, ⑆routing⑆ and account⑈ at the X9.13 positions; invalid routing checksum,
  short/long account, over-long check number are refused.
- **AC-5** Printing a selection creates PRINTED checks (one per vendor), links the payments, advances the sequence and
  writes a print run; a payment can't be printed twice while its check is current.
- **AC-6** SoD: the preparer can never print; the approver can't print unless the tenant allows it (and within the
  threshold); the DB function refuses too.
- **AC-7** Spoil: number consumed, payments return to Ready, reprint gets a new number and points to the spoiled check.
- **AC-8** Void in an OPEN period: payment JE VOIDED, bill balance restored, approval RETURNED, check VOIDED, cash and
  A/P balances return to their pre-payment values.
- **AC-9** Void after the payment's period is closed: original JE untouched, a balanced REVERSING entry posts in the
  void date's open period; a hard-closed void date refuses with nothing changed; a retry never double-reverses.
- **AC-10** A cleared check cannot be voided.
- **AC-11** Positive pay: generic CSV and both fixed-width layouts contain account number, check number, amount, issue
  date, payee and the void indicator; "since last file" includes only new issues and new voids; a custom mapping
  re-orders / renames columns; fixed-width records have exact lengths.
- **AC-12** Auto-clear: a bank line "CHECK 1043" for −$amount on the account marks #1043 CLEARED and links the line to
  the payment; a wrong amount or another account does not.
- **AC-13** Register derives "stale" past the threshold and lists gaps minus declared skips.
- **AC-14** Tables are RLS-on, member read-only; `micr_secret_ref` and signature paths are not member-selectable;
  `ap_checks` refuses illegal transitions, number/amount edits and deletes.
- **AC-15** Mail adapter: the default provider reports not configured and refuses to send.

## 10. Out of scope / follow-ups
- A wired print-and-mail provider (CK-02) — owner decision (Lob / Checkbook / PostGrid…); adapter is ready.
- Positive-pay exception adjudication (bank-reported exceptions) and direct bank upload (SFTP/API).
- Stop-payment requests to the bank; escheat (unclaimed property) workflow for stale checks — the register flags them.
- Wiring the clearing matcher into the nightly bank sync (scheduler registry is owned by slice 2E —
  `runCheckClearingJob` is exported for it).
