# Discovery — The Full-Charge Bookkeeper / Daily Processor

**Author persona:** Full-charge bookkeeper, 15+ years. I do the daily processing across a
book of many entities — AP entry, AR/invoicing, bank and credit-card categorization, receipt
matching, payroll entry, reconciliations, month-end close. **I am the labor this system is
built to augment, then replace, then let me supervise.** This brief tells the engineering team
where my hours actually go, which steps are error-prone, where I lose time chasing people, and
what an *owned-ledger* AI should take over — with the human-in-the-loop checkpoint on each one
that keeps me in control instead of blindsided.

**Grounding (from `docs/canon/CANON-ANCHOR.md`):** MeritBooks OWNS the GL — it is the book of
record, not an automation skin over QuickBooks. The AI **proposes facts; a deterministic engine
does the debits/credits; a human approves. Auto-post is OFF by default** and autonomy is a
per-tenant, per-task dial. That is exactly the right shape for me to trust it. My job doesn't
disappear — it moves from *typing* to *approving and exception-handling*. Design for that.

---

## Part 1 — The hour-by-hour reality of the toil

This is a representative processing day across a multi-entity book. Times are where the hours
*actually* go, not where a job description says they go.

### 7:30–9:00 — Bank & credit-card feed (the single biggest time sink)
The feed dumped overnight. Every entity's checking, savings, and 3-5 credit cards. Hundreds of
lines. For each one I'm answering the same four questions:
- **Who is this?** "TST\* SQ \*BLUE MOON 4419" is a restaurant; "AMZN Mktp US\*2H4..." is Amazon,
  but is it office supplies, a tool, or a personal charge that shouldn't be here? The memo is
  cryptic and the same vendor shows up under six different descriptor strings.
- **What account?** Coding to the right GL account is the judgment. Is this Amazon charge
  supplies (6xxx OPEX) or a job material (COGS)? Is the Home Depot charge a repair or a
  capitalizable improvement? I get this wrong when I'm tired and it distorts the P&L.
- **Which entity / dimension?** On a shared card, one statement spans three entities. I'm
  splitting lines and tagging location/department/class.
- **Is it already in here?** Did I already enter this as a bill? Now the payment AND the bill
  are both hitting the books — double-count risk.

This is 60-90 minutes of near-identical, low-joy pattern-matching. It's also where most of my
month's errors are born, because it's high-volume and repetitive and my attention fades.

### 9:00–10:30 — AP: bill entry from email and PDFs
Invoices arrive as: PDF attachments, photos texted from a job site, portal logins, paper in a
folder. For each bill I hand-key: vendor, invoice number, invoice date, due date, amount, terms,
the GL account(s), and the entity/job. Then I check:
- **Is this a duplicate?** Same invoice re-sent "just following up" — if I don't catch it we pay
  twice. I catch duplicates by memory and by squinting at invoice numbers.
