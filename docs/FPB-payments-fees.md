# Feature Product Brief — Payments & Processing Fees

**Status:** Draft for Mike's sign-off (Rule 13)
**Module:** Payment processing fees — the two-layer marketplace fee model
**Author:** Session 38
**Supersedes:** the hardcoded `CARD_PCT = 0.03` / `ACH_PCT = 0.01` constants in `api/pay/[token]/intent/route.ts` and the "ACH = 1% uncapped" rule locked in the Session 37 handoff.

---

## 0. The one-paragraph version

MeritBooks is a payment-processing marketplace. When one of a merchant's customers pays an invoice electronically, **MeritBooks charges the merchant a fee for the service, collected at the moment of payment** via a Stripe destination-charge application fee that routes to MeritBooks' own account. There are two independent decisions, made by two different people:

- **Layer 1 — what MeritBooks charges the merchant.** Set by Mike (the MeritBooks administrator) per merchant, during onboarding. This is MeritBooks' revenue.
- **Layer 2 — whether the merchant passes that fee to their own customer.** Set by the merchant, at the customer level, overridable per invoice. This decides who ultimately bears the Layer-1 fee.

Everything below specifies those two layers as a data model, a set of screens, GL postings, and acceptance criteria. Today, Layer 1 does not exist (rates are hardcoded and identical for every merchant) and Layer 2 exists for card only.

---

## 1. Job & user

**Two users, two jobs.**

- **Mike, MeritBooks admin.** Onboarding a new merchant, he sets the price MeritBooks charges that merchant for payment processing — e.g. "ACH 1% capped at $10, card 3%." He needs this to be per-merchant (different merchants may get different pricing), auditable (when did it change, who changed it), and to take effect on the next payment without a redeploy. Today he has no screen for this; the rate is a constant in the code, the same for everyone.

- **The merchant** (e.g. a controller at Northwind Construction, a MeritBooks tenant). Setting up their own customers, they decide whether a given customer gets surcharged for paying by card or ACH, or whether Northwind eats the fee. They can set a default per customer and override it on a single invoice. Today they can do this for card (via `card_surcharge_enabled`) but not ACH, and the UI label ("No fee") doesn't explain what's happening.

**What they use today:** Stripe Billing (which bakes the platform into Stripe and gives no per-merchant control), or QuickBooks Payments (fixed rates, merchant absorbs or passes a flat convenience fee). Neither lets a *platform operator* set per-merchant pricing while letting the *merchant* set per-customer pass-through. That two-sided control is the differentiator.

**Two onboarding wizards, two audiences.** The admin's merchant-provisioning wizard (Mike sets up and prices a new merchant) is a different flow from the merchant's own setup wizard (the merchant configures their books and their customer-facing pass-through defaults). Layer 1 lives in the first; Layer 2 lives in the second. See §3.

## 2. Data captured

**New — Layer 1: the merchant fee schedule (MeritBooks → merchant).** A new table, `core.merchant_fee_schedules`, one active row per org, versioned for history:

- `org_id` — the merchant
- `ach_fee_bps` — MeritBooks' ACH fee in basis points (e.g. 100 = 1.00%)
- `ach_fee_cap_cents` — nullable; null = uncapped, else the max fee (e.g. 1000 = $10)
- `ach_fee_min_cents` — nullable floor
- `card_fee_bps` — MeritBooks' card fee (e.g. 300 = 3.00%)
- `card_fee_cap_cents` / `card_fee_min_cents` — nullable
- `effective_from` / `effective_to` — for versioned history; the active row is the one covering "now"
- `set_by` — the admin user id (audit)
- `created_at`

This is deliberately basis-points + integer-cent caps, never floats, consistent with the money rules. Percentages are a display convenience; storage is bps.

**Existing — Layer 2: the pass-through posture.** Already on the cascade (`resolve-payment-methods.ts`): `card_surcharge_enabled` at entity / customer / job / invoice. Extend to ACH: add `ach_surcharge_enabled` at the same four levels. Both are tri-state (true = pass to customer, false = merchant absorbs, null = inherit).

