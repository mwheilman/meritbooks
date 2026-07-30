# MeritBooks — Session 39 Handoff

**Date:** 2026-07-29
**Supersedes:** session 38. Use this as the current source of truth for build state.
**Companion:** `docs/NORTH-STAR.md` (the product spine, written this session) and
`docs/FPB-tenant-model-consolidation-analytics.md`.

---

## 1. Headline

The security **NO-GO gate is effectively closed**: tenant isolation is now enforced
by the database (RLS) across the authenticated API, proven end-to-end in the browser.
On top of that, three dashboard/settings bugs were fixed, a **context switcher**
(Platform / Practice / Book-of-Record) shipped, and the product **north star** was
written and sharpened with Mike: MeritBooks is an **autonomous accounting workforce**
— AI does the bookkeeping labor, staff supervise it, leaders see it's done right.

---

## 2. What shipped this session (all merged to `main`, verified live)

- **RLS enforcement / route conversion.** New `createAuthedSupabase(token)` +
  `requireAuthedContext()` + `createAuthedServerSupabase()`. `apiHandler`/`apiQueryHandler`
  and ~44 raw routes now run **as the user** (Clerk session token → `org_id` claim →
  `get_org_id()` → `org_isolation` RLS). First-org ratchet **49 → ~4** (only `setup`
  bootstrap + 3 `events/*/process` workers remain, deliberately on the service role).
  Pre-verified against prod DB (grants, policies, security_invoker views, reference
  tables) and smoke-tested in Chrome (customers/vendors/invoices/reconciliation/
  dashboard/settings all org-scoped).
- **Clerk↔Supabase integration is LIVE (dev instance).** Session token carries
  `role: authenticated` + `org_id: <MeritBooks org uuid>`. Supabase third-party auth
  provider = Clerk enabled.
