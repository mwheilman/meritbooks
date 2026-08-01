# Proposed Master-Document Amendments — for Mike's sign-off

**Date:** 2026-08-01 (Session 40) · **Status:** DRAFT — nothing here has been written into the
governing docs. Per the governance, the Master Document is amended in place with your approval;
the suite contracts are FROZEN and change only via versioning. This lists refinements discussed
this session that appear **more correct given the objective than what the docs currently say** —
plus items that should instead be reconciled *to* the docs.

Approve, edit, or reject each. On approval I'll fold ✅ items into the Master Document (and version
the affected suite contract where noted), and correct memory.md.

---

## A. Refinements that should UPDATE the canon (candidates)

### A1. Elevate the trust / supervision layer to a named architectural pillar
- **Docs today:** AI is framed as a *proposal layer* (II.5, VIII.7 governance, GATE 9 "AI
  differentiation"). "AI proposes, human approves; audit everything; auto-post off."
- **This session's sharpening:** MeritBooks is an **autonomous accounting workforce** with an
  explicit, first-class **trust/control layer** — machine-vs-human attribution, confidence tiers
  (auto/review/escalate), a unified exception queue, and a supervisor/operations surface — as the
  spine every pipeline plugs into. Staff **supervise the machine** rather than do the entry.
- **Why more correct:** it names what the product actually is and gives every pipeline one shared
  control surface, rather than scattering "advisory + audit" across modules. It also matches VIII.7's
  own warning ("you only get to lose a controller's trust once") by making supervision a product, not a footnote.
- **Built primitives to record:** `core.action_log` (actor_type HUMAN|AI|SYSTEM, confidence, tier),
  `lib/trust/score-tier.ts` (`scoreToTier` → auto/review/escalate), `/exceptions` (unified "Needs
  Attention" queue), `/operations` (supervisor view).
- **Amends:** Master Doc Part I (add a pillar / sharpen I.1), Part VIII.7, and a new Part XI subsection
  documenting the primitives. **Recommend: ✅ adopt.**

### A2. Consolidation by arbitrary tenant-defined grouping (not only the ownership hierarchy)
- **Docs today:** consolidation is modeled strictly as the ownership tree (`parent_entity_id` +
  `ownership_pct`, GATE 2 seam / GATE 11a).
- **This session's point (yours):** a tenant/firm should be able to consolidate by **arbitrary
  selection** — by industry, by ad-hoc set, by any grouping — and the **business rationale is the
  tenant's to decide, not ours** ("the platform provides capabilities; the tenant decides how and why").
- **Why more correct:** an accounting firm / PE operator's real consolidation needs aren't limited to
  legal parent/subsidiary. Modeling consolidation as **user-defined grouping sets** (with the ownership
  tree as one built-in grouping) is strictly more capable and matches the generic-platform thesis.
- **Amends:** GATE 11a scope in Part VII + Part X open-decisions; **touches the FROZEN suite entity
  contract**, so it needs a versioned change to `merit-suite-architecture.md`, not an in-place edit.
- Already partly captured in `docs/FPB-tenant-model-consolidation-analytics.md`. **Recommend: ✅ adopt,
  fold that FPB's model into 11a's brief.**

### A3. Three-plane identity/UI model (Platform / Practice / Book-of-Record)
- **Docs today:** RBAC (9 roles) + suite identity model (System Admin / Org Admin / Accounting User /
  Business User), but no explicit UI plane model.
- **This session:** the single conflated UI hid "which hat am I wearing"; we built a plane switcher that
  reshapes the app per context (Platform ops / Practice management / Book-of-record).
- **Why more correct:** it operationalizes the identity model for the Merit-managed (accounting-firm)
  business model where one person legitimately wears multiple hats across tenants.
- **Amends:** Master Doc Part II/IV (add the plane model), reference `FPB-tenant-model-...`. **Recommend:
  ✅ adopt as the UI expression of the identity model** (keep authority in `core.memberships/roles`).

### A4. Delivery workflow: direct-to-repo + auto-push, migrations-first
- **Docs today (memory.md, Future-Session-Instructions):** tar.gz delivery + manual SQL-then-push.
- **Reality (Session 40):** commits go directly to the repo; an auto-push loop on Mike's machine ships
  them; migrations applied to Supabase first; Vercel `next build` is the authoritative typecheck.
- **Why more correct:** it's what actually happens now and removes the per-feature manual gate.
- **Amends:** memory.md delivery notes + Master Doc I.6. **Recommend: ✅ adopt (factual update).**

### A5. Schedule-driven merchant fee model
- **Docs today:** hardcoded card 3% / ACH 1% (Session 37).
- **Reality (this session):** per-merchant `core.merchant_fee_schedules` + `lib/money/fees.ts` resolver
  (two-layer), aligning with `FPB-payments-fees.md`.
- **Why more correct:** per-merchant versioned pricing is required for white-label resale; a hardcoded
  rate can't be sold to other firms.
- **Amends:** Master Doc 12.1 / VIII fee economics. **Recommend: ✅ adopt (confirm the migration number
  and that it's committed).**

### A6. Parallel-agent execution model (process, not product)
- Record the proven wave methodology (file-disjoint parallel builders + reserved shared spine + single
  central verification lane + Vercel-build-as-typecheck) in the Future-Session-Instructions.
- **Recommend: ✅ adopt** (already encoded in `CLAUDE.md §0.1`).

---

## B. Items that must be reconciled TO the docs (NOT canon changes)

These are session-40 choices where **the docs are right and the build is the stopgap** — fix the code,
don't change the canon:

- **B1. `canApprove` reads `core.employees.role`.** The suite identity contract says money-movement
  authority must reconcile to `core.users/memberships/roles` and explicitly warns against a Books-private
  "who may approve." **Action:** reconcile `canApprove` to the identity model.
- **B2. Session-40 verticals (Vendor Compliance, Reconciliation autopilot, 13-Week Forecast) were built
  downstream of the gate order and without FPBs.** Vendor compliance and reconciliation already have
  deeper specs (VIII.2, VIII.4). **Action:** treat the built code as raw material; write the FPB and
  reconcile/rebuild to it under the correct gate — do not mark them Complete.
- **B3. Check Run** rides the `canApprove` stopgap and sits under GATE 12.2 (AP), whose adapter isn't
  built and whose authorization must reconcile to Core identity. **Action:** keep as prepare+approve
  only (no money movement) until 12.2 + identity land.

---

## C. Recommended immediate re-sequencing (per the canon)

1. Unblock & verify **GATE 12.1** — Stripe payment→PAID→GL (webhook scope + `4242` card test).
2. Reconcile **`canApprove`** to `core.memberships/roles` (B1).
3. Write the **Invoice FPB** (Rule 13); build Invoices to *Complete* (email send + PDF + Pay Now, then
   credit memos, recurring, dunning/late fees, AR aging/DSO).
4. Resume downstream waves (7 / 8 / 11a) only behind their FPBs.