**Reference — Stripe's actual cost (not stored as config; read from the charge).** Stripe's real processing cost — ACH 0.8% capped at $5, card ~2.9% + 30¢ — is retrieved from the charge's balance transaction at settlement (`getChargeProcessingFeeCents`, already built). It is MeritBooks' *expense*. It is never a merchant-facing number.

## 3. Presentation & document output

**There are two distinct onboarding wizards, and the fee controls split across them:**

- **Wizard A — Admin provisions a merchant (Mike → new merchant).** This is the MeritBooks-operator flow: Mike adds a new merchant, and part of that is *pricing them* — setting the Layer-1 fee schedule for that merchant. Emailed/launched by Mike when signing a new customer. Fee UI here: a "Processing fees" step. Two rows — ACH and Card — each a percentage field and an optional cap. Defaults prefilled (ACH 1% / $10 cap, card 3% / no cap). Live example: "On a $10,000 ACH payment, MeritBooks charges this merchant $10." MeritBooks' own cost shown beneath ("Stripe's cost to you: ~$5; your margin: ~$5") so Mike prices with eyes open. **A merchant never sees this step.**

- **Wizard B — Merchant onboards themselves (the merchant → their own MeritBooks setup).** This is the tenant setup wizard that already exists (`app/setup`). The merchant configures *their* books, customers, connections. Fee UI here is Layer-2 only: their *default* pass-through posture — "when a customer pays by card, do we pass the fee on or absorb it?" and the same for ACH. They set the org-level default; per-customer and per-invoice overrides happen later in normal use. **The merchant cannot change what MeritBooks charges them — that number is set in Wizard A and shown read-only, if at all.**

The two wizards are the concrete reason Layer 1 and Layer 2 must be permission-separated (§12): they are literally different screens seen by different people.
- **Merchant settings (Layer 2):** on the customer form and the invoice drawer, a clear control: "Card processing fee → [Pass to customer / We absorb it]" and the same for ACH. Replaces the ambiguous "No fee" badge.
- **Customer-facing pay page:** the badge becomes accurate to the payer. Card pass-through → "+3% card fee" with the surcharge shown before confirm (as today). Absorbed or ACH → "No added fee" (not "No fee" — the payer isn't surcharged, but we don't imply the transaction is costless). The exact copy is a Layer-2 display concern, specified in §5 of the UX notes, not a fee-math concern.

## 4. States

Empty (no fee schedule yet → fall back to platform defaults, flagged to admin as "using defaults"), configured, mid-payment, provider-not-connected (no Pay button, remit-to shown — already built), and the merchant-has-no-Stripe-account case. First-run: a merchant with no schedule must still be able to take payments on the platform default, so absence degrades gracefully rather than blocking.

## 5. Lifecycle & status model

The fee schedule is versioned: setting a new schedule closes the current row's `effective_to` and opens a new one. Every payment records, in its metadata and the GL memo, **which schedule version priced it** — so a payment is always explainable against the rate in force when it happened, even after the rate later changes. Events: `FEE_SCHEDULE_SET` (admin), and the existing `PAY_INITIATED` / `PAY_PROCESSING` / `PAY_SUCCEEDED` carry the resolved fee amounts.

## 6. Actions & options

- Admin: set / update a merchant's fee schedule; view history; see the margin preview.
- Merchant: set ACH and card pass-through defaults per customer; override per invoice.
- Customer: choose method; see the surcharge (if any) before confirming.

## 7. Edit & correction model

Fee schedules are never edited in place — a change writes a new version. A payment already taken is immutable; its fee was set at charge time. If a payment is refunded, the fee treatment on refund is specified in §11 (GL). The pass-through toggles are freely editable on draft invoices and cascade-resolved at charge time for sent ones.

## 8. Delivery & sharing

