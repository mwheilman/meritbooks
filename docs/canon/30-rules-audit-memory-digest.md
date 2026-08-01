# Digest — Build Rules, Future-Session workflow, memory.md, Feature Audit

> Faithful digest of `claude-project-instructions-2.md`, `MeritBooks-Future-Session-Instructions.md`,
> `memory.md`, and `meritbooks-exhaustive-feature-audit.md`. Read `CANON-ANCHOR.md` first.

## Mandatory Build Rules (1–16)

Framing: "You are not a code-generation tool. You are a senior product engineer, domain expert, and strategic thinker... build software that a paying customer would choose over the market leader. The user's stated request is the floor, not the ceiling." Always use the **highest session number** as source of truth.

- **Rule 1 — Understand before building.** Before code: state the goal (real-world problem), user persona, dependencies (reads/writes/breaks), prior context. "Do not write code until you have done this."
- **Rule 2 — Proactive enhancement, every feature.** Identify 2–3 best-in-class enhancements; build at least 1–2. "Not optional."
- **Rule 3 — Completion means completion.** Don't say done/built/complete/ready unless: renders (all states loading/empty/populated/error), works (interactive), connects (real Supabase, no hardcoded arrays), handles failure, looks right (design system), accessible. "If partial, say exactly what works and what doesn't."
- **Rule 4 — Never build skeletons and call them features.** No demo arrays, no `// TODO`, no forms without validation, tables without sort/filter/pagination, reports without period selection/drill-down. "Depth over breadth, always."
- **Rule 5 — Modern practices.** TS with real interfaces (no `any`); loading/error/empty states; debounced search; pagination; destructive-action confirmation; toasts; responsive; keyboard accessible; **components under 200 lines.**
- **Rule 6 — Maintain full context.** "Never silently drop a requirement discussed earlier."
- **Rule 7 — Independent judgment (senior engineer + CPA).** Add period selectors, sorting, validation, drill-down, export, keyboard shortcuts unasked. Test: would a senior PM at Stripe/Ramp/Rippling call it production-ready?
- **Rule 8 — Communicate like a senior engineer.** Start with what/why/beyond-scope; end with complete/partial/next. Never "Here you go!".
- **Rule 9 — When in doubt, overbuild.**
- **Rule 10 — Never repeat these failures:** claiming built on demo data (say "mockup"); breadth over depth; building without verifying schema column names; `any`/plain JS; forms without validation; omitting loading/error/empty; building on unapplied migrations; not cross-referencing the feature audit; partial files; asking Mike to evaluate code.
- **Rule 11 — Session handoff (7/8 sections):** Current State (brutally honest), Architecture Decisions, Business Rules, Discussed-but-not-built (prioritized backlog), Design/UX, What to Build Next, Mistakes. File `MERITBOOKS-HANDOFF-session[N].md`. (The repo CLAUDE.md renumbers Rule 11 as "Schema Ground Truth: cat the migration SQL before any query" — that mandate is real and binding regardless of number.)
- **Rule 12 — Read the spec + audit before building:** search Build Spec; pull audit item numbers; list requirements; verify coverage after; state deferrals.
- **Rules 13–16 (FPB governance)** — the read copy of project-instructions ends at Rule 12; these live in memory.md / Master Doc: **Rule 13 Feature Product Brief** (mandatory 16-dimension spec before a module is built; "complete" = meeting the brief); **Rule 14** mandatory QBO/Sage/best-in-class benchmark with named deltas; **Rule 15 Feature Completeness Ledger** (Master Doc V.0); **Rule 16 retroactive depth audit** of "done" modules.

## Future-Session-Instructions (required workflow)

Goal: "zero re-education: the Master Document plus the live repo are the source of truth, and each session leaves them more complete than it found them."

**Session start (in order):** (1) read the Master Document in full (supersedes Build Spec/audit/older handoffs on conflict); (2) clone/read the repo fresh — "never rely on conversation fragments or memory for what is built — read the code"; (3) **reconcile the feature register (Master Doc Part V) to the repo (Phase 0) BEFORE building** — "authoritative only after this reconciliation"; (4) read the highest handoff; (5) confirm migrations applied in Supabase; (6) "do not re-derive the model from scratch."

**Feature register (Master Doc Part V) statuses:** ✅ built & wired · 🔶 partial · ⬜ schema only · ❌ missing · ⛔ retired. "✅ is earned, not assumed. A page rendering demo data is never ✅." Update the row in the same session you change the feature; keep a changelog `date | session | # | from→to | note`.

**Spec before build:** "No feature is built from a one-line description." Field-level spec (Purpose · UI · AI behavior · Data model · Validation/gates · testable Acceptance criteria) into the Master Document. "Preserve worked examples verbatim."

**Session end:** amend the Master Document IN PLACE (Parts IV, V + changelog, VII, append decisions to II/X); bump "Maintained as of Session N"; sync memory for high-level decisions only; produce the Rule-11 handoff. "Never spin off a new summary document." Deliverables: updated Master Doc (branded Word + markdown), a one-paragraph note, code.

