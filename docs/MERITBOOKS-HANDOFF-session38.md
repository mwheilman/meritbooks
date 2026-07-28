# MERITBOOKS — SESSION 38 HANDOFF

**Session theme:** The Stripe payment chain was driven to **green for the first time** — a real card payment flipped an invoice to PAID and posted a balanced `AR_COLLECTION` journal entry ($97 net / $3 fee / $100 A/R credit). Getting there uncovered and fixed two latent DB breaks that had made the entire GATE-12 money-movement posting layer un-runnable. Then: the **two-layer fee model** replaced the hardcoded 1%/3% constants with per-merchant schedules; a real **test harness** (Vitest on PGlite) landed and became the enforcement backbone; **seven subagents** were defined; and a **security pass** shut an auth-bypass, added an RBAC guard, and closed RLS gaps flagged by Supabase's advisor.

**Repo:** all work is now committed **directly to the repo** (the tar.gz download-and-place workflow is retired). This session = the **23 commits since the session-37 handoff HEAD `8354d51`**, ending at HEAD **`4c20a05`**. Migrations applied this session: **053–060**. Live: `meritbooks-web.vercel.app`. **Do not push — the human pushes.**

> Note on dates: the session-37 handoff was written mid-session at `8354d51`. Everything committed after it — the 2026-07-20 evening batch plus the full 2026-07-28 batch — is this session's work. `e1164c1` (the pay-experience streamline that was an un-pushed tar at the end of session 37) was committed at the start of this session.

---

## 1. CURRENT STATE (brutally honest)

**Works and verified (new this session):**
- **The payment → PAID → GL chain is PROVEN end-to-end.** A live test **card** payment on the platform account delivered `payment_intent.succeeded`, the webhook applied the payment, flipped the invoice to PAID, and posted a **balanced** `AR_COLLECTION` journal entry — the first time the GATE-12 posting layer has ever written a journal entry to a real database. Confirmed split on the reference $100 payment: **$97 settlement clearing (DR) / $3 merchant fee (DR) / $100 A/R control (CR).** The session-37 open blocker is **CLOSED.**
- **The two root causes were latent DB breaks, not logic bugs** (both masked because the money-movement modules had only ever been tested with DB-free balance harnesses):
  1. `entry_type_enum` never contained the money-movement values (`AR_COLLECTION`, `PLATFORM_FEE`, `PAYROLL_RUN`, the four `AP_DISBURSEMENT_*`, etc.). Every post failed at insert with `invalid input value for enum`. **Fixed: migration 055.**
  2. The layer wrote the external processor id (`pi_...`, `po_...`, Plaid txn) into `gl_entries.source_id`, which is `uuid`. Every post failed with `invalid input syntax for type uuid`. **Fixed: migration 056** adds a text `source_ref` column; `gl-posting.ts` now reroutes any non-uuid `source_id` to `source_ref` so the bug class can't recur.
- **Webhook two-secret verification.** The handler now verifies against **both** the platform signing secret and the Connect signing secret (destination charges fire `payment_intent.*` on the platform account) — commit `91219b4`. Combined with the session-37 dashboard scope fix, the endpoint now actually receives and 200s the events.
- **`/api/payments/intent` (pay) is PUBLIC.** It had been behind auth, so an external customer could never create a PaymentIntent — payment was structurally impossible. Now a public raw route (`b21d216`).
- **`payment_intent.processing` handled** — the issuer now sees an ACH payment in flight, not just the customer (`4ab9100`, uses the `PAY_PROCESSING` event type added in migration 054).
- **Invoice email send is wired** — branded email + PDF attachment + Pay Now button, with a working **Send** button on the invoice (`bd0d8b5`, `16aa7db`); customer invoice PDF served from a tokenized route (`92d02be`).
- **A real test suite exists and passes** (see §2). ~124 test cases / 10 files on a PGlite migration-replay harness.