No new delivery surface. The resolved fee appears on the hosted pay page and on the invoice PDF where a surcharge applies (so the customer's copy shows the line).

## 9. Automation

The fee is computed automatically at charge time from (a) the merchant's active fee schedule [Layer 1] and (b) the resolved pass-through posture [Layer 2]. No manual entry. Cap and floor applied automatically.

## 10. Analytics & insight

Platform view (Mike): processing revenue by merchant, margin (revenue − Stripe cost) by merchant and method, effective take rate. Merchant view: fees paid to MeritBooks this period, split ACH vs card, and how much they passed through vs absorbed. These are downstream reports; the FPB's job is to make sure the data is captured to support them (it is, via the GL postings in §11).

## 11. Integration & GL — the money flow

For one electronic payment of base `B`:

**Layer 1 (what MeritBooks charges the merchant) = the Stripe `application_fee_amount`.** Computed from the merchant's schedule: `min(cap, max(floor, B × bps/10000))`.

**Layer 2 (who bears it):**
- **Pass-through:** customer is charged `B + fee`; `application_fee = fee`; **merchant nets the full `B`**. On the merchant's books there is *no* fee expense — the customer paid it.
- **Absorbed:** customer is charged `B`; `application_fee = fee`; **merchant nets `B − fee`**. On the merchant's books, DR Merchant Fee Expense `fee`, and settlement clearing is `B − fee`.

**On the merchant's ledger (AR collection, existing `buildArCollectionEntry`):**
`feeCents` = the amount the merchant did *not* net = `B − (amountCharged − applicationFee)`. This is already the shipped formula (`deriveTenantFeeCents`); it stays correct — it yields the fee for absorbed, and 0 for pass-through, automatically. What changes is only *how `applicationFee` is computed* (schedule-driven, capped), not how it posts.

**On MeritBooks' ledger (platform fee income, existing `buildPlatformFeeEntry`):**
DR Payments in Transit `(applicationFee − stripeCost)`, DR Merchant/Processing Cost `stripeCost`, CR Payment Processing Income 4910 `applicationFee`. Stripe cost read from the balance transaction. **Margin = applicationFee − stripeCost.** Already modelled; unchanged except that `applicationFee` is now schedule-driven.

**Net:** the GL builders do not change. Only the fee *derivation* moves from two hardcoded constants to the two-layer resolution. This is the key architectural point — the posting layer is already correct; the pricing input to it is what's missing.

**Refunds:** on a full refund, the application fee is refunded to the merchant (Stripe `refund_application_fee=true`) and the platform income reverses; Stripe's cost is generally not returned. Exact treatment TBD in build, flagged here as a decision.

## 12. Permissions / RBAC

- **Layer 1 (fee schedule)** is a MeritBooks-**platform-admin** action — only the operator (Mike) sets what merchants are charged. A merchant must never see or set their own Layer-1 rate. This needs the platform-admin role, which ties into the tenant-isolation/identity work (task #9) — until real roles exist, Layer 1 is gated to the platform org only, matching how `PLATFORM_ORG_ID` already gates platform-fee posting.
- **Layer 2 (pass-through)** is a merchant action — any merchant user with invoice-edit rights.

The two-layer permission split is the reason this brief must not ship before the isolation model is at least stubbed: Layer 1 config leaking to merchants would let a customer set their own price.

## 13. Comparative benchmark (Rule 14)

- **Stripe Billing / Connect:** platform sets application fees via API only — no admin UI, no per-merchant schedule, no merchant-facing pass-through control. MeritBooks must match the fee mechanics (it does, via destination charges) and **beat** it with a UI: Mike sets per-merchant pricing in the onboarding wizard, no code.
- **QuickBooks Payments:** fixed rates, merchant absorbs or passes a flat convenience fee; no platform layer at all (QBO *is* the processor). MeritBooks **beats** it by being the platform — Mike captures the margin QBO keeps.
- **Bill.com:** flat per-transaction ACH fee, no pass-through choice. MeritBooks **beats** it with the two-layer control and true percentage+cap pricing.

The defensible deltas: (1) a platform-admin pricing screen instead of an API, (2) per-merchant schedules with versioned history, (3) merchant-controlled pass-through at customer and invoice granularity, (4) both layers posting cleanly to a real double-entry GL with margin visible.

## 14. Edge cases & safeguards

- Fee cap on a large payment (the $150K ACH → $10, not $1,500). The current tests assert the *uncapped* $1,500 — they must be rewritten; this is the single biggest correctness change.
- Rounding: bps math rounds to the cent; assert sum-of-parts equals the charge exactly (no lost penny).
- A merchant with no schedule → platform default, never a crash and never $0 fee by accident.
- Pass-through on a $0 or credit invoice → no negative fee, no surcharge.
- Cap smaller than floor (misconfiguration) → rejected at schedule-save with a clear error.
- Refund fee treatment (above) must not double-reverse platform income.
- Stripe cost temporarily unavailable at settlement → fall back to gross-only platform posting (already handled) and reconcile when the balance transaction lands.

## 15. Out of scope (this brief)

- Multi-currency fees (the currency seam exists but is inert).
- Dwolla ACH as an alternate processor (registry supports it; pricing model here is Stripe-first).
- Per-method *tiered* pricing (volume discounts) — schedule is flat percentage + cap for v1.
- Interchange-plus / Finix pivot (only at ~$10M+/yr volume, per prior handoffs).

## 16. Acceptance criteria (these define "done," not "it renders")

1. A `core.merchant_fee_schedules` table exists, versioned, integer-cent + bps, with an active-row constraint per org.
2. The onboarding wizard has a Processing Fees step that writes a schedule and shows the margin preview; editing writes a new version, never mutates.
3. The intent route computes `applicationFee` from the merchant's active schedule with cap/floor applied — the two hardcoded constants are gone.
4. ACH pass-through exists and cascades entity → customer → invoice, symmetric with card.
5. On a $150,000 ACH payment with "1% cap $10," the merchant is charged **$10**: AR collection books merchant fee expense $10 (absorbed) or $0 (pass-through), settlement clearing `B − fee`, and it balances to the cent.
6. Platform income posts `applicationFee` to 4910, Stripe cost as processing expense, remainder to Payments in Transit; margin = the difference; balances.
7. Replaying a payment is still idempotent; the fee is not double-charged.
8. The customer-facing badge is accurate: "+3% card fee" on pass-through, "No added fee" otherwise.
9. Layer 1 is gated to the platform admin; a merchant user cannot read or write a fee schedule.
10. The GL/fee test suite is rewritten to assert schedule-driven, capped amounts, and all pass; schema-contract and tenant-isolation ratchets stay green.

---

## Decisions — RESOLVED (Session 38, Mike)

1. **ACH fee to the merchant — CONFIGURABLE PER MERCHANT.** The admin chooses at setup, as a negotiable deal point: a percentage (default 1%) and an **optional** cap — "1% capped at $X" *or* "1% no cap," per merchant. The cap is nullable in the schema; both are first-class. This is why the build is per-merchant, not global.
2. **Card fee to the merchant:** default **3%**, adjustable per merchant, optional cap. Same configurable mechanism as ACH.
3. **Default pass-through posture (Layer 2, merchant side):** **ACH → absorbed** by the merchant; **card → passed through** to the customer at 3%. Merchants override per customer and per invoice.
4. **Build scope: per-merchant schedule now.** A single global rate cannot express "negotiable per merchant," so decision #1 requires the per-merchant `core.merchant_fee_schedules` table and the Wizard-A pricing step from the start. No global-first shortcut.

## Still open (can resolve during build, not blocking)

- **Refund fee treatment:** on refund, does the merchant get the MeritBooks fee back? Recommend: yes for full refunds, no for partials (standard). Confirm during the refund-path build.
