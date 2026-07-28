# Feature Product Brief — Identity & Multi-Tenancy

**Module:** Identity & Multi-Tenancy (foundational, cross-cutting)
**Status:** Draft for build. Analysis + design only — no application code or migrations in this document.
**Author:** MeritBooks Auditor Agent
**Date:** 2026-07-28
**Reference stack:** Clerk Organizations + Supabase Row-Level Security

> This brief is written to be built from. Where there is a technical choice, it makes one recommendation and says why. Every step that requires the human (especially Clerk dashboard configuration the engineer cannot perform) is flagged with **[HUMAN]**.

---

## 1. Summary

MeritBooks needs a real multi-tenant identity layer. Today it has the *shape* of one — RLS policies keyed to `get_org_id()`, two Supabase clients, a Clerk `orgId` in the auth context — but none of it is load-bearing. The API runs entirely as the service-role (RLS-bypassing) client and resolves "the tenant" as `select id from organizations limit 1`. With exactly one organization in production this is invisible and correct. With two, **49 endpoints serve the wrong tenant's data to everyone.**

This module closes that gap and adds the capabilities the business now requires:

1. **Many-to-many users↔orgs.** One person can belong to N companies. A Merit partner can be platform admin *and* admin of a merchant. An outside accounting firm can manage many merchant orgs under one login. This maps directly to Clerk Organizations (a user has memberships to N orgs plus one "active" org).
2. **A dedicated platform-admin role** (not a super-user flag) that can reach any merchant org for support and to set Layer-1 platform fees — but only via an explicit, audited path. Merchants get normal membership-scoped access. This keeps the two fee layers — platform pricing (what MeritBooks charges merchants) vs. merchant operations (what a merchant charges its own customers) — cleanly separated by identity, not by convention.

The correctness bar: **a second org's data must be provably invisible to the first**, enforced by the database, not by remembering to add a `where org_id =` clause.

---

## 2. Goals & Non-Goals

### Goals
- A user can belong to many organizations and switch active org (Clerk memberships).
- Every authenticated API request is scoped to the caller's **active, verified** org — enforced at the database via RLS, not application convention.
- A Clerk organization (`org_xxx`, a string) maps deterministically to a `core.organizations` UUID, and `get_org_id()` reads a trustworthy UUID from the JWT.
- Platform admins can act inside any merchant org through one explicit, fully-audited mechanism.
- The 49 first-org lookups are driven to **zero**; the ratchet test enforces monotonic progress.
- The `dev-user` auth fallback is removed from any code path that can run in production.

### Non-Goals (this module)
- Building new business features on top of identity (reports, AR, etc.).
- Billing/collection of Layer-1 platform fees (identity only decides *who may set them*).
- SSO/SAML, SCIM provisioning, or custom Clerk-independent auth.
- Redesigning the RBAC feature-permission catalog (it exists in `permissions.ts` and migration 014; we integrate with it, we do not replace it).

---

## 3. Personas & Core Use Cases