**Built but NOT yet end-to-end verified:**
- **ACH end-to-end.** Card is green. ACH sits in `processing` in Stripe test mode and only settles after a delay; the `processing` path is coded and the webhook records it, but a full ACH → settled → PAID cycle has not been watched to completion.
- **Platform fee income posting to Merit's own books** (migration 052, `postPlatformFee`) — still **inert until `PLATFORM_ORG_ID` is set** in Vercel. Never observed firing.
- **RBAC enforcement breadth.** The guard is wired into **`gl/post` only** as the reference pattern. Every other privileged route still resolves org as "first-org" and does not check permissions (see §7 and the identity FPB).

**Known-honest gaps:**
- Org identity is still the interim **"first-org"** resolution, capped defensively (tenant-isolation test caps first-org lookups; `1e22b8c`). This is NOT real multi-tenant identity — it is a placeholder that the identity/multi-tenancy FPB exists to replace. **This is the security NO-GO gate.**
- `PLATFORM_ORG_ID` unset → platform fee income does not post.

**Everything from session 37 and earlier** (Connect onboarding live-verified, branded hosted pay page, posting engine GATE 2, Plaid bank feed, AI gateway, invoice foundation, 5 PDF styles, detail/navigability layer) remains as it was.

---

## 2. ARCHITECTURE DECISIONS (resolved this session)

- **Testing is now first-class: Vitest against a real Postgres.** `apps/web/src/test/pg.ts` spins up **PGlite** (in-memory Postgres) and **replays every `packages/supabase/migrations/*.sql` in order**. This means a test failure can indict a **migration**, not just code — and it did (fixed migration 014 while wiring the harness, `98c1769`). Run with `npm test --workspace apps/web`.
- **The test suite is the drift backstop, by design.** Four guard tests turn whole classes of latent break into build failures:
  - `schema.test.ts` — every `entry_type` the code posts must exist in the enum **and** every base table in `public`/`core` must have RLS enabled.
  - `schema-contract.test.ts` — every constrained literal the code writes must satisfy its CHECK/enum (would have caught 055 and 056 before production).
  - `tenant-isolation.test.ts` — RLS actually isolates orgs; first-org lookups are capped.
  - `payment-chain.integration.test.ts` — full payment→PAID→balanced-GL, **skips until a Supabase test branch is wired** (needs a throwaway branch to run against).
- **`gl_entries` now has two source columns with distinct meanings.** `source_id` (uuid) = **internal** references (a bill/invoice id). `source_ref` (text) = **external** processor references (Stripe/Plaid ids). Never conflate them; `gl-posting.ts` self-heals a misrouted uuid.
- **Never mark an invoice PAID if the GL post failed** (`9a6836d`) — the status flip and the journal post are one logical unit; a failed post must not leave a PAID invoice with no entry.
- **Webhook idempotency must not swallow real errors.** The dedupe-on-`event.id` path was catching *all* errors as "duplicate"; now only genuine duplicates are swallowed, real failures surface (`2cab708`).
- **Seven subagents formalize the workflow** (`.claude/agents/`): **builder, verifier, auditor, reviewer, designer, scribe, security.** The reviewer immediately earned its keep — it caught a silent-misprice in fresh fee code (see §7). The security agent brings an application-security lens appropriate to a fintech.
- **Two FPBs (Feature Product Briefs, Rule 13) written**: `docs/FPB-payments-fees.md` and `docs/FPB-identity-multitenancy.md`. These are the governing specs for the fee model and for the identity/RBAC work that is the go-live gate.
- **Delivery model changed: commit directly to the repo.** No more tar.gz packages handed to Mike to unpack. Migrations still go to Supabase first (SQL Editor / MCP), then code is committed; Mike pushes.

---

## 3. BUSINESS RULES (fee model, GL postings, two-ledger)

### The two-layer fee model (now the canonical framing — see `docs/FPB-payments-fees.md`)