- **Is the vendor set up?** New vendor → I stop and create the vendor record. And now I need
  their **W-9** (or I can't 1099 them at year-end) and, for trades/subs, a **Certificate of
  Insurance** (COI) or we're carrying uninsured-sub liability. That kicks off a chase (below).
- **Does the math foot?** Line items vs. total, sales tax, freight.
- **Does it match a PO / the job budget?** For construction/trades, is this within the committed
  cost? Over-budget bills need a human flag before they post.

Hand-keying a bill is 2-4 minutes each and utterly mechanical. The data is *right there on the
PDF.* I am a very expensive OCR engine.

### 10:30–11:30 — Receipt & statement matching (the shoebox)
Owners and field staff hand me receipts — crumpled, photographed, emailed, or never at all. My
job is to match each receipt to the card charge already in the feed, so we have substantiation
for the deduction and can survive an audit. The reality:
- Half the receipts have no matching charge yet (pending), half the charges have no receipt.
- I'm matching on amount + date + vaguely-remembered vendor. "$47.13 on the 12th, was that the
  gas station or the parts counter?"
- **Missing receipts = the #1 thing I chase.** Every month I send the "I still need receipts for
  these 14 charges" email. Some never come. At audit or tax time this is the hole.

### 11:30–12:30 — AR / invoicing
Creating customer invoices: pulling the amounts (from a job, a contract, a rate card), applying
the right item/revenue account, emailing it, and — critically — remembering which ones are on
**deferred revenue / rev-rec** so I DON'T book revenue yet. Then logging any customer payments
that came in (check, ACH, card) and applying them to the right open invoice. Mis-applied
payments ("which of their 5 open invoices does this $9,000 cover?") create AR cleanup later.

### 1:00–2:00 — Payroll entry
Payroll runs in a payroll system; I enter the **journal** into the books: gross wages, the
employer taxes, the withholdings, the net, split across departments/jobs. It's the same entry
shape every run, but if I fat-finger the tax split or miss a department allocation the labor cost
on every job is wrong. Recurring, structured, error-prone — a perfect automation candidate.

### 2:00–3:30 — Chasing people (the invisible job)
This never appears on a task list but eats hours weekly:
- "Send me the W-9 before I can pay you." (new vendor)
- "Your COI expired 3/1 — I need a current one." (recurring sub)
- "What was this $2,300 Amex charge for?" (uncoded owner charge)
- "Which job does this material bill go to?" (missing dimension)
- "I need the receipt for the Delta flight." (substantiation)
- "Is this bill approved to pay?" (approval)
I send it, I wait, I re-send, I hold the transaction in limbo, I follow up next week. **The
work is blocked on someone else and I'm the one holding the bag for it being late.**

### 3:30–5:00 — Recurring entries, uncategorized cleanup, and the "ask my accountant" pile
- **Recurring journal entries:** rent, depreciation, amortization, prepaid insurance
  amortization, loan interest/principal splits, monthly accruals. Same entry, new month. I keep
  a checklist and re-key them. Miss one and the month is wrong.
- **Uncategorized bucket:** everything I couldn't confidently code got parked in "Ask My
  Accountant" / Uncategorized. Now I'm draining that swamp before close.
- **Loan payments:** splitting each payment into interest (expense) and principal (liability
  paydown) off an amortization schedule — mechanical and easy to get backwards.

### Month-end crunch (the 3-5 day marathon, multiplied by every entity)
1. **Reconcile every bank & credit-card account** to the statement — the non-negotiable control.
   Chasing the last few dollars of difference ("book says 14,203.11, statement says 14,251.86")
   can burn an hour per account hunting a transposed digit, a missed fee, a duplicate, or an
   uncleared check.
2. **Clear the uncategorized bucket** — can't close with unknowns sitting in it.
3. **Post all recurring/accrual entries** — depreciation, prepaids, accruals, deferred-revenue
   recognition for the period.
4. **Chase the stragglers** — the missing receipts, the un-approved bills, the W-9s, the "what
   was this" charges — all come due at once.
5. **Review the P&L and balance sheet for "does this look wrong"** — the gut-check that catches
   the miscoded thing before it goes to the owner.
6. **Lock the period.**

Month-end is stressful precisely because it's the sum of everything I *didn't* fully finish
during the month, now under a deadline, times N entities.

---

## Part 2 — Automation & micro-control points for an owned-ledger AI

The book of record owns the data, so the AI isn't scraping a foreign system — it sees the feed,
the vendors, the open bills, the receipts, the schedules. That's the unlock. For each item:
**the toil/error removed · time saved · trigger/data · the human-in-the-loop checkpoint** that
keeps me the supervisor. Auto-post stays OFF by default; every one of these produces a
*proposal I approve*, not a silent post.

### CORE-1 — Bank & credit-card feed auto-categorization  ★ COMMON-CORE
- **Removes:** the 7:30am pattern-matching grind; the biggest source of miscodes.
- **Saves:** 60-90 min/day; more across many entities.
- **Trigger/data:** new feed transactions (Plaid); learns from historical coding of the same
  vendor descriptor → GL account + dimension. Composite confidence (vendor/amount/date).
- **Human checkpoint:** transactions arrive **sorted lowest-confidence first** (the ones that
  need me), each with a confidence bar and the AI's reasoning. High-confidence items are
  **pre-coded but still queued for one-click approve / batch-approve**, never posted silently.
  Auto-approve only within a per-tenant dial (e.g. ≥ threshold, trusted vendor, under a dollar
  cap) — and even then it lands in a reviewable log I can reverse. I see everything; I approve
  the doubtful; the machine drafts the obvious. *This is the flagship trust-builder.*

### CORE-2 — Bill data entry from email/PDF (AP inbox)  ★ COMMON-CORE
- **Removes:** hand-keying vendor/inv#/date/due/amount/terms/GL off every PDF.
- **Saves:** 2-4 min/bill × dozens/day.
- **Trigger/data:** a bill hits a dedicated inbox or upload; OCR/extraction pulls the fields;
  vendor matched to the existing vendor record; GL/job suggested from that vendor's history.
- **Human checkpoint:** a **side-by-side review — extracted fields next to the source document
  image** — so I verify against the original in seconds instead of typing. I confirm the GL
  coding and the job/entity, then it becomes a draft bill pending approval-to-pay. The document
  stays attached as the audit trail.

### CORE-3 — Duplicate detection (bills AND payments)  ★ COMMON-CORE
- **Removes:** the double-pay risk and the "did I already enter this" squint; the bill-vs-feed
  double-count.
- **Saves:** the catastrophic errors, not minutes — this is a control, not a convenience.
- **Trigger/data:** on bill entry and on feed import, match vendor + invoice# + amount + date
  fuzzy; flag a bill whose payment already appears in the feed (and vice versa).
- **Human checkpoint:** a **blocking warning that shows me both records side by side** — "this
  looks like a duplicate of bill #4471 entered 4/12" — and makes me explicitly choose *merge /
  it's a duplicate, discard / no, they're genuinely different.* It never auto-deletes; it
  refuses to let a dupe slip past silently.

### CORE-4 — Vendor auto-create + W-9 / COI chase  ★ COMMON-CORE
- **Removes:** the stop-and-create-vendor interrupt AND the manual compliance chase that blocks
  payment and blows up at 1099 time / on uninsured-sub liability.
- **Saves:** the interrupt, plus the recurring "your COI expired" emails and the year-end 1099
  scramble.
- **Trigger/data:** a bill from an unknown vendor; missing/expired W-9 or COI on file; COI
  expiration date approaching.
- **Human checkpoint:** the AI drafts the vendor record and **auto-sends the W-9/COI request +
  reminders, but I approve the new vendor before it's real**, and compliance status is a visible
  badge (missing W-9 / COI expired → vendor flagged, payment gated). Escalations route to an
  exceptions queue I own. I decide to pay-anyway or hold; the system just makes sure I'm never
  surprised by a missing document. *Grounds directly on the Session-40 Vendor Compliance engine —
  reconcile to this workflow.*

### CORE-5 — Receipt-to-charge matching  ★ COMMON-CORE
- **Removes:** the shoebox reconciliation and the amount+date guessing game.
- **Saves:** ~1 hr/day of matching + the audit-time hole.
- **Trigger/data:** a receipt is uploaded/emailed/texted; match to an existing card charge on
  amount + date + vendor; surface unmatched on both sides.
- **Human checkpoint:** proposed matches presented for one-tap confirm; a **live "missing
  receipts" list per person** that the system nudges automatically, so the chase is the machine's
  job and I just watch the count go down. I confirm ambiguous matches; substantiation is attached
  to the charge for audit.

### CORE-6 — Recurring / accrual entries  ★ COMMON-CORE
- **Removes:** re-keying rent, depreciation, amortization, prepaid burn-down, accruals, and
  loan interest/principal splits every month.
- **Saves:** an afternoon a month; eliminates the "forgot one" miss.
- **Trigger/data:** a defined recurring template + schedule; loan amortization schedule for the
  interest/principal split; period rollover.
- **Human checkpoint:** at period open, the system **presents the month's recurring entries as a
  pre-drafted batch for me to review and release** — I can adjust an amount (variable accrual)
  before approving. Scheduled, but not silent: I release the batch.

### CORE-7 — Statement / bank reconciliation autopilot  ★ COMMON-CORE
- **Removes:** the per-account month-end reconcile grind and the hunt for the last few dollars.
- **Saves:** hours at close, per account, per entity.
- **Trigger/data:** statement import + cleared feed; composite matcher clears the obvious
  book-to-statement matches; isolates only the true exceptions (uncleared checks, missed fees,
  timing, a transposed digit).
- **Human checkpoint:** the AI clears the matched lines and **hands me only the unreconciled
  difference with its best explanation** ("likely bank fee not booked, $36.00"). I approve the
  reconciliation and the adjusting entries. The control — a human signs off the reconciliation —
  is preserved; the machine just does the 95% that's mechanical. *Grounds on the Session-40
  Reconciliation autopilot — reconcile to this checkpoint model.*

### CORE-8 — Uncategorized / "Ask My Accountant" cleanup  ★ COMMON-CORE
- **Removes:** draining the uncategorized swamp before close.
- **Saves:** the pre-close cleanup crunch.
- **Trigger/data:** items that failed confident coding accumulate; the AI re-proposes coding as
  it learns more context (a later receipt, a vendor pattern).
- **Human checkpoint:** a dedicated exceptions queue where each item carries a proposed code and
  a reason; I approve or redirect. Close is **gated on this queue being empty** — the system
  won't let the period lock with unknowns hiding in it.

### CORE-9 — Document collection & chase-orchestration  ★ COMMON-CORE (the "chasing people" killer)
- **Removes:** the invisible 2:00-3:30 job — every W-9/COI/receipt/approval/"what was this" ask.
- **Saves:** hours/week of drafting, waiting, re-sending, and holding transactions in limbo.
- **Trigger/data:** any transaction blocked on a missing document, approval, or answer.
- **Human checkpoint:** the AI **sends and auto-follows-up on the requests, and gives me a single
  "waiting on" board** showing who owes what and how long it's been outstanding. It drafts the
  ask in my voice; I can review before it goes or let trusted categories auto-send. I stay the
  supervisor of the relationship; the machine handles the nagging.

### CORE-10 — Payroll journal automation
- **Removes:** hand-entering the same structured payroll JE and its department/job splits.
- **Saves:** ~1 hr/run; kills the mis-split error that corrupts job labor cost.
- **Trigger/data:** payroll-run output (import/feed); a mapping of pay components → GL accounts
  and departments.
- **Human checkpoint:** the balanced JE is **pre-built and shown for approval** with the
  department/job allocation visible; I confirm before it posts. Structured and repeatable, so
  high-confidence — but still my sign-off, because a wrong split is expensive.

### CORE-11 — AR: invoicing + cash application
- **Removes:** manual invoice creation and the "which open invoice does this payment cover" AR
  cleanup.
- **Saves:** the invoicing block + downstream mis-application cleanup.
- **Trigger/data:** billable events/contracts for invoices; incoming payments (Stripe/ACH/check
  log) matched to open AR by customer + amount + reference.
- **Human checkpoint:** invoices drafted for review — and the system **respects rev-rec: a
  rev-rec-managed job credits Deferred Revenue, not Revenue, automatically**, removing the thing
  I most often forget. Proposed cash applications shown for confirm; partial/split payments
  flagged to me. *Grounds on Session-40 Stripe "Pay Now" — the highest-priority open gate.*

---

## Part 3 — What "keeps me in control" actually means (design principles)

1. **Draft, don't post.** Auto-post OFF by default is correct. Every automation produces a
   *proposal in a queue*, and I approve. That single fact is why I'll trust it.
2. **Show me the doubt.** Sort by lowest confidence, show the reasoning, show the source
   document. My attention goes to the exceptions; the obvious stuff I batch-approve.
3. **Reversible and logged.** Every AI action lands in a decision/audit log I can inspect and
   reverse. Nothing happens to the ledger that I can't see and undo.
4. **Gate the controls, automate the toil.** The machine does data entry, matching, chasing,
   drafting. The *controls* — reconciliation sign-off, approval-to-pay, period lock, duplicate
   confirmation, empty-uncategorized-before-close — stay human, by design.
5. **Dial autonomy up as trust is earned.** Per-tenant, per-task. Start me at "review
   everything," let me raise the auto-approve threshold on the categories the system has proven
   itself on (a trusted recurring vendor's utility bill), keep money-movement and new-vendor and
   over-budget always in front of a human.
6. **Segregation of duties applies to the AI too.** The AI that proposes is not the human that
   approves; the human that enters is not the one who releases the money. Don't let convenience
   collapse the preparer/approver split — it's the whole control.

**Net:** done right, my day flips from *typing 6 hours and approving 2* to *approving 2 hours
and supervising exceptions*. I don't feel replaced — I feel un-buried. That's the difference
between a tool I fight and a tool I defend to the owner.
