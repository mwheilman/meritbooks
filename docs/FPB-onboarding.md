# FPB — Onboarding ("the easiest onboarding in the world")

**Status:** authored 2026-10-16 (session 51). Governs all onboarding build work. Supersedes the build
direction in `ONBOARDING-DESIGN-SPEC.md` / `ONBOARDING-VISION-AND-PLAN.md` where they conflict.
Inputs: friction audit of the shipped wizard (9 hard blockers B1–B9) + best-in-class research
(Digits, Puzzle, Ramp, Stripe, Gusto, MMC Convert, Intuit batch migration, Rillet, Campfire).

## 1. The promise

> **"Connect or drop what you have. We build your books. You approve them."**

A new owner should never be asked something the system could find out, never have to know
accounting words, never re-upload a file, and never hit a dead end. AI proposes, a human approves,
the deterministic engine posts — that rule does not change.

**Targets**
- Single company leaving QuickBooks: **≤ 20 minutes of human time, live the same day.**
- 17-company portfolio: **first entity live in a day, all live in ~2 weeks, ≤ 6 hours of human time.**
- Zero support tickets required to reach "live" on the happy path. Zero hard dead ends.

## 2. Design principles (each is an acceptance test)

1. **One front door.** Sign-in → `/` router → the user's next unfinished thing. No second wizard.
2. **Fetch, don't ask.** Prefill from QBO, formation docs, EIN letters, the TB itself. Ask to *confirm*.
3. **Two decisions only, both defaulted:** *when we take over* (cutover = last day of the prior
   month) and *how much history* (default: opening balances; history optional). Plain-English copy.
4. **Accept files as they come.** `.xlsx`, `.csv`, PDF; QuickBooks title rows; blank headers.
5. **Drop everything.** One drop zone takes any pile of documents, sorts them, and carries each file
   into the right parser — never "now go re-upload it over there."
6. **Proof is the product.** Tie-out grid + Conversion Certificate. Every blocker shown *before* the
   attestation, in dollars, never cents.
7. **Never fake it.** No sample/fixture data can reach a real company's books in production. Skipped
   steps are shown as skipped, not done.
8. **Delegate anything.** Every step has "Invite my bookkeeper to finish this" — and the invite
   actually emails a working link.
9. **Many companies = one motion.** Bulk create, multi-file TB drop, shared cutover, Control Tower.
10. **Works with AI off.** Every AI path has a deterministic fallback (filename rules, CSV, manual).

## 3. The target journey (single company)

| # | Human | System |
|---|---|---|
| 1 | Signs in | Router → onboarding (per-company state) |
| 2 | "Where do your books live?" → QuickBooks (Connect) **or** Drop files | OAuth read-only pull **or** Smart Intake |
| 3 | Confirms a prefilled company card | Name, short code (auto), fiscal year, industry → rev-rec guessed with one plain question |
| 4 | Accepts default cutover ("MeritBooks takes over Oct 1 — everything before stays as it was") | Periods before cutover created **SOFT_CLOSE** (postable), never HARD_CLOSE |
| 5 | Reviews only low-confidence account matches (bulk-accept the rest) | Auto-map; dollars-only errors |
| 6 | Connects bank (or uploads a statement) | Cash at cutover checked against bank |
| 7 | Sees the readiness/tie-out view with *all* gates (incl. subledger ties) → "Approve opening books" | Posts opening entry; Conversion Certificate |
| 8 | Optional: invites bookkeeper/CPA, adds loans/customers/vendors via the setup board | Board stays reachable after launch |

## 4. Blockers that MUST be fixed (from the audit)

| ID | Fix |
|---|---|
| B1 | New companies: pre-current-month periods = SOFT_CLOSE (not HARD_CLOSE). Cutover default = last day of prior month. Conversion post auto-generates the cutover year's periods if missing. |
| B2 | QBO/Xero/Sage tiles: real QBO OAuth pull when `QBO_CLIENT_ID/SECRET` set; otherwise "Export from QuickBooks in 60 seconds" guided path (exact report names) → upload. Never a dead "not connected." |
| B3 | Fixture/sample data never offered in production for a real company; posting refuses sample-sourced sessions. |
| B4 | Wizard team step uses the real emailing invite flow; `/sign-up` page exists; invitee lands on the tour. |
| B5 | `/setup` folded into the wizard (or its team entries persisted & invited). |
| B6 | Sign-in redirects to `/`; dashboard redirects first-run users to onboarding. |
| B7 | `/api/setup` resolves the caller's org (no first-org-in-DB). |
| B8 | Review screen shows extended (subledger) blockers before "tied out." |
| B9 | "Existing loan" mode: current balance as of cutover, **no origination entry** (the opening TB already carries it). |