- **Layer 1 — what MeritBooks charges the merchant.** This is **platform revenue** and becomes the Stripe **`application_fee`** on the destination charge. It is **per-merchant, versioned config** in `core.merchant_fee_schedules` (migration 057), set by the platform admin when pricing/onboarding a merchant — a negotiable deal point, not a global constant. Rates in **basis points**, caps/floors in **integer cents**, cap **nullable** (null = uncapped). Exactly one active row per merchant (`effective_to IS NULL`); a rate change closes the current row and opens a new one, so every payment is explainable against the rate in force.
  - **Platform default** (merchant has no schedule): **ACH 1% (100 bps) capped at $10 (1000¢); card 3% (300 bps) uncapped.** A payment can always be priced — absence degrades to the default, never $0 and never a failure.
  - Resolver: `apps/web/src/lib/money/fees.ts`. `computeFee(schedule, method, baseCents)` is **pure, integer-only**: `fee = clamp(round(base × bps / 10000), floor, cap)`, then clamped to `0 ≤ fee ≤ base`. `resolveMerchantFeeSchedule()` loads the active row or the default — but **throws on a genuine query error** rather than silently defaulting (a broken query must not misprice at the platform rate; see §7). This replaced the hardcoded `ACH_PCT = 0.01 / CARD_PCT = 0.03` in the intent route (`425901f`).
- **Layer 2 — whether the merchant passes the fee to their own customer, or absorbs it.** Decided by the surcharge cascade (entity → customer → job → invoice), applied in the intent route. It does **not** change what MeritBooks charges — only **who bears it**. Migration 050 added `card_surcharge_enabled` at every level; **migration 058 adds the symmetric `ach_surcharge_enabled`** so ACH can be passed-or-absorbed per customer/invoice exactly like card. Tri-state boolean (true = pass, false = absorb, null = inherit). Default asymmetry lives in the resolver, not the column: **ACH → absorbed, card → pass-through.**

### Surcharge mechanics (invoice total is immutable)
- **ACH:** customer pays base; `application_fee` = 1% of base; tenant nets base − 1%.
- **Card pass-through:** customer pays base + 3%; `application_fee` = the 3% surcharge; tenant nets full base.
- **Card absorbed:** customer pays base; `application_fee` = 3% of base; tenant nets base − 3%.

### GL postings (the two-ledger model)
- **On the tenant's (merchant's) books — AR collection:** DR Settlement Clearing (net) + DR Merchant Fee Expense (the fee the tenant did not net) + CR A/R Control (base). Fee on tenant's books = base − (amount_charged − application_fee): ACH → 1%, card pass-through → 0, card absorbed → 3%. `entry_type = AR_COLLECTION`; processor id in `source_ref`. **Verified balanced on the live card test.**
- **On the platform operator's (Merit's) books — platform fee income:** DR Payments in Transit (application_fee − Stripe cost) + DR Merchant/Processing Cost (Stripe's actual cost, read from the charge's balance transaction) + CR Payment Processing Income 4910 (gross application_fee). Cross-tenant posting — it originates from another tenant's payment and posts to the platform org. **Gated on `PLATFORM_ORG_ID`** so ordinary tenants are unaffected; **not yet fired** (env var unset).
- **Idempotency:** webhook dedupes on Stripe `event.id` (`public.stripe_events`); payment application dedupes on the PaymentIntent id.

---

## 4. DISCUSSED BUT NOT BUILT (prioritized backlog)

1. **Identity + org resolution + RBAC enforcement — the security NO-GO gate.** Replace "first-org" with real per-user org identity from Clerk; wire the `require-permission` guard into **every** privileged route (only `gl/post` has it). Governed by `docs/FPB-identity-multitenancy.md`. **Nothing ships to real tenants until this is done.**
2. **Verify ACH end-to-end** — watch a test ACH go `processing → succeeded → PAID` with the AR collection JE posted.
3. **Activate platform fee income** — add Merit Management Group as a tenant, set `PLATFORM_ORG_ID` in Vercel, verify the 4910 income entry posts on Merit's books after a payment.
4. **Wire a Supabase test branch** so `payment-chain.integration.test.ts` runs in CI instead of skipping (throwaway branch the harness can point at).
5. **Merchant fee schedule admin UI** — Layer 1 is a DB table with no UI; the platform admin can't yet set/view a merchant's rate without SQL.
6. **Invoice depth to Complete** (Rule 13): credit memos, recurring invoices, dunning/late fees, A/R aging + DSO, events timeline in the drawer.
7. **White-label onboarding** — Stripe embedded components instead of Stripe-hosted Express (polish). Interchange-plus processor pivot only at ~$10M+/yr volume.
8. **Go-live** — swap `sk_test_/pk_test_/whsec_` → live keys, confirm the platform's legal operating entity, set the live statement descriptor to the Merit Enterprise Suite brand.

