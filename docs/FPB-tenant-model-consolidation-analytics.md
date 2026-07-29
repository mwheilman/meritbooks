# Feature Product Brief — Tenant Model, Consolidation & Performance Analytics

**Module:** Tenancy shape, dimensional consolidation, team/portfolio performance analytics (cross-cutting; builds on Identity & Multi-Tenancy)
**Status:** Draft for build. Analysis + design only — no application code or migrations in this document.
**Author:** MeritBooks — product/architecture session (Mike + Claude)
**Date:** 2026-07-29
**Depends on:** `FPB-identity-multitenancy.md` (core.users / memberships / membership_locations / platform_admin_sessions, migration 061) and the live Clerk↔Supabase RLS enforcement shipped 2026-07-29.

> Written to be built from. Where there is a technical choice it makes one recommendation and says why. Human-only steps are flagged **[HUMAN]**. This brief deliberately keeps *business rationale* out of the architecture: the platform provides capabilities; the tenant decides how and why to use them.

---

## 1. Summary

MeritBooks serves three shapes of customer with **one** data model, distinguished by settings rather than schema:

- a **direct business** keeping its own books (one set of books, one or two users);
- a **multi-entity operator** — e.g. Merit Management Group — keeping books for many entities it manages;
- an **accounting firm** keeping books for many unrelated clients with a team.

The key decision: **these are not three architectures — they are one architecture on two dials** (how many book-sets the tenant manages, and which entitlements are on). From the platform's point of view MMG is simply a tenant that manages many book-sets; whether it *owns* those entities or keeps books for outside clients is invisible to the system and irrelevant to the model.

On top of that model this brief specifies two capabilities the multi-book-set customers need:

1. **Dimensional consolidation** — generate reports over any ad-hoc selection of the book-sets a tenant manages (full consolidation, by industry, by division, by region, by hand-picked set), saveable as named report definitions. The architecture takes no view on *why* a grouping is chosen.
2. **Performance analytics** — an aggregated view of throughput and book health across the book-sets and team members a tenant manages. This is the *same primitive* as MeritBooks' own platform-operator view of its tenants, applied at a different scope.

Both are entitlement-gated and bounded only by access: a user can consolidate or analyze exactly the book-sets they are permitted to see, no more.

---

## 2. Goals & Non-Goals

### Goals
- One tenant model that degrades cleanly from a solo business (one location, analytics/consolidation off) up to a firm (many locations, full team + analytics), driven by `entitlements` and location count — never by a schema fork.
- Confirm and document **client = location** (a managed book-set is a `core.locations` row under the tenant org), and state the consequences.
- **Consolidation as an arbitrary, multi-dimensional, query-time grouping** over locations, saveable and re-runnable, bounded by the caller's location access.
- **Performance analytics** as one scope-parameterized rollup: team-within-tenant for a firm leader, tenants-within-platform for a MeritBooks operator.
- Everything additive on top of the identity spine already shipped; no re-model.

### Non-Goals (this module)
- Re-modeling org/location. The identity FPB settled that; this builds on it.
- Billing/pricing of plan tiers (the *mechanism* is `entitlements`; commercial packaging is a separate commercial decision).
- The platform-operator provisioning/licensing **console UI** beyond defining the data it reads/writes (called out as its own build in §10).
- Defining MMG's or any tenant's *business* consolidation policy. The platform supplies the capability; the tenant supplies the intent.
- SSO/SAML, data warehouse/BI export (future).

---

## 3. Personas & Core Use Cases

| Persona | Manages | Needs from this module |
|---|---|---|
| **Direct business owner/admin** | 1 book-set (their own) | Their books. Consolidation/analytics **off** — must feel absent, not stripped-down. |
| **Multi-entity operator** (MMG controller) | Many owned entities | Consolidated reporting over any slice of the entities; team throughput/health across them. |
| **Accounting-firm leader** | Many client book-sets, a team | Per-client and per-team-member performance; consolidation within each client that has multiple entities; strict per-client access control for staff. |
| **Firm/operator staff** | A subset of book-sets | Work only their assigned book-sets; see their own performance numbers. |
| **MeritBooks platform operator** | All tenants | Provision tenants + seats + entitlements; a portfolio view of tenant health — the same rollup primitive one scope up. |