- **Three bug fixes (found + fixed + verified in-browser):** settings save 422
  (time HH:MM:SS vs HH:MM regex + numeric-as-string; GET normalizes, schema coerces);
  dashboard KPI cards $0 (server actions used the anon client — now `createAuthedServerSupabase`);
  dashboard activity feed empty (locations is in `core` schema, bank_transactions in
  `public`, so the PostgREST embed 400'd — replaced with a two-step `core.locations` lookup).
- **Context switcher** (`lib/planes.ts`, `use-plane.tsx`, `plane-switcher.tsx`,
  `AppProviders`, sidebar/header/nav changes, `/platform` placeholder). Reshapes the
  sidebar per plane, gated by role + `is_platform_staff`. **Note:** MeProvider was
  defined but never mounted — now mounted, so `useMe()` actually resolves identity.
- **Housekeeping:** `postEntry` dedup (shared `postMoneyMovementEntry`); `*.tsbuildinfo`
  gitignored + untracked; **Chrome Auditor agent** added (8th agent — in-browser QA).
- **Docs:** `NORTH-STAR.md`; `FPB-tenant-model-consolidation-analytics.md` (tenant
  model, consolidation, analytics, planes, delegated RBAC).

---

## 3. Data changes applied directly to prod (NOT in migrations — reproducibility gap)

Seeded via SQL editor / MCP, not captured in a migration or seed file. If the DB is
reset these vanish; the durable fix is auto-provisioning (see §5):

- `core.users` for Mike (`clerk_user_id = user_3BwDOygB7TuYWcrUUt87GOVvQV1`,
  `is_platform_staff = true`).
- `core.memberships` (Mike ↔ org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`, role `owner`).
- `core.membership_locations` (all 3 companies).
- `core.employees` for Mike (`company_admin`) — because the app's role system reads
  `employees`, not the new identity tables (see the fork in §5).

Key ids: org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`; Supabase project `npqeijipggtuduhkejxq`;
Clerk user `user_3BwDOygB7TuYWcrUUt87GOVvQV1`; Vercel team `team_2EwoHwR0BcH6GNjMjCbMaVAW`,
project `meritbooks-web`.

---

## 4. Open items — DO NOT FORGET

### Mike's manual to-dos (Claude can't do these)
- [ ] **Rotate the Resend API key** leaked in chat (can send email as the domain). Security.
- [ ] **Clerk production instance** + JWT template + register Supabase — for go-live (dev works now).
- [ ] Confirm **Clerk sign-up restrictions** (sign-up is ON on dev).
- [ ] The recurring `git push` at checkpoints (only manual gate Claude can't remove).

### Security task #9 remainder (isolation done; these are non-blocking)
- [ ] Roll the RBAC `requirePermission` guard across the money routes (only `gl/post` guarded).
- [ ] `events/{progress,dept-invoice,billing}/process` still resolve first-org → need
      real per-event org resolution.
- [ ] `PLATFORM_ORG_ID` unset → MeritBooks' own platform-fee revenue doesn't post.

### Identity debt (foundational to the next build)
- [ ] **Reconcile the two role systems.** App reads `core.employees`; the switcher reads
      `core.users`/`memberships`. Migrate onto the new identity layer + **auto-provision**
      users/memberships on login so no more hand-seeding. Captures §3 as reproducible.
- [ ] **Location-scoped RLS** (per-client fiduciary isolation) — specced (FPB §7.1), not built.

### Code hygiene (Reviewer queue, optional)
- [ ] Split the 318-line invoice-drawer; fix an index-as-key bug; extend `apiHandler`
      to forward route params.

### Design (deferred by Mike)
- [ ] Iterate the context-switcher visuals; broader redesign later.

---

## 5. Direction (from the north star) — what's next

Per `NORTH-STAR.md`: the product is the **autonomous engine + supervision/trust layer**;
the UI is how you run it. Build **depth-first, one pipeline at a time**.

**Next section to finish (the real inflection point):**
1. **Team management** — invite → role → company access (also reconciles the identity
   fork + auto-provisioning above).
2. **Trust primitives** — action/audit log with machine-vs-human attribution; confidence
   tiers (auto/review/escalate); approval gates. Reused by every pipeline.
3. **Exception & approval queue** — the human's daily surface. Reused by every pipeline.
4. **First pipeline end-to-end: AP inbox → posted, attached, audited bill** (highest
   manual-labor drain; exercises the whole trust pattern; includes vendor auto-create).

**Execution model (to reduce Mike's screen time):** Claude specs, builder subagents build
in parallel, verifier/reviewer + Chrome-auditor verify; background/remote agents for big
chunks; scheduled tasks for recurring status. Mike's role shrinks to approvals, judgment
calls, the dashboard steps Claude can't do, and the checkpoint `git push`.

---

## 6. Agents

Eight in `.claude/agents/`: builder, verifier, auditor, reviewer, designer, scribe,
security, **chrome-auditor** (new — in-browser QA, never hands the user a click-through).

---

## 7. Live state

- Production: `main` @ `ec79c4f` (+ the north star/handoff commit pending push).
- Clerk↔Supabase integration active on the **dev** Clerk instance.
- All money/isolation/UI work verified in the branch preview before merge.

---

## 8. Update — later 2026-07-30 (foundation build, agent-driven)

Shipped and merged to `main` after this handoff was first written (spec → agent → central verify → push loop; browser-verified where user-facing):

- **Team & Access** (Practice plane): add/edit/deactivate members with role + company
  access on the `employees` system (drives real access); invite-claim in `/api/me`
  (pre-added member links to their Clerk login by email on first sign-in). Verified.
- **Trust layer** (migrations 062/063, applied to prod): `core.action_log` (append-only,
  machine-vs-human `actor_type`, confidence/tier, RLS immutable), the Clerk→`core.users`
  identity bridge (`resolveActor`, self_provision/self_update policies) that makes
  attribution real, `logAction`/`logHumanAction`, `/api/me` syncs name/email, and the
  **Audit Trail** page (`/audit`, Practice). Team routes log HUMAN actions. Verified:
  a team action shows in the audit trail as "Mike Heilman · Human".
- **Confidence-tier engine** `lib/trust/score-tier.ts` (`scoreToTier` pure + tested 7/7;
  `getTierPolicy` reads the real org thresholds) — makes auto/review/escalate real.
- **Unified exception queue** `/exceptions` "Needs Attention" (Process): folds the six
  fragmented sources (flagged bank/receipt/bill + `ai_decisions` PROPOSED + `approvals`
  PENDING + `job_cost_attributions` PENDING) into one list with source/confidence badges.
- **First AI-logged action**: `categorization.suggestCategory` now logs an `AI`
  action with its confidence + tier — the `AI` badge lights up in the audit trail as
  categorization runs.

**Revised next steps (north-star build path):**
- Wire `scoreToTier` into the actual posting/approve decision (so high-confidence items
  auto-post and the rest land in the queue), not just logging.
- Add resolve/approve actions to the exception queue (the `approvals`/`ai_decisions`
  engines have the state machines; give them the queue actions + UI).
- Then the **AP inbox pipeline** (ingest email → extract → vendor auto-create → post →
  attach → tier → queue) as the first full autonomous pipeline.
- Still open from §4: reconcile employees↔memberships + auto-provisioning; RBAC guard
  rollout; event-worker org resolution; PLATFORM_ORG_ID; Resend key rotation; Clerk prod.
