# Competitive & AI Gap Analysis — October 2026

**Purpose:** what leading finance/accounting products (AI-native ledgers, incumbents, spend platforms incl. Ramp)
have that MeritBooks does not, and what to build next. Source research: three parallel research passes
(AI-native finance; Ramp + spend platforms; incumbent ERP/close/FP&A/construction) + a code-evidence inventory of
MeritBooks (2026-10-17). Vendor accuracy/automation figures are vendor claims.

## 1. Headline findings

1. **"AI proposes, human approves, engine posts" is now the industry norm**, not a differentiator. Everyone serious
   (Rillet, Campfire, Light, Digits, Numeric, Docyt, Intuit, Sage, NetSuite) uses confidence thresholds, an exception
   queue, attributed/logged agent actions, and MCP access. MeritBooks has the architecture; it now needs the
   *surfaces* competitors ship on top of it.
2. **Gushwork.ai is not a finance product.** It sells AI marketing/lead-gen agents to SMBs — including equipment
   dealers and HVAC firms. Possible marketing tool for the operating companies; not a competitor. One idea worth
   copying: a shared "business memory" every agent reads.
3. **Nume.ai** ("AI CFO", Scaleup Finance) is a read-only layer over QBO/Xero. Its multi-entity consolidation and
   proactive "watch rules" are the most holding-company-relevant features in the market. MeritBooks owns the
   ledger, so it can do everything Nume does *and* act on it.
4. **Ramp is moving into our core** (Accounting Agent, accruals, reconciliation, Ramp Stack, Receivables). For Merit,
   Ramp should own spend capture/cards/bill-pay rails; MeritBooks owns the ledger, close, consolidation and reporting.
5. **White space nobody fills:** borrower-side covenant/borrowing-base automation from the ledger (MeritBooks already
   has this — market it), construction/trades job cost *inside* a modern multi-entity AI ledger, a white-label AI
   ledger for US accounting firms, and voice.

## 2. ⚠️ Time-sensitive: the Ramp rollout

- **Do not connect Ramp to QuickBooks per entity** if MeritBooks is the target ledger. Ramp allows **one accounting
  connection per Ramp business**, and switching later drops historical codings unless backed up.
- **Ramp multi-entity does NOT work with QBO/Xero** (each QBO company needs its own Ramp business). It *does* work
  with a custom ledger via the Developer-API accounting connection → all ~15 entities can live in **one Ramp business
  (Ramp Plus)** with MeritBooks as the connection. (Confirm with Ramp: API connection counts as multi-entity-capable;
  all entities meet the "legally related / shared management" test across funds/SPEs.)
- **Ownership split:** Ramp = cards, card controls, policy agent, receipts for Ramp spend, reimbursements, bill-pay
  rails, procurement/POs, travel. MeritBooks = chart of accounts/dimensions/vendors (pushed *to* Ramp), GL posting,
  AP subledger & aging, accruals, reconciliation, intercompany, consolidation, close, reporting, 1099 consolidation.
- **Integration design:** Developer-API accounting connection (OAuth Authorization Code). Push GL accounts, Department/
  Class/Location fields, vendors, entities (with per-entity valid codes + filter rules). Pull `*.ready_to_sync`
  transactions/bills/reimbursements/payments via webhooks (HMAC-verified) + polling fallback; post JEs; acknowledge via
  `POST /accounting/syncs` (failed syncs show in Ramp with a fix-it message, e.g. "Period closed"). Bank feed must pair
  Ramp statement payments to the posted entry (no double-count). Add a **Ramp-vs-GL completeness detector** and
  **accrue unsynced Ramp spend** at month-end.

## 3. Gap list (MeritBooks today vs market)

Legend: ✅ have (LIVE) · 🟡 partial · ❌ missing. "Who" = competitors that have it.

### A. Must-have for Merit go-live (Tier 1)
| # | Capability | MeritBooks | Who | Note |
|---|---|---|---|---|
| 1 | Ramp accounting connection (two-way) | ❌ | Rillet, Campfire (Brex API) | §2 — needs Ramp developer app |
| 2 | Scheduler for agents, report packs, nightly checks | ❌ (no cron) | all | `vercel.json` crons + secret; unlocks 3, 5, 7 |
| 3 | Proactive alerts + **one-sentence watch rules** ("tell me when Heartland cash < next payroll") with one-click actions, via email/Slack/Teams | ❌ | Nume, Campfire digests, Light Astra | builds on the exception library + Inbox |
| 4 | **Approval enforcement** on bills / JEs / payments, one materiality policy for people *and* agents, routing by entry source (agent / API / MCP / UI) | 🟡 engine exists, not enforced on all docs | Light, Rillet, Campfire | known gap |
| 5 | **Group close gate**: group month closes only when every entity closed; bottleneck-by-entity view; auto post-close package (P&L/BS/cash vs budget + reforecast) | 🟡 close board exists | Nume, Sage Close Analytics, NetSuite ICM | |
| 6 | **MCP server** (read + role-scoped write → proposals) so Claude can work the books | ❌ | Digits, Rillet, Light, Numeric, NetSuite, Xero, Intuit | now expected |
| 7 | Management-fee allocations + intercompany loans with interest | ❌ (loans planned-only) | Campfire, Docyt | how Merit charges portcos |
| 8 | AI actually on in production (Anthropic org status) | ⚠️ verify | — | many features degrade without it |