**Anchor use cases**
- *UC-1 (consolidation, ad-hoc):* MMG manages 10 book-sets. The controller runs: full consolidation; then HVAC-only; then remodeling-only; then Residential vs Commercial division — from the same 10, sliced four ways, no predefined boundary.
- *UC-2 (saved definition):* The controller saves "Q3 Board Consolidation" (a named selection) and re-runs it next quarter without re-picking.
- *UC-3 (firm isolation):* A firm assigns a specialist to 2 of its 40 clients. That specialist can neither view nor consolidate the other 38.
- *UC-4 (team analytics):* A firm leader sees, per team member and per client, volume processed, categorization backlog age, and (defined explicitly) a rework signal — for the book-sets they manage.
- *UC-5 (platform analytics):* A MeritBooks operator sees the same rollup across tenants — active tenants, processing volume, backlog health — to run the business.
- *UC-6 (solo):* A single business signs up, sees one clean set of books, and never encounters a client-switcher or a team dashboard.

---

## 4. Current State (ground truth)

Read and verified in-repo:

- **`002_dimensions.sql`** — `locations` already carries `industry text` (line 13), plus the dimension tables (location/department/class/item). Industry-based grouping has a home field today; the reporting UI already exposes **All Companies** and **All Industries** filters (seen live on the Trial Balance page).
- **`015_department_model.sql`, `020_core_jobs_archetype.sql`** — further classification axes exist (department model; job archetype vs `job_type` industry tag). Multi-axis classification is an established pattern, not a new idea.
- **`023_rev_rec_engine.sql`** — `core.organizations.entitlements jsonb not null default '{}'` (line 95). Already the live feature-flag mechanism: `046_plaid_bank_feed.sql` gates the bank feed on `entitlements->>'bank_feed'`. This is exactly the switch for consolidation/analytics tiers.
- **`061_identity_foundation.sql`** — `core.membership_locations` (which member may access which location) and `core.platform_admin_sessions` (audited cross-tenant access) already exist. `membership_locations` is precisely the access dial this module relies on.
- **Attribution** — `created_by` exists on many tables (GL, transactions, budgets…), but `018_gl_entries_attribution_nullable.sql` made it nullable, and coverage is inconsistent across the write paths. Per-user attribution is *partial* — the analytics feature's main new data dependency (see §9).
- **RLS** — `org_isolation = (org_id = get_org_id())` on org tables; enforcement went live for the `apiHandler` routes on 2026-07-29. **Location-scoped RLS does not yet exist** — RLS keys on `org_id` only, not on `location_id` ∩ membership.

**Modeling fact carried forward (from identity FPB):** a tenant is one `core.organizations` row; the book-sets it manages are `core.locations` under it. "Organization = tenant, location = a set of books." MMG is one tenant among many.

---

## 5. The Tenant Shape — one model, dials not forks

There is exactly one tenant shape: **a tenant manages 1..N book-sets (locations) with a team (memberships).** The three customer types are positions on two dials:

- **Location count** — 1 (solo) … a handful (small operator) … many (MMG / firm).
- **Entitlements** — `multi_book_management`, `consolidation`, `performance_analytics`, `location_scoped_access`, each on/off per org.

Ownership is not a dial. Whether a tenant owns its entities or keeps books for outside clients changes nothing structurally. It surfaces only as *whether the tenant chooses to consolidate certain book-sets together* — a runtime selection (§8), not a stored relationship.

**Design rule — the solo path is first-class, not a degraded firm.** If the product is designed firm-first and the solo case is a stripped firm, the solo UI carries vestigial client-switchers and empty dashboards. Design the single-book-set tenant as the clean default; the multi-book-set machinery *lights up* on entitlement. Onboarding branches once: "keep your own books" vs "manage books for multiple entities/clients."

---

## 6. Decision — a managed client is a `location`, not its own org

A book-set the tenant manages is a `core.locations` row under the tenant's org — **not** a separate organization.

Why:
- **Consolidation becomes a within-org rollup** (group locations, sum) instead of a cross-org aggregation. Since consolidated reporting across managed book-sets is a headline requirement (§8), this is decisive — the alternative makes the flagship feature the hard path.
- **A team spans book-sets naturally** through `memberships` + `membership_locations`, with no per-client re-invitation.
- **The solo and multi cases share one structure** — a solo business is simply a tenant with one location; nothing special-cased.

The one cost — unrelated clients under a firm share a single org RLS boundary — is paid by the **location-scoped access dial** (§7), not by promoting clients to orgs.