---

## 5. DESIGN & UX DECISIONS

- **Invoice Send is now a real action.** A **Send** button on the invoice calls the send endpoint and dispatches the branded email (logo, accent band, PDF attachment, Pay Now button) — closing the loop from session 37's "the link has to reach the customer's inbox." The customer PDF is served from a **tokenized** route so it's shareable without auth but not enumerable.
- **Issuer-visible processing state.** ACH `processing` is surfaced to the *issuer* (not just the payer), so an in-flight bank debit reads as "processing," consistent with the payer-side timing labels ("Confirms instantly" / "Clears in 1–2 business days") from session 37.
- **Fee transparency is a correctness requirement, not decoration.** Whatever the surcharge cascade decides (pass vs absorb, ACH vs card) must match what the customer is shown and what posts to the GL. The resolver is the single source of truth for all three.
- Pay-experience polish from session 37 (return confirmation banner, payer prefill, timing labels) is now committed (`e1164c1`), not an un-pushed tar.

---

## 6. WHAT TO BUILD NEXT (enough context to start)

**Start here (the go-live gate):** the identity/multi-tenancy/RBAC work in `docs/FPB-identity-multitenancy.md`.
- Replace `getFirstOrg()`-style resolution with the caller's actual org from Clerk (`orgId` claim / membership), everywhere `ctx.orgId` is derived in `lib/api-handler.ts`.
- Extend the `lib/rbac/require-permission.ts` guard (already proven on `gl/post` with permission `journal_entries:post`) to every privileged route. The guard resolves the caller's role via the existing permissions model (migration 014) and returns 403 on denial; `permissionDenied()` is pure and unit-tested (fails closed).
- The `tenant-isolation.test.ts` guard already asserts RLS isolates orgs — extend it as routes are hardened so a regression fails the build.