### B. Differentiators to build next (Tier 2)
| # | Capability | MeritBooks | Who |
|---|---|---|---|
| 9 | Close procedure written in plain English → agents run each step, pause for approval, replay monthly; checklist rows trigger agents | 🟡 close-run recipe | Puzzle Close, Maximor, Rillet Aura |
| 10 | Plain-English custom checks → deterministic rules (extends exception library) | ❌ | Digits |
| 11 | Edits to closed periods become an approval-queued **proposal** (DB now hard-blocks) | ❌ | Digits |
| 12 | Reconciliation evidence pinned to the bank-statement PDF; "these ledger lines broke a reconciled account" | ❌ | Digits, Numeric |
| 13 | Forecast with separate **actual / committed (deterministic) / AI-estimated** layers | 🟡 deterministic 13-week | Campfire |
| 14 | AP inbox agent: per-entity inbox, vendor replies drafted from live data, vendor email threads on the bill, bank-detail-change fraud | 🟡 webhook + fraud detector; no mail provider | Vic.ai, Ramp AP agent |
| 15 | Collections agent that sends + handles replies + applies cash | 🟡 drafts only | Tabs, Upflow, Xero |
| 16 | Multi-level consolidation trees (funds → SPEs → portcos), elimination ledger with drill-down | 🟡 NCI + eliminations exist; verify multi-level | Campfire, Light, Sage |
| 17 | Lender/investor packs on a schedule (branded PDF/PPT/XLSX), covenant certificates auto-sent | 🟡 board package + covenant certs exist; no schedule | Nume, Maximor — **white space for borrowers** |
| 18 | Audit agents that check other agents' instructions/output vs policy → monthly control report | ❌ | Light |
| 19 | AI eval suite run on every release (regression guard for every AI feature) | ❌ | Nume, Basis, Digits |
| 20 | Business-context memory shared by all agents (what each entity does) | 🟡 vendor memory only | Nume, Light, Gushwork |

### C. Trades / construction depth (Tier 2–3)
| # | Capability | MeritBooks | Who |
|---|---|---|---|
| 21 | AIA G702/G703 billing in Books (today only in Projects) | 🟡 | Sage, Acumatica, IES, Procore |
| 22 | Lien waivers gated to payment; subcontractor compliance (COI/W-9 already) | ❌ / 🟡 | Procore Pay, Adaptive |
| 23 | AI cost-overrun / cost-to-complete prediction per job | 🟡 EAC narrative | Acumatica, IES, Adaptive |
| 24 | ServiceTitan / field-system feed (jobs, invoices, payments) | ❌ (catalog only) | ServiceTitan+Ramp |
| 25 | Certified / union payroll | ❌ (defer to provider) | Foundation, Vista |

### D. Platform & resale (Tier 3, before tenant #2)
| # | Capability | MeritBooks | Who |
|---|---|---|---|
| 26 | Firm cockpit: close/health status across all client orgs | 🟡 operator console | Xero Partner Hub, Digits firm dashboard |
| 27 | Tenant billing (Stripe) | ❌ stub | — |
| 28 | MFA / SSO / passkeys | ❌ (Clerk defaults) | NetSuite, IES |
| 29 | Ledger formulas in Excel / Google Sheets | ❌ | Light, Datarails, Cube |
| 30 | Transactional multi-currency | ❌ | most ERPs (low priority for Merit) |
| 31 | Receipt chase by SMS / mobile capture | ❌ | Docyt, Zeni, Ramp |
| 32 | Voice ("what's cash across the group?") | ❌ | **nobody** — differentiator |

## 4. Recommended build order
1. **Now (Merit go-live):** #8 verify AI → #2 scheduler → #1 Ramp connection (code behind env; needs Ramp dev app) →
   #4 approval enforcement → #5 group close gate + post-close package → #3 watch rules & alerts → #6 MCP server → #7.
2. **Next:** #9–#13, #17 (lender packs = market differentiator), #14–#16.
3. **Before tenant #2:** #26–#28, #19, #18.
4. **Later:** construction depth (#21–#24), #29–#32.

## 5. Where MeritBooks is already ahead
Borrowing-base calculator + covenant monitor + compliance certificates (no mid-market ERP does borrower-side);
ASC 842 leases, 9 rev-rec methods, WIP/EAC, ASC 740 provision, book-to-tax, 1099 FIRE, exception library with 12
deterministic detectors, portfolio onboarding, borrower-grade period locks (DB-enforced), Projects↔Books event seam.