Rejected: *client = its own org.* Gives per-client billing/isolation for free but forces cross-org aggregation for every consolidated report and a membership per client per staffer. Wrong trade for a product whose center of gravity is consolidated reporting.

---

## 7. Two orthogonal dials inside a tenant

These are independent and must not be conflated:

**7.1 Access dial — `membership_locations` (+ location-scoped RLS) [NET-NEW RLS].**
Which team members may see which book-sets. The join table exists (061); what's missing is **location-scoped RLS**: a second predicate so that, when `location_scoped_access` is entitled, a user sees only rows whose `location_id` is in their `membership_locations`. Recommended shape: a `can_access_location(location_id)` SQL helper (reads the caller's memberships) added to RLS `USING` clauses on location-bearing tables, active only when the org entitles it — so MMG (dial off) is unaffected and a firm (dial on) gets per-client isolation. This is the only new *isolation* primitive in the module and deserves its own tenant-isolation tests.

**7.2 Consolidation dial — reporting grouping (§8).**
Which book-sets roll up together in a report. Purely a reporting-time selection over book-sets the caller can already access. It grants no access and enforces no boundary; access is entirely the access dial's job.

The relationship: **you may consolidate any set of book-sets you can access, grouped any way you choose, for any reason.** Access constrains the universe; consolidation groups within it.

---

## 8. Consolidation model — dimensional, ad-hoc, saveable

Consolidation is a **query-time grouping over a selected set of locations**, never a fixed structure baked into the org.

**8.1 Classification.** Each location carries values on open-ended axes: `industry` (exists), a **division/segment** axis (e.g. Residential / Commercial), region, entity type, and free-form **tags** (many-to-many, so a book-set can be HVAC *and* Residential *and* "Iowa" at once). Recommendation: one extensible `core.location_tags` (location_id, axis, value) table rather than a widening column list, so new axes need no migration. Keep `industry` as a first-class column for continuity with the existing filter; mirror it into the tag model or read both.

**8.2 Selection.** A consolidated report is run over a set of locations chosen by any of:
- **All** the tenant's accessible locations (full consolidation),
- a **filter** on one or more axes (industry = HVAC; division = Residential; industry = HVAC *and* region = Iowa),
- a **manual multi-select** (hand-picked book-sets, any reason),
- the intersection of the above.

The engine does not care which; it receives a resolved location-id set and rolls up. The existing report engine already groups by location and already exposes company/industry filters — this generalizes selection to arbitrary axes + manual picks.

**8.3 Saved report definitions [NET-NEW].** A selection can be named and stored (`core.report_definitions`: org_id, name, report_type, selection_spec jsonb, created_by, visibility) and re-run — "HVAC Roll-up," "Residential Division," "Q3 Board Consolidation." `selection_spec` records the filter/axis criteria and/or explicit location ids. Re-running re-resolves the set, so a book-set added later that matches the filter is included automatically (filter specs) while explicit-id specs stay fixed — both behaviors are useful; the spec captures which.

**8.4 Access binding.** Every consolidation resolves against the caller's accessible locations *at run time*. A saved definition that references book-sets a given user can't access silently drops them for that user — the report is always a subset of what the runner may see. No definition can widen access.

**8.5 Correctness notes (mechanics, not policy).** Consolidation must eliminate intercompany where the tenant has flagged it (the intercompany tables exist, migrations 035/2020-series) — but *whether* to eliminate is a per-report option the tenant sets, not an assumption. Currency is single (USD) today. The engine sums balanced sub-ledgers; a consolidated trial balance still asserts balanced.

---

## 9. Performance analytics — one rollup primitive, two scopes

A firm leader aggregating team/book-set performance and a MeritBooks operator aggregating tenant performance are the **same operation at different scopes**: roll up book-set activity + health over a portfolio, group by an actor or an entity. Build it once, parameterized by scope:
- **Firm/operator scope:** portfolio = the tenant's locations; actors = the tenant's members. Gated by `performance_analytics` entitlement + a leadership permission.
- **Platform scope:** portfolio = all tenants; actors = tenants. Gated by platform-admin role, via the audited path.

**9.1 New data dependency — a consistent activity ledger [NET-NEW, the critical one].** Most metrics need per-actor, per-book-set, timestamped events. `created_by` is partial and nullable today, so the honest foundation is an append-only `core.activity_events` (id, org_id, location_id, user_id, event_type, entity_ref, occurred_at, metadata jsonb) written by the mutating paths (categorize, approve, post, reconcile, invoice…). Derive metrics from it + existing tables. Without this, analytics is guesswork; with it, metrics are exact and auditable.