## 5. Shared contracts between build slices

**`apps/web/src/lib/companies/create-company.ts`** (owned by slice W5; used by W2's `/api/setup`):

```ts
export interface CreateCompanyInput {
  orgId: string; name: string; shortCode?: string | null; industry?: string | null;
  fiscalYearStartMonth?: number; revRecMethod?: string | null;
}
export type CreateCompanyResult =
  | { ok: true; locationId: string; shortCode: string; periodsCreated: number }
  | { ok: false; error: string; status: number };
export function deriveShortCode(name: string, taken: Set<string>): string;
export async function createCompany(db: SupabaseClient, input: CreateCompanyInput): Promise<CreateCompanyResult>;
```
Creates the location + prior/current/next-year fiscal periods with **prior months SOFT_CLOSE**,
current/future OPEN — the single company-creation path (settings/entities, setup, portfolio, import).

**`apps/web/src/components/onboarding/invite-helper.tsx`** (owned by W4; mounted by W2):

```tsx
export function InviteHelper(props: {
  context: string;            // e.g. "Opening balances for Heritage Interiors"
  companyId?: string | null;
  defaultRole?: string;       // must be a role that can run onboarding
  compact?: boolean;          // inline link vs card
}): JSX.Element;
```

**Smart Intake handoff** (W3): a classified file is passed onward by **storage path**
(`intake/{orgId}/…`, via `uploadForParse`) in the query string `?intake=<storagePath>` or by direct
in-page handoff — the receiving parser reads it with `resolveUploadedFile`. Never re-upload.

## 6. Acceptance criteria (Rule 3)

- Each new/changed screen renders loading / empty / populated / error; keyboard reachable; design system.
- All data from real Supabase queries, org-scoped (`.eq('org_id', orgId)`), RLS client by default.
- Every write route: `requireAuthedContext` + `requirePermission` + fail-closed org.
- No `any`. `tsc --noEmit` clean. New logic has Vitest coverage.
- No jargon on the happy path without a one-line plain-English explanation.

## 7. Build slices (session 51)

- **W1 Conversion that just works** — B1 (conversion side), B8, xlsx/title-row TB intake, cutover default + plain copy, prefill company/date from wizard, bulk-accept mapping, dollars in errors.
- **W2 One front door** — B5, B6, B7, honest progress/launch, per-company onboarding status, resume + jump to setup board, mounts InviteHelper.
- **W3 Drop everything** — Smart Intake v2: multi-file, filename/rule fallback, file handoff to parsers (TB, loans, formation, budgets, customer/vendor lists), B9 existing-loan mode.
- **W4 Never fake it + delegate** — B3, B4, InviteHelper, `/sign-up`, invite email link, tour on first login.
- **W5 Portfolio mode** — `createCompany`, bulk companies, multi-TB drop matched to companies, Control Tower.
- **W6 QuickBooks Online connect** — per-tenant OAuth (Intuit), encrypted token storage, live pull through the existing mapping seam (`providers/real.ts liveFetch`), guided-export fallback. Needs Mike: Intuit developer app keys.

## 8. Later (not this session)

Shadow (parallel) first-month close vs QBO with auto TB diff; legacy-report archive; Xero/Sage live;
inbox backfill of open bills; concierge (done-for-you) mode in the Operator Console.

## 9. Onboarding v2 — amendment (2026-10-26, Wave 4): part 1 vs part 2

Governing spec: `docs/ia/08-ONBOARDING-V2-SPEC.md` (wins on onboarding UX). Owner: "the onboarding import
wizard needs to be the most useful tool ever … so we have buy-in from accounting teams"; "use QuickBooks as
a pipe but the objective is to replace, not supplement QuickBooks". Migration **193**
(`193_onboarding_v2_migrations.sql`, OM-1/2/3/4/5/8/9/10 + a trail): one migration project per client,
waves keyed by cutover date, sources, runs + staged records, firm mapping memory, 24 preflight findings,
immutable tie-out snapshots, the Conversion Certificate (preparer ≠ approver, DB CHECK), events.

### 9.1 Part 1 (this wave) — scope

| # | Capability | Where |
|---|---|---|
| P1 | **Migration Control Tower** — clients by wave (cutover order, Unscheduled last, worst first), 8 stage tabs with plain-English one-liners + "what happens / who / done when" (tooltip, screen-reader text, disclosure remembered per person), sources, blockers in dollars, one next-step verb, preparer/reviewer, go-live; bulk set cutover / assign / check data quality; add clients; new wave; refresh | `/onboarding/migrations`, `api/onboarding/migrations` |
| P2 | **Client migration workspace** — 8-stage rail (done / now / next / skipped, never "skipped = done"), "Needs you", plan (cutover with the plain sentence + hard-close check, history depth, practice-close mode, chart strategy, lead / preparer / reviewer with SoD), sources, trail + comments | `/onboarding/migrations/[projectId]` |
| P3 | **Connect a source** — catalog of 45 systems (ledgers, field/ERP incl. ServiceTitan, Buildertrend, Innergy, simPRO, RFMS, c-Systems, Procore, Jobber, FieldEdge…; bank, payroll, spend, CRM, docs), each with an honest tier and a numbered export **recipe** (draft recipes say so); file slots recognize the export by its headers (rules only) and stage it with SHA-256 + control totals; QuickBooks Online pulls read-only when `QBO_*` creds + a connection exist, else the recipe; "QuickBooks bridge" copy for field systems that sync to QBO | `lib/onboarding/migration/{catalog,recognize}.ts`, `server/staging.ts` |
| P4 | **Smart mapping** — cascade (firm rule → crosswalk → number → name → AI capped 0.89 → you), Ready/Check/Decide bands ordered by $, hard type guard (typed reason), bulk "Accept all Ready", request account; every acceptance writes firm memory (rule + per-client evidence, conflicts, settle once); customers / vendors / items / classes matched "Already in Merit" (Books dedupe curve = the 1111 matcher's curve), in-file duplicates, link / keep both / ignore | `mapping/*`, `masters.ts`, `/onboarding/migrations/rules` |
| P5 | **24 preflight checks** — pure, AI-free, plain English + dollars + fix; blocker / warning / info / passed / not applicable (says what to drop); dispositions (fix in source / carry as one reconciling item / accept with note); client report ("what we found in your books") | `preflight/checks.ts`, `server/preflight.ts` |
| P6 | **Load & tie-out certificate** — staged TB + accepted matches → the existing conversion session (review / tie-out / post via `postJournalEntry`); open A/R / A/P through the existing importers; five ties (TB, A/R, A/P, bank vs statement after outstanding items, equity) read from posted GL **dated on/before the cutover**; preparer signs (snapshot + hash, CC-####), a different named reviewer signs off (months ≤ cutover HARD_CLOSE, ledger source archived), go-live needs an issued certificate; void with reason; PDF | `certificate.ts`, `server/certificate.ts`, `certificate-pdf.tsx` |
| P7 | **Buy-in** — per role × prior system: stays / automated / moved / new, time back from the client's own volumes (basis printed), words that changed, first-week checklist computed from real rows, report a mismatch | `/onboarding/migrations/[projectId]/team` |

### 9.2 Part 1 acceptance criteria (testable; ✓ = covered by a test in this wave)

- **P1-1 ✓** Stage labels/one-liners/done-when are exactly §5.3.1; no screen shows a storage value (`stages.test.ts`).
- **P1-2 ✓** A wave is its cutover date: a project in a wave carries the wave's date (composite FK); moving the wave's date moves its clients; one open wave per date (`onboarding-migrations-schema.test.ts`).
- **P1-3 ✓** Each stage's "done when" is its derivation; the stored stage never claims Signed off without a prepared certificate or Live without go-live (DB CHECK + `stages.test.ts`, flow test).
- **P1-4 ✓** Next step is one exact verb ("Match 38 accounts", "Fix 2 differences", "Drop 3 files") (`stages.test.ts`).
- **P1-5 ✓** Tower blocker phrase is in dollars by class; whole-dollar subtotals (format.ts `wholeDollars`).
- **P2-1 ✓** Reviewer ≠ preparer on the project (DB CHECK) and on the certificate (DB CHECK); the reviewer can't sign the proof, the preparer can't sign off (gates + flow test).
- **P3-1 ✓** Every catalog system has a recipe with ≥2 steps and ≥1 file; only QuickBooks Online and Plaid are `native_api`; the owner's six are present (`catalog.test.ts`).
- **P3-2 ✓** Dropped exports are recognized by headers with title / subtotal rows skipped and reported; control totals in exact cents; GL detail is refused with a plain reason (`recognize.test.ts`).
- **P4-1 ✓** Cascade order, confidences, bands, type guard, AI cap (`mapping.test.ts`).
- **P4-2 ✓** Second client: ≥ 80 % of balance-bearing accounts land in Ready from firm memory, no AI (AC-6) (`mapping.test.ts`).
- **P4-3 ✓** Memory recompute: majority answer, conflict flag, settled answer wins (`mapping.test.ts`).
- **P4-4 ✓** Master data: tax id / name+email auto-link, near names proposed, in-file duplicates flagged, never cross-kind (`certificate.test.ts` masters block).
- **P5-1 ✓** Exactly 24 results in order for any input; the Dorrian golden fixture reproduces the board's dollars; missing data → not applicable with what to drop (`preflight/checks.test.ts`, 71 tests).
- **P5-2 ✓** A blocker can't be "accepted"; carrying / accepting needs a ≥10-char note (DB CHECK + service).
- **P6-1 ✓** Ties read posted GL dated on/before the cutover only — a later entry never moves the proof (flow test).
- **P6-2 ✓** A pre-cutover difference blocks the proof and is named in dollars (flow test).
- **P6-3 ✓** A carried PF-01 reconciling item must match to the cent; carrying the wrong amount still shows a difference (`certificate.test.ts`).
- **P6-4 ✓** Sign-off hard-closes every month ≤ cutover, leaves later months open, archives the ledger source; go-live refused before sign-off (flow test).
- **P6-5 ✓** Snapshots and the event trail are immutable even for the service role (schema test); the certificate PDF renders (`certificate-pdf.test.ts`).
- **P7-1 ✓** Time-saved math from volumes; checklist done-ness from real counts (`certificate.test.ts` buy-in block).
- **SEC-1 ✓** Members/anon can't write any 193 table; members read their org only; client-scope policy on every client-owned table (schema test). Every route: auth → permission → org → project visible through RLS → `assertWriteScope` on writes.

### 9.3 Part 1 — deliberate limits (honest)

- QuickBooks stays **one connection per tenant** (G-ON-1, OB-1): the pull warns when the connected company's name differs from the client. The "connect the next company" loop is part 2.
- File recognition is rules-only on CSV/XLSX; PDFs go to Documents (document intelligence).
- "Practice close" (shadow close) is part 2: clean switch skips it (shown as skipped); a parallel plan must skip it with a reason before sign-off.
- History depth is recorded; monthly-history posting + the month × account grid are part 2 (part 1 proves the cutover TB).
- Permissions ride existing features until the spec's `onb.*` keys exist: view `journal_entries:view`, plan `settings_acct:edit`, work / sign proof `journal_entries:create`, sign off / go live `journal_entries:post`, settle rule `chart_of_accounts:approve`, void `close_mgmt:manage`.

### 9.4 Part 2 (next wave)

Shadow close (parallel diff + explanations), monthly history runs + undo + the month × account grid +
side-by-side reports, per-client QBO connections + connect-next loop (G-ON-1), API connectors for
field/ERP systems (07 framework), detail reference + vendor-memory learning, dimension inference (OM-6),
crosswalk OM-7 / authority matrix, mapping-set publish + versions + XLSX, magic-link client requests,
continuity balances (outstanding bank items, 1099 / payroll YTD), certificate v2 reopen with a second
approver, cross-tenant mapping patterns (opt-in).