**Then:** wire the Supabase test branch (#4) so the integration test stops skipping; verify ACH end-to-end (#2); set `PLATFORM_ORG_ID` and confirm Merit's fee income posts (#3).

**Reference files:** payment webhook + intent under `apps/web/src/app/api/` (pay/webhook are public raw routes), `lib/money/fees.ts`, `lib/services/gl-posting.ts`, `lib/rbac/require-permission.ts`, `lib/api-handler.ts` (`requireAuth()` fails closed), migrations 050–060.

---

## 7. MISTAKES MADE (this session, specific)

- **Two latent breaks reached production because the money-movement layer was only ever tested DB-free.** The `entry_type` enum (055) and the `source_id` uuid/text mismatch (056) both meant the GATE-12 posting layer had **never once written a journal entry** — and nobody knew, because the balance harnesses exercised the pure arithmetic and never touched a real insert. The arithmetic was right; the insert was impossible. Only the first live card payment (2026-07-28) surfaced it, via a Stripe webhook error. **Correction:** the PGlite integration harness + `schema-contract.test.ts` now exercise code against real DDL, so this class fails the build.
- **The RLS-off ship.** Migration 057 created `core.merchant_fee_schedules` **without enabling RLS** — a PostgREST-exposed table reachable via the anon key. Supabase's security advisor caught it (`rls_disabled_in_public`). The table was empty, so nothing leaked, but it holds Layer-1 pricing (sensitive commercial data). **Fixed: migration 059** enables RLS with `org_read` + `service_all` (a merchant must never price itself); **057 corrected in place** so a fresh replay is secure; a schema test now asserts **every** base table has RLS.
- **File/prod RLS drift.** `core.account_role_keys` and `core.transaction_types` had RLS in production but the **migration files never captured it** — applied out-of-band, so a fresh environment would come up **insecure**. The RLS schema test caught it. **Fixed: migration 060** records the production posture in code (idempotent; a no-op against prod).
- **A silent-misprice in fresh fee code, caught by the new Reviewer agent.** `resolveMerchantFeeSchedule` originally treated a genuine query failure the same as "no schedule set" — both fell through to the platform default. That would misprice **every** payment at the platform rate instead of the merchant's negotiated rate (the fee that is both MeritBooks' revenue and the merchant's expense). **Corrected (`d10894a`):** the function now **throws** on a real query error and only defaults on a legitimately absent row. A retryable payment error beats quietly charging the wrong amount.
- **An auth bypass shipped.** A `dev-user` fallback granted a privileged identity on **any** Clerk auth failure. **Fixed (`5633044`):** `requireAuth()` in `api-handler.ts` fails **closed** (401, never substitutes an identity), applied to `apiHandler`/`apiQueryHandler` and all 11 raw routes that had the fallback.

---

## 8. FEATURE COMPLETENESS LEDGER — SESSION 38 DELTA

| Area | Session 37 | Session 38 | Note |
|---|---|---|---|
| Payment → PAID → GL chain | Coded, **not verified** (open blocker) | **PROVEN end-to-end (card)** | Balanced AR_COLLECTION JE posted live |
| Money-movement posting layer (GATE 12) | Believed working (DB-free tests) | **Actually functional** | 055 + 056 fixed the two latent inserts |
| Webhook delivery/verification | Scope suspected wrong | **Two-secret verify + non-swallow** | 91219b4, 2cab708 |
| Payment intent route | Auth-gated (customers couldn't pay) | **Public** | b21d216 |
| ACH processing visibility | none | **Issuer-visible processing state** | 4ab9100 + mig 054 |
| Invoice email send | Backlog #3 (the loop-closer) | **Wired: branded email + PDF + Send button** | bd0d8b5, 16aa7db, 92d02be |
| Fee model | Hardcoded 1%/3% constants | **Two-layer, per-merchant schedules** | mig 057/058, fees.ts; FPB written |
| Test framework | **None** | **Vitest + PGlite replay, ~124 cases / 10 files** | 4 guard tests; integration test skips until test branch |
| Security — auth | dev-user backdoor (bypass) | **Fails closed (401)** | 5633044 |
| Security — RBAC | none | **Guard built + wired into gl/post** (reference only) | require-permission.ts |
| Security — RLS | gaps (57 shipped without, ref-table drift) | **All base tables RLS-on; schema test enforces** | mig 059/060 |
| Subagents | none | **7 defined** | builder/verifier/auditor/reviewer/designer/scribe/security |
| FPBs | Invoice FPB pending | **Payments-fees + identity FPBs written** | Invoice FPB still pending |
| Delivery workflow | tar.gz download-and-place | **Direct-to-repo commits** | — |
| Identity / multi-tenancy | first-org placeholder | **still first-org (NO-GO gate)** | FPB written, not built |
| Platform fee income posting | inert (env unset) | **still inert** | needs PLATFORM_ORG_ID |

Migrations applied this session: **053** (rbac override uniqueness), **054** (invoice pay processing event), **055** (money-movement entry types), **056** (gl_entries source_ref), **057** (merchant fee schedules), **058** (ach surcharge enabled), **059** (fee schedules RLS), **060** (reference-table RLS drift). Current migration count: **060** (001–060 + `SESSION14_acme_wipe_and_validate.sql`).

---

*Session 38 = 23 commits, `8354d51`..`4c20a05`. HEAD `4c20a05`. Not pushed — Mike pushes. Deploy invariant unchanged: apply SQL to Supabase first, then commit code.*