**9.2 Candidate metrics** (the tenant enables the set it wants):
- **Throughput** — transactions categorized/approved/posted per member per period. Clean, directly from the ledger.
- **Backlog health** — age of oldest uncategorized item per book-set; count aging past thresholds. A book-set-health metric, attributable to the assigned member.
- **Cycle time** — ingest → categorized → approved durations.
- **Rework signal** (accuracy proxy) — rate of entries later edited/reversed/re-categorized, or AI-suggestion overridden-then-corrected. **Must be defined explicitly**; "accuracy" without a precise definition is noise.
- **Engagement** — active time in platform (requires session telemetry not captured today; privacy-sensitive — see 9.4).

**9.3 Aggregation.** By member, by book-set, by period; roll up to the tenant. Same group-by machinery as consolidation, over the activity ledger instead of the GL.

**9.4 Design constraints (product integrity, flagged not imposed).** Two metrics are easy to get wrong and worth an explicit decision at build time rather than a default: a *rework/accuracy* metric needs a stated definition or it misleads, and a member handed messy book-sets can score worse through no fault of their own, so raw cross-member comparison can be unfair. Throughput and backlog health are the most robust and least gameable. Recommend: each member can see their own numbers (transparency), and the feature is opt-in per tenant (it already is, via entitlement). These are recommendations; the tenant chooses.

---

## 10. Entitlement tiers & the provisioning/licensing plane

**10.1 Tiers via entitlements.** Customer type is expressed as an `entitlements` bundle on the org — e.g. `multi_book_management`, `consolidation`, `performance_analytics`, `location_scoped_access` — set at provisioning. No plan needs a different schema; a plan is a named bundle. This reuses the live mechanism (023), which already gates `bank_feed`.

**10.2 The platform-operator plane [SEPARATE BUILD].** The MeritBooks operator issues a tenant org, seats, and an entitlement bundle, and manages tenant settings. This is a distinct surface from the bookkeeping app and must stay that way (identity FPB §8): platform power engages only through an audited `platform_admin_session`, never as ambient authority inside a tenant session. Data it needs: a licenses/seats concept (org_id, plan, seat_count, status, term) — today only `entitlements` exists, so seats/plan are the gap. The console UI is out of scope here; this brief only fixes the data it reads/writes.

**10.3 "MeritBooks is also a tenant."** The owning entity keeps its own books as an ordinary tenant org, while the same humans hold platform-staff identities (the `is_platform_staff` flag + a platform role). One `core.users` row, two hats, cleanly separated — already supported by the 061 spine. The operator console and the tenant app are different front doors to the same identity.

---

## 11. Context & navigation — making the active hat explicit

**The problem (observed, live):** today's UI conflates the planes. One chrome places the MeritBooks operator, the practice/leadership admin, and the book-of-record operator on the same surface, so while reviewing something it's unclear which authority is active. The same screen has the user as MeritBooks admin, as accounting leadership (who grants the team access), *and* as the book of record for Revived — with nothing signaling which. That ambiguity is a real defect: the same click can mean "administer the platform," "grant a teammate access," or "post to Revived's ledger."

**Principle:** the active plane and scope must be explicit, and you switch between them deliberately. Three contexts, each with its own chrome and navigation:

1. **Platform console** (MeritBooks operator) — a **separate front door** (recommend a distinct route/skin, e.g. `admin.meritbooks.app`), entered deliberately and through the audited `platform_admin_session`. Tenants, seats/licensing, entitlements, cross-tenant health. You are never *accidentally* in it.
2. **Practice / tenant administration** — within a tenant, scope = the whole tenant. The "run the practice" surface: team & access, clients (book-sets), consolidation definitions, performance analytics, tenant settings. This is the accounting-leadership hat.
3. **Book of record** — working inside one selected book-set (Revived). Scope = that location: the day-to-day ledger, bank feed, and reports for those books.