| Persona | Belongs to | Needs |
|---|---|---|
| **Merit partner / platform operator** | Platform org + (optionally) merchant orgs | Set Layer-1 fees, support any merchant, see cross-tenant admin views |
| **Merchant admin** (e.g. Merit Management Group's controller) | One merchant org | Full access to that org's books, its locations, its users |
| **Outside accounting firm** | Many merchant orgs | One login, switch between client orgs, no access to platform settings |
| **Merchant staff** (accounting_specialist, check_processor, business_user) | One merchant org, subset of locations | Membership-scoped, location-scoped access per RBAC |

**Anchor use cases**
- *UC-1:* An accounting firm user logs in, sees 6 client orgs, switches to "Swan Creek Holdings," and sees only that org's bank feed.
- *UC-2:* A Merit partner opens the platform console, sets the card-fee schedule for merchant "Heartland," and the action lands in an audit log naming the platform admin, the target org, and the change.
- *UC-3:* A merchant admin invites a new accounting_specialist and assigns them 2 of the org's 8 locations. That user can never see the other 6, nor any other org.
- *UC-4 (negative):* A merchant admin crafts a request claiming a different `org_id`. RLS rejects it because the claim is derived from a verified Clerk membership, not from client input.

---

## 4. Current State (ground truth)

Read and verified in-repo:

- **`packages/supabase/migrations/001_foundation.sql`** — `organizations` is the tenant table. `get_org_id()` = `(request.jwt.claims->>'org_id')::uuid`, and `org_isolation` RLS policies key every table to it. **The claim is cast to `uuid`, but Clerk's native org id is a string like `org_2abc...`.** This mismatch is the crux: even if the API passed a real user JWT, Clerk's default `org_id` claim would fail the `::uuid` cast.
- **`apps/web/src/lib/api-handler.ts`** — `apiHandler`/`apiQueryHandler` call Clerk `auth()`, but (a) fall back to `userId='dev-user'`, `orgId=null` when auth throws, and (b) **always** construct `createAdminSupabase()` (service role, RLS bypassed). `ctx.orgId` is Clerk's `org_xxx` string and is *not* used to scope any query. Two `TODO: Switch back to createServerSupabase()` markers acknowledge the debt.
- **`apps/web/src/lib/supabase/server.ts`** — `createServerSupabase()` (anon key, cookie-based, RLS respected) exists but is unused by the API; `createAdminSupabase()` (service role) is what every route gets.
- **`apps/web/src/app/api/**`** — 49 route files match `from('organizations') … limit(1)`. They resolve the tenant as "first row," e.g. `apps/web/src/app/api/me/route.ts` lines 16–20. Because there is **no `clerk_org_id` column**, the Clerk `org_xxx` string cannot be used against the UUID PK even if a route wanted to.
- **`apps/web/src/test/tenant-isolation.test.ts`** — pins the offender count at `FIRST_ORG_LOOKUP_BUDGET = 49`, a ratchet that may only go down. It also asserts the public `/api/pay` surface is token-scoped and must never regress to first-org lookup.
- **`packages/supabase/migrations/014_rbac_permissions.sql`** — `employees.clerk_user_id (text)`, `employees.role (text)`, `employee_locations` (which employee sees which location/company), `role_permission_overrides` (3-layer RBAC: system default → tier override → individual override). RLS on these also keys to `get_org_id()`.
- **`apps/web/src/lib/rbac/permissions.ts`** — 9 roles today (`company_admin`, `cfo`, `merit_controller`, `assistant_cfo`, `accounting_manager`, `accounting_specialist`, `check_processor`, `general_admin`, `business_user`), each with a `companyScope` (`all` / `portcos_and_3rdparty` / `assigned` / `own_company`) and a feature-permission map. **There is no platform-admin role today.**

**Critical modeling fact to reconcile:** MeritBooks' 17 portfolio companies are currently modeled as **`locations` inside one `organizations` row** (Merit Management Group). "Organization" already means *tenant*, and "location" means *company within a tenant*. This is correct and we keep it. The new multi-tenancy is a layer *above* this: **many tenant orgs** (Merit Management Group is one of them; each outside merchant is another), with a user↔org membership layer and a platform-admin role that can cross tenants.

---

## 5. Identity Data Model

We introduce a first-class identity layer and reconcile it with `employees`/`employee_locations`.

### 5.1 New tables (in the `core` schema)

**`core.users`** — one row per human, keyed to Clerk.
- `id uuid pk`
- `clerk_user_id text unique not null` — Clerk `user_xxx`
- `email text`, `first_name text`, `last_name text`
- `is_platform_staff boolean not null default false` — a coarse gate that a row *can* hold platform roles; the actual authority is the membership role, not this flag (see §8 for why this is not a super-user switch)
- `created_at`, `updated_at`

**`core.memberships`** — the many-to-many spine: user ↔ org ↔ role.
- `id uuid pk`
- `user_id uuid not null references core.users(id) on delete cascade`
- `org_id uuid not null references core.organizations(id) on delete cascade`
- `role text not null` — from the role set in §5.3
- `status text not null default 'active'` — `active` / `invited` / `suspended`
- `clerk_org_membership_id text` — mirror of Clerk's membership id for reconciliation
- `invited_by uuid references core.users(id)`, `created_at`, `updated_at`
- `unique (user_id, org_id)` — one role per user per org (role escalation is an update, not a second row)

**`core.membership_locations`** (supersedes `employee_locations`, see §5.4) — which locations within an org a membership may access.
- `id uuid pk`
- `membership_id uuid not null references core.memberships(id) on delete cascade`
- `location_id uuid not null references core.locations(id) on delete cascade`
- `unique (membership_id, location_id)`

**`core.platform_admin_sessions`** (audit spine for cross-org access, see §8).
- `id uuid pk`
- `user_id uuid not null references core.users(id)` — the platform admin
- `target_org_id uuid not null references core.organizations(id)`
- `reason text` — support ticket / fee change reference
- `started_at timestamptz not null default now()`, `ended_at timestamptz`
- `created_at`

### 5.2 What this replaces vs. keeps

- **`employees`** stays as the *HR/payroll* record (labor_type, comp, FICA/WC/benefits, department, chargeback fields). It is **not** the identity record. We keep `employees.clerk_user_id` as an optional link so an employee row can point at its `core.users` row, but authentication and access decisions move to `core.users` + `core.memberships`. Rationale: an outside accounting-firm user or a Merit platform operator is a *user with a membership* but is **not** an employee of the merchant and must never appear in payroll math.
- **`employee_locations`** is **superseded** by `membership_locations`. Access scoping belongs on the membership, not the HR record. Migrate existing `employee_locations` rows to `membership_locations` by joining `employees.clerk_user_id → users → memberships` (see §10).

### 5.3 Role set (recommendation)

Keep the 9 existing merchant-facing roles unchanged (they are org-scoped and already wired into `permissions.ts`). Add **two platform-scoped roles**, valid only in the platform org:

| Role | Scope | Purpose |
|---|---|---|
| `platform_admin` | Platform org; may cross into any merchant org via §8 | Set Layer-1 fees, full support access, manage platform users |
| `platform_support` | Platform org; read-mostly cross-org via §8 | Troubleshoot without fee/settings write authority |
| *(existing 9)* `company_admin` … `business_user` | Single merchant org | Unchanged; membership-scoped |

The minimum viable set the human asked to see spelled out: **`platform_admin`, `org_admin` (= existing `company_admin`), `member` (= any of the existing non-admin merchant roles).** We recommend keeping the richer 9-role merchant taxonomy rather than collapsing to `member`, because `permissions.ts` and migration 014 already depend on it and it encodes real separation-of-duties (e.g. `check_processor`). "member" is a useful *conceptual* bucket, not a stored value.

**Role authority is never a boolean super-user flag.** `platform_admin` is a role recorded on a membership to the *platform org*. Cross-org power is granted by the §8 mechanism, not by the role alone.

### 5.4 Relationship diagram (textual)

```
core.users (clerk_user_id) ──< core.memberships >── core.organizations
                                     │                     │
                                     │                     └──< core.locations (the 17 companies live here)
                                     │
                                     └──< core.membership_locations >── core.locations

core.employees (HR/payroll only) ── optional link ──> core.users
core.role_permission_overrides ── keyed by (org_id, role[, employee_id]) ── RBAC layers 2 & 3
core.platform_admin_sessions ── audit of cross-org access
```

---

## 6. Clerk ↔ MeritBooks Org Mapping  *(THE central technical decision)*

**The problem restated:** Clerk's active-org claim is a string `org_xxx`. `get_org_id()` expects a `uuid`. There is no bridge today.

### 6.1 Options considered

- **(A) Change `get_org_id()` to read a string and store `clerk_org_id text` on `organizations`; key all RLS to the string.** Rejected: it re-types every `org_id uuid` foreign key across ~20 migrations, or forces a join in every policy. Enormous blast radius.
- **(B) Look up the UUID at request time** (`select id from organizations where clerk_org_id = <claim>`) and set it as a Postgres session variable. Works, but adds a round-trip and a place to forget; the DB still can't self-defend if a route skips the lookup.
- **(C — RECOMMENDED) Emit the MeritBooks UUID *as a custom claim* in a Clerk JWT template, so `request.jwt.claims->>'org_id'` is already the `core.organizations` UUID.** `get_org_id()` stays exactly as written (`::uuid` cast succeeds). No schema-wide retyping. The DB is the enforcement point.

### 6.2 Recommended mechanism (C), concretely

1. **Store the mapping in Clerk org metadata.** Each Clerk organization carries `public_metadata.meritbooks_org_id = "<uuid>"`. This is the source of truth Clerk emits from. **[HUMAN]** or via a provisioning endpoint (below).
2. **Add a Clerk JWT template** (the Supabase-conventional name is `supabase`, or a dedicated `meritbooks` template) whose claims include:
   ```
   {
     "org_id":  "{{org.public_metadata.meritbooks_org_id}}",
     "role":    "{{org_membership.role}}",
     "user_id": "{{user.id}}"
   }
   ```
   **[HUMAN] — Clerk dashboard step the engineer cannot do:** create this JWT template and confirm the Supabase JWT signing key/JWKS is registered with Clerk (Clerk-as-Supabase-third-party-auth, or a shared signing secret). Without this, `createServerSupabase()` carries no usable claims and RLS denies everything.
3. **`get_org_id()` is unchanged.** It reads the emitted UUID. We add a companion `get_clerk_user_id()` (`request.jwt.claims->>'user_id'`) and `get_active_role()` for RBAC.
4. **Keep the mapping column too, for provisioning and reconciliation:** add `organizations.clerk_org_id text unique`. It is *not* what RLS reads (the JWT claim is), but it is how we (a) create the Clerk org when a merchant is onboarded, (b) reconcile drift, and (c) resolve a target org for platform-admin actions.

**Why (C) is correct:** it is the canonical Clerk-Organizations + Supabase-RLS pattern. The database remains the single enforcement point, the existing `uuid` schema is untouched, and the claim is signed by Clerk (not client-settable). The one-time cost is entirely Clerk-side configuration, which is where multi-tenant SaaS on this stack always puts it.

### 6.3 Provisioning flow (merchant onboarding)

When a new merchant is created: (1) insert `core.organizations` row → get UUID; (2) create the Clerk organization via API; (3) write `public_metadata.meritbooks_org_id` and store `clerk_org_id` back on the row; (4) create the owner's `core.users` + `core.memberships(role='company_admin')`. This replaces the `/api/setup` first-org auto-admin hack in `me/route.ts` (lines 42–88).

---

## 7. Request-Scoped Access

**Recommendation: convert the API to `createServerSupabase()` carrying the user's Clerk JWT, so RLS is the enforcement mechanism.** Do *not* keep resolving an explicit `orgId` in application code as the primary defense — that is the pattern that produced the 49 first-org lookups.

Concretely:

1. `apiHandler`/`apiQueryHandler` obtain the Clerk session token minted from the JWT template (§6.2) and construct a Supabase client that sends it as the `Authorization: Bearer` header (Clerk's `getToken({ template })` → passed into `createServerClient` global headers). Every query then runs *as the user*, `request.jwt.claims` is populated, and `get_org_id()` returns the active-org UUID.
2. `ApiContext` exposes `orgId: string` (the resolved MeritBooks UUID from the verified claim, not Clerk's `org_xxx`) and `role`. Handlers may read `ctx.orgId` for convenience, but **RLS is what actually prevents cross-tenant reads/writes** — a handler that forgets to filter is still safe.
3. `createAdminSupabase()` is retained but demoted to an explicit, named escape hatch (webhooks with no user, cross-org platform actions in §8, system jobs). Its use should be greppable and few.

**Why RLS-primary over orgId-in-code:** an explicit-orgId approach re-implements tenant isolation in 100+ handlers and is one forgotten `.eq('org_id', …)` away from a leak — exactly today's failure mode at scale. RLS makes isolation a property of the database, tested once, enforced everywhere.

---

## 8. Platform-Admin Cross-Org Path

Platform admins must act inside merchant orgs (support, Layer-1 fee setting) **without** getting a super-user client that silently bypasses RLS everywhere.

**Recommended mechanism — "assume org," audited:**

1. A platform admin (verified: has an `active` membership with role `platform_admin`/`platform_support` in the **platform org**) calls an explicit endpoint, `POST /api/platform/assume-org`, with `target_org_id` and a `reason`.
2. The server verifies platform-admin authority, then **opens a `core.platform_admin_sessions` row** (who, target, reason, `started_at`).
3. For the duration, the platform admin's requests to that org are served by a **scoped admin path**: either (a) mint a Clerk token whose `org_id` claim is set to the target org (if Clerk actor-tokens/impersonation is configured) — **[HUMAN]** Clerk config — or (b) a server-side path that uses `createAdminSupabase()` **but always writes/reads with `org_id = target_org_id`** and is only reachable after the session row exists.
   - **Recommendation:** prefer (a) so RLS still enforces the boundary and the admin literally cannot touch a *third* org by accident. Use (b) only if Clerk impersonation is unavailable, and gate it behind the session check.
4. `platform_support` gets read-only variants; only `platform_admin` may write fee schedules / settings.
5. `ended_at` is set on explicit exit or session timeout. **Every mutation performed under an assume-org session is stamped with the session id** so the audit trail answers "which platform admin changed this merchant's fees, when, and why."

**Separation of the two fee layers falls out of this:** Layer-1 platform fees (`merchant_fee_schedules`, migration 057; `platform_fee_income`, migration 052) are writable **only** under a `platform_admin` assume-org session. Merchant roles — even `company_admin` — cannot set their own platform pricing. Merchant-operational fees remain merchant-writable. Identity, not convention, keeps them apart.

---

## 9. RBAC Integration

- **Role source of truth moves to `core.memberships.role`.** The JWT emits it (`{{org_membership.role}}`), and `get_active_role()` exposes it to policies that need row-level *action* checks. `employees.role` is retained only for legacy reads during migration, then dropped.
- **`role_permission_overrides` (migration 014) is unchanged in shape** and keeps working: Layer 1 = `permissions.ts` defaults, Layer 2 = tier overrides (`employee_id IS NULL`), Layer 3 = individual overrides. We reinterpret its `employee_id` column as "the membership's linked user/employee" during migration; long-term it should point at `membership_id`, but that is a follow-up refactor, not a blocker (call it out in §16).
- **Location scoping** (`companyScope` in `permissions.ts`) is enforced by joining `membership_locations`; `company_admin`/`cfo`/`merit_controller` (`companyScope='all'`) see every location in *their* org; `assigned` roles see only their `membership_locations`. Platform roles are org-crossing via §8, not via `companyScope`.
- **Platform roles are added to the role taxonomy** but marked platform-only so they never appear in a merchant's user-management UI.

---

## 10. Migration Path for the 49 Routes (drive the ratchet to 0)

The `FIRST_ORG_LOOKUP_BUDGET = 49` ratchet is the project plan. Sequence:

1. **Unblock the foundation (no route changes yet):** land the JWT template **[HUMAN]**, `organizations.clerk_org_id`, `core.users`/`core.memberships`/`core.membership_locations`, and the request-scoped client in `api-handler.ts`. Backfill: create one Clerk org for Merit Management Group, one membership per existing `employees.clerk_user_id`, migrate `employee_locations → membership_locations`.
2. **Flip `api-handler` to `createServerSupabase()` with the user JWT** behind a feature flag; verify `get_org_id()` resolves for a real session in staging.
3. **Convert routes in waves**, lowest-risk first. Each conversion deletes the `from('organizations').limit(1)` block and relies on RLS + `ctx.orgId`. After each wave, **lower `FIRST_ORG_LOOKUP_BUDGET`** to the new count so the ratchet locks in progress. The test already prints the new count to make this mechanical.
4. **Priority ordering:** (a) money-movement and posting routes (`bank-feed/approve`, `bills/create`, `journal-entries`, `year-end-close`) first — highest blast radius; (b) reporting/read routes; (c) settings/admin. Keep `/api/pay` (public, token-scoped) exactly as-is; the test guards it.
5. **`/api/me` and `/api/setup` are rewritten**, not converted: they stop auto-creating a "first org" admin and instead read the caller's memberships (§6.3).
6. **Definition of done for the ratchet:** `FIRST_ORG_LOOKUP_BUDGET = 0`, and a new test asserts every authenticated route runs under `createServerSupabase()` (grep for `createAdminSupabase` outside the named escape-hatch allowlist).

---

## 11. Security Edge Cases & Threat Model

| Case | Risk today | Mitigation |
|---|---|---|
| **`dev-user` auth fallback** (`api-handler.ts` L23/L84) | A failed/absent Clerk session silently proceeds as a fake user with a service-role client — effectively unauthenticated admin access. | **Remove the fallback.** No session ⇒ `401`. A dev-only bypass, if kept at all, must be gated on `NODE_ENV !== 'production'` **and** an explicit env flag, and must never mint a service-role client. |
| **User with no active org** | `orgId=null` today just flows through to first-org. | Return `409 NO_ACTIVE_ORG` and route the client to an org-picker. `get_org_id()` returns null ⇒ RLS denies all ⇒ safe by default. |
| **Platform admin accidentally acting in merchant context** | No such role today; when added, risk is writing to the wrong org. | Assume-org session is explicit and single-target; prefer Clerk-token impersonation so RLS still pins the one target org; every mutation stamped with session id. |
| **JWT claim spoofing** (client sets its own `org_id`) | If we ever read org from the request body/header, trivially forgeable. | Org is read **only** from the Clerk-signed JWT claim (§6). Verify Clerk's JWKS/signing key is registered with Supabase so unsigned/foreign tokens are rejected. Never accept `org_id` from client input. |
| **RLS never actually in force** (current reality) | Service-role client bypasses RLS on 100% of the API surface. | §7 conversion + the "no `createAdminSupabase` outside allowlist" test. Add a staging smoke test that a second seeded org's rows are invisible. |
| **Membership revoked but token still valid** | Stale access until token expiry. | Short token TTL from the template; check `membership.status='active'` in a policy helper for sensitive writes. |
| **Cross-schema leak** | Some routes call `.schema('core')`, some don't; RLS must cover both. | Confirm every tenant table has an `org_isolation` policy and RLS enabled; add a migration test enumerating tables missing a policy. |

---

## 12. Benchmark — How Real Multi-Tenant SaaS Does This

The reference implementation for **Clerk Organizations + Supabase RLS** is well-established, and this design matches it point for point:

- **Clerk owns identity, orgs, and memberships**; the app does not reinvent user/org tables for auth — it *mirrors* them (`core.users`, `core.memberships`) for joins and audit. ✔
- **A Clerk JWT template emits tenant + role as custom claims**, and Supabase is registered as a Clerk third-party auth provider (or shares the signing key) so those claims are trusted. ✔ (§6)
- **Postgres RLS is the single enforcement point.** Every tenant table has a policy `org_id = get_org_id()`, and the app runs queries *as the user* via the anon/SSR client carrying the user token — never the service-role key for normal traffic. ✔ (§7)
- **Service-role is a narrow, audited escape hatch** for webhooks and system jobs, not the default client. ✔
- **Active-org switching is a Clerk concept** (`setActive`), and the app derives its scope from the resulting token, never from client-supplied ids. ✔
- **Cross-tenant staff access is explicit and logged**, typically via impersonation/actor tokens, not a god-mode flag. ✔ (§8)

**What makes this design correct, specifically:** isolation is a property enforced by the database on every query, the tenant id is cryptographically bound to the session by Clerk's signature, and elevated (platform) access is a separate, audited path rather than an ambient capability. A forgotten `where` clause cannot leak data; a forged request cannot assert an org; a support action cannot happen unlogged.

---

## 13. Acceptance Criteria (testable)

1. **Provable isolation:** with two seeded orgs A and B, a user whose active org is A receives **zero** rows belonging to B across every authenticated GET, and every write attempt targeting B fails with an RLS denial. Automated in an integration test that seeds both orgs.
2. **JWT-derived org:** `get_org_id()` returns the correct `core.organizations` UUID for a live Clerk session (verified in staging), and returns null (deny-all) when no org is active.
3. **No first-org lookups:** `FIRST_ORG_LOOKUP_BUDGET = 0`; the ratchet test passes.
4. **No ambient admin client:** a test asserts no authenticated route imports `createAdminSupabase` outside the named allowlist.
5. **No dev-user in prod:** a test asserts the `'dev-user'` literal cannot be reached when `NODE_ENV==='production'`.
6. **Many-to-many:** a single user with memberships in 3 orgs can switch active org and see each org's data in turn, and only that org's.
7. **Platform-admin path is audited:** every platform-admin write to a merchant org produces a `platform_admin_sessions` row and stamps the mutation with its id; no cross-org write is possible without an open session.
8. **Layer separation:** a `company_admin` (merchant) cannot write `merchant_fee_schedules` / platform-fee settings; only a `platform_admin` under an assume-org session can.
9. **Location scoping:** an `accounting_specialist` assigned 2 of an org's locations cannot read the other locations' transactions.
10. **Spoof resistance:** a request supplying an `org_id` in body/header/query is ignored; org is taken only from the signed claim.

---

## 14. Rollout / Phasing

- **Phase 0 — Foundation (no behavior change):** new identity tables, `clerk_org_id` column, JWT template **[HUMAN]**, Supabase↔Clerk trust **[HUMAN]**. Backfill Merit Management Group as org #1 with memberships.
- **Phase 1 — Request scoping behind a flag:** `api-handler` mints user-scoped clients; validate `get_org_id()` in staging; keep first-org fallback only until a route is converted.
- **Phase 2 — Route conversion waves:** money/posting → reporting → settings; lower the ratchet after each wave; rewrite `/api/me` and `/api/setup`.
- **Phase 3 — Platform admin:** add `platform_admin`/`platform_support` roles, `assume-org` endpoint, audit table, fee-layer gating.
- **Phase 4 — Harden:** remove `dev-user`, allowlist-guard `createAdminSupabase`, add missing-policy and isolation smoke tests, ratchet to 0.

---

## 15. Out of Scope

- SSO/SAML/SCIM, custom auth providers.
- Refactoring `role_permission_overrides.employee_id → membership_id` (follow-up; §9 keeps it working meanwhile).
- Billing/settlement of Layer-1 fees (this module only decides *who may configure* them).
- Merchant self-service org creation UI (onboarding wizard is a separate module; §6.3 defines the provisioning contract it will call).
- Data residency / per-tenant encryption keys.

---

## 16. Open Decisions & Required Human Actions

**[HUMAN] — Clerk dashboard steps the engineer cannot perform:**
1. **Create the JWT template** emitting `org_id = {{org.public_metadata.meritbooks_org_id}}`, `role = {{org_membership.role}}`, `user_id = {{user.id}}` (§6.2). Nothing works until this exists.
2. **Register Supabase as a Clerk third-party auth integration** (or configure the shared JWT signing key/JWKS) so Supabase trusts Clerk-issued tokens. This is what makes `createServerSupabase()` + RLS function.
3. **Decide on Clerk impersonation / actor tokens** for the platform-admin assume-org path (§8). If unavailable on the current Clerk plan, we fall back to the gated service-role variant — confirm which.
4. **Enable Clerk Organizations** on the instance and confirm the org-switching (`setActive`) UX is turned on.

**Product decisions still needed:**
- Confirm the platform role split: is `platform_support` (read-only) wanted at launch, or just `platform_admin`?
- Assume-org session timeout duration and whether a `reason` is mandatory.
- Whether outside accounting firms are modeled as their *own* org with memberships into client orgs, or purely as users with direct memberships into each client org (recommend the latter for simplicity; the former only if firms need their own internal settings).
- Token TTL vs. revocation latency tradeoff for suspended memberships.

**Engineering decisions to confirm:**
- The `createAdminSupabase` escape-hatch allowlist (webhooks, cron, assume-org) — enumerate and freeze it.
- Whether to keep `organizations.clerk_org_id` as the reconciliation column (recommended) even though RLS reads the claim.