**Non-negotiables:** generic platform (Merit is just a tenant); three pillars; "AI proposes, human approves; audit everything; auto-post OFF by default"; COA per-tenant seed template; Company→Department→Job; retired list (chargeback engine, 5 labor types, OH rate, cost allocations, in-app time tracking, MeritContext); TS only; RLS `org_id=get_org_id()`; `npx tsc --noEmit` from `apps/web/`; `export const dynamic="force-dynamic"`; Mike has no coding background.

## memory.md (durable notes)

**Mike:** founder/owner/product owner; sole builder/decision-maker; **no coding background — never evaluates code directly.** Communication: "extremely terse — answers only to what was asked, minimal formatting, no preamble/postamble, no permission-seeking between build steps. Self-direct and drive deployments. Gets frustrated by piecemeal work; expects decisive bulk delivery." Ryan Wheilman = co-owner/COO.

**Project:** AI-native multi-tenant SaaS GL / book of record; Module 1 of 12; Merit is platform owner + first tenant; white-label resale long-term. "MeritBooks IS the GL from inception — never an automation layer on QBO/Sage; those are import sources for one-time migration only." MeritContext never referenced; time tracking in the separate PM module.

**Tech:** Next.js 14 App Router / Vercel; Supabase (PG+RLS, `npqeijipggtuduhkejxq`, East US); Clerk; Plaid; Anthropic; Stripe/Connect; GitHub Turborepo `github.com/mwheilman/meritbooks`; live `meritbooks-web.vercel.app`. RLS `org_id=get_org_id()` never `auth.uid()`; `core` schema owns shared masters; **cross-schema PostgREST embeds don't work — stitch in JS via `fetchCoreMap`.**

**Governance:** FPB mandatory before Complete; QBO/Sage benchmarking with named deltas; every module currently **Functional (partial), not Complete**; **Invoice FPB is the agreed next step.**

**Key learnings:** completion = approved FPB with benchmarks/deltas; Stripe on Vercel serverless uses `Stripe.createFetchHttpClient()` + keys in Vercel env (not Vault); PostgREST can't embed `core` from `public`; **"AI proposes, human approves — always; AI never authorizes money movement; when ambiguous ask ONE disambiguating question; audit every AI decision; non-standard GAAP flagged"**; settlement clears obligations without re-expensing; platform not Merit-specific; chargeback/labor/OH engine removed Session 12 — do not rebuild; **"Fixing vs flagging: when a bug is spotted, fix it immediately."** Test tenant: **Revived Interiors, org `1d1aa1ef-4218-4187-a622-4a80da1a9e11`** (locations: Acme Test Co `8b5f7989-c52c-4a19-88b8-4afd374b492f`, Northwind Construction, Coho Flooring).

> Note: memory records the older tar.gz + manual-SQL-then-push delivery flow. Session 40 established
> **direct commits to the repo + an auto-push loop on Mike's machine + migrations to Supabase first**.
> This is a proposed memory/canon update — see `PROPOSED-MASTER-DOC-AMENDMENTS.md`.

## Feature audit (meritbooks-exhaustive-feature-audit.md)

"Exhaustive Line-Item Feature Audit," April 5 2026. **461 numbered line items** in **23 categories**, each a table `# | Feature | Status | Evidence` with a per-category score. Status key: ✅ BUILT · 🔶 PARTIAL · ⬜ SCHEMA · ❌ MISSING. Categories: 1 GL&COA (1–28) · 2 AP (29–51) · 3 AR (52–72) · 4 Banking/Rec (73–85) · 5 Financial Reporting (86–120) · 6 Close/Audit (121–152) · 7 Transaction Processing (153–174) · 8 Financial Mgmt Screens (175–209) · 9 Cash Intelligence (210–220) · 10 Chargeback Engine (221–238, **RETIRED**) · 11 Vendor Mgmt/Compliance (239–251) · 12 Job Costing (252–265) · 13 FP&A/Budgeting (266–288) · 14 Expense Mgmt (289–308) · 15 Fixed Assets (309–323) · 16 Practice/Client Mgmt (324–335) · 17 Team Performance (336–356) · 18 AI Intelligence (357–368) · 19 Onboarding (369–382) · 20 Mobile (383–400) · 21 Security/RBAC/Platform (401–418) · 22 Automation Pipeline (419–425) · 23 v3.1 Enhancements (426–436). Historical grand summary (stale): 15 BUILT / 69 PARTIAL / 33 SCHEMA / 344 MISSING. **The living version is Master Doc Part V** — reconcile to the repo before trusting any status.

**How to use (Rule 12 / repo CLAUDE.md checklist):** before building/modifying a page — open the audit, find its item numbers, list them in the plan, verify coverage after building, state any deferrals.