**Switcher + persistent indicator.** A top-bar control always shows the path you're in — `Platform ▸ / Practice: MMG ▸ / Books: Revived Interiors` — and is how you move between planes. On entering a specific book-set, a persistent banner/colour cue ("You're in Revived Interiors' books · Return to Practice") makes the hat unmistakable — the way QuickBooks Online Accountant separates "Your Practice" from a client's books and changes the whole chrome on entry. The current **All Companies** dropdown is only the location selector *inside* the book-of-record plane; it does not express the platform/practice/books distinction, which is precisely the source of the confusion.

**No new data model — this is information architecture.** The identity backing already exists: `is_platform_staff` (plane 1), `membership.role` (plane 2, leadership vs staff), `membership_locations` (plane 3, which book-sets). The UI reads the active context and gates navigation from these. Net-new is purely front-end: a context provider, the switcher, per-plane navigation trees, and the in-books banner.

**Design rule — default to the narrowest hat.** On login a user lands in the most specific safe context (their books, or the practice if they're leadership); stepping up to the platform console is always a deliberate, audited act.

---

## 12. Provisioning & delegated role administration

**Who creates whom — a deliberate two-step chain:**
1. **MeritBooks operator provisions the tenant** — creates the tenant org, sets its entitlement bundle, and invites the tenant's **first admin**. That is the *only* account MeritBooks sets up; it never touches the tenant's internal users.
2. **The tenant admin self-administers** — invites its own members, assigns roles + location scope, and runs its own onboarding wizard for the locations it manages. From here the tenant is self-serve.

This keeps the operator out of tenant internals and matches how multi-tenant SaaS delegates everywhere: the vendor seeds one admin; the customer runs its own org.

**Tenant-admin onboarding wizard (plane 2).** Distinct from the platform provisioning flow. Steps: (a) set up the locations/book-sets it manages (create or import entities → chart, periods, banks), (b) invite team members, (c) assign each a role + location scope, (d) optionally define custom roles. The "stand up my practice" wizard.

**Roles become tenant-owned data, not a fixed enum.** Today RBAC is 9 hardcoded roles in `permissions.ts` (+ migration 014 overrides). To let tenants "create capabilities unique to their needs," roles move from code to data:
- **Permission catalog (system-owned).** The atomic capabilities — `journal_entries:post`, `bank_feed:approve`, `reports:view`, `consolidation:run`, `team:manage`, `settings:edit`, … each scoped by location. These are the *building blocks*; only the app can define them because only the app enforces them. New features add catalog entries. A tenant cannot invent an atomic permission the app doesn't understand — but that is not the flexibility being asked for.
- **Roles (tenant-owned).** A role is a named, tenant-defined *set* of catalog permissions + a location scope. Tenants compose, name, and scope freely — that is where "unique to their needs" lives, and it delivers the intuition without letting a role reference capabilities the app can't enforce. Stored as `core.roles` (org_id — null = system template — name, description) + `core.role_permissions` (role_id, permission_key, scope). `memberships.role` evolves from a string enum to a `role_id` FK.

**Default templates (a few, as starting points).** Ship a small, recognizable set every tenant gets and can use as-is, clone-and-tweak, or ignore:
- **Owner / Tenant Admin** — full tenant administration incl. user & role management, all locations.
- **Controller / CFO** — all financials across all locations; user management optional.
- **Accounting Manager** — operations + team oversight for assigned locations.
- **Accounting Specialist / Processor** — categorize, enter, reconcile on assigned locations; posting/approval limited.
- **Business Owner (Viewer)** — read-only dashboards + reports for their entity.

These map to the stated examples (business-owner simple view, processing team member, company CFO). Cloning a template creates a tenant-owned editable copy; the template stays immutable.

**Role builder — intuitive by design.** The editor: name the role → optionally start from a template → toggle permissions **grouped by feature area in plain language** (not raw keys) → set location scope (all / specific) → read a plain-English "this role can…" summary → save and assign. Grouped presets + a readable summary are what make it approachable rather than a wall of checkboxes.

**Guardrails (non-negotiable):**
- **No privilege escalation** — a tenant admin may only grant permissions they themselves hold.
- **No cross-plane grant** — a tenant admin can never grant platform-plane powers; those exist only on the operator side.
- **No lockout** — at least one active Tenant Admin must remain; the last one cannot be demoted or removed.
- **Reserved to owner** — billing/entitlement-affecting actions may be limited to the tenant owner, not every admin.
- **Scope enforced by RLS, not UI** — a role's location scope resolves through `membership_locations` + location-scoped RLS (§7.1), so "assigned locations only" is a database guarantee, not a screen that hides rows.

This evolves the identity FPB's fixed role list (its §5.3): those roles become the **default templates**, and the model becomes data-driven, per-tenant custom roles.

---

## 13. Data model — reuse vs net-new

**Reuse (already present):** `core.organizations` (+ `entitlements`), `core.locations` (+ `industry`), dimension tables, `memberships`, `membership_locations`, `platform_admin_sessions`, `is_platform_staff`, the report engine's location grouping + company/industry filters, intercompany tables.

**Net-new:**
1. `core.location_tags` (extensible classification axes) — §8.1.
2. **Location-scoped RLS** helper + policies, entitlement-gated — §7.1.
3. `core.report_definitions` (saved consolidation/report selections) — §8.3.
4. `core.activity_events` (append-only per-actor ledger) + writes from the mutating paths — §9.1.
5. A **licenses/seats** concept on the platform plane — §10.2.
6. **Custom-roles model** — `core.roles` (per-tenant + system templates) and `core.role_permissions`; `memberships.role` becomes a `role_id` FK; a system-owned **permission catalog** table. Evolves the fixed 9-role enum in `permissions.ts` — §12.
7. New entitlement keys + a leadership/manager permission and a `team_analytics:read` (fits the permission catalog above).

---

## 14. Acceptance criteria (testable)

- A solo tenant (one location, analytics/consolidation un-entitled) shows no client-switcher, no team dashboard, and no consolidation UI.
- Given 10 locations, a consolidated report can be produced over: all; an industry filter; a division filter; and an arbitrary manual subset — each yielding a balanced consolidated trial balance.
- A saved report definition re-runs and re-resolves its location set; a filter-based definition picks up a newly matching location, an explicit-id definition does not.
- With `location_scoped_access` on, a member assigned 2 of N locations cannot read or consolidate the other N−2 — asserted at the database (RLS), not the route. Ratchet/isolation tests cover it.
- With it off, a tenant like MMG sees all its locations (no regression).
- Every consolidation/analytics query resolves against the caller's accessible locations; no saved definition widens access.
- Performance metrics derive from `activity_events`; the same rollup module produces a firm-scope and a platform-scope view differing only by scope parameter.
- A defined "rework" metric has a written definition and a test fixture proving what counts.

---

## 15. Phasing

1. **Custom-roles + delegated admin** — `roles`/`role_permissions`/catalog, the tenant-admin user & role management surface, and the tenant-admin onboarding wizard (locations + team). This is the backbone the plane-2 UI (§11) and everything below hangs off, and it's what makes MeritBooks-provisions-tenant → tenant-admins-its-own-team real. (§12.)
2. **Classification + consolidation selection** — `location_tags`, generalize report selection to arbitrary axes + manual multi-select. (Builds on existing filters.)
3. **Saved report definitions** — `report_definitions`, name/save/re-run.
4. **Location-scoped access** — RLS helper + policies + entitlement + isolation tests. (Security-sensitive; preview-tested like the org flip.)
5. **Activity ledger** — `activity_events` + attribution writes across mutating paths. (Foundational for analytics; can begin in parallel.)
6. **Analytics rollup** — metrics + firm-scope dashboard; then platform-scope reuse.
7. **Licensing/seats + operator console** — separate track (§10.2).

---

## 16. Out of scope
Commercial plan pricing/packaging; the operator console UI; BI/warehouse export; multi-currency consolidation; session-telemetry "time in platform" (deferred with 9.4's privacy note); SSO/SCIM.

---

## 17. Open decisions & required human actions
- **[DECISION]** Consolidation axes to ship first (industry + division confirmed by use cases; region/entity-type/tags optional).
- **[DECISION]** The `rework`/accuracy metric definition — or defer it and ship throughput + backlog health first.
- **[DECISION]** Plan/tier packaging (which entitlements bundle into which named plan) — commercial, not technical.
- **[DECISION]** Whether `location_scoped_access` defaults off for all tenants (recommended) and is opt-in per firm.
- **[DECISION]** The exact default role templates to ship (§12 proposes five) and which permissions are **owner-reserved** (billing/entitlements).
- **[DECISION]** Whether tenants can only *compose* catalog permissions into roles (recommended) or ever request net-new atomic permissions (recommend no — the app must enforce every permission).
- **[HUMAN]** None in Clerk for this module; it rides on the identity integration already configured. Provisioning/seats will add platform-console steps when that track starts.
