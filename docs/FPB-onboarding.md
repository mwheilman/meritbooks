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
