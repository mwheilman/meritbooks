# MeritBooks — Canon Index (`docs/canon/`)

This folder mirrors the **Project-knowledge canon** into the repo so every session (and every
agent) physically has it without depending on the Claude.ai Project-knowledge mount. It exists
because Session 40 built blind — off the repo's stale `CLAUDE.md` — having never read the canon.

## How to use this folder

1. **Always** start (and re-ground after compaction) with `CANON-ANCHOR.md` — the small,
   always-current distillation. See the Re-Ground Protocol in `../../CLAUDE.md` §0.
2. For the area you're about to build, read the relevant **digest** below (faithful,
   quote-preserving condensations of the full docs).
3. For exact wording on a specific point, read the **source doc** in Project knowledge (paths
   below) — those remain the authoritative source of truth and are amended in place per the
   governance. The digests are the working reference, not a replacement.

## The digests (in this folder)

| File | Covers |
|---|---|
| `CANON-ANCHOR.md` | The small always-read anchor: hard invariants, gate state, priorities |
| `10-suite-contracts-digest.md` | Suite architecture, shared-object ownership matrix, FROZEN v3 event→GL contract, identity/access model, seeded test tenant |
| `20-buildspec-posting-engine-digest.md` | Architecture Build Spec v4.3 + Transaction Posting Engine Spec (GATE 2): transaction universe, GL templates, 6-layer AI architecture, rev-rec 9 methods, override/batch |
| `30-rules-audit-memory-digest.md` | The mandatory build Rules (1–16), Future-Session-Instructions workflow, memory.md, the 461-item feature audit structure |
| `40-master-doc-session37-digest.md` | Master Document v9 (Parts I–XI) + Session 37 handoff: gate sequence, standing business logic, integrations, open decisions |

## Source docs (Project knowledge — authoritative source of truth)

Located in the Claude.ai Project knowledge for "book of record" (read with the Read tool at the
mounted `.project-cache/.../docs/` path). Highest version number wins.

- `MeritBooks-Master-Document_9.md` — **THE single living reference**; supersedes the Build Spec,
  the feature audit, and all prior handoffs wherever they conflict. Amended in place each session.
- `MeritBooks-Architecture-Build-Spec-v4_3.md` — detailed architecture (superseded by Master Doc on conflict).
- `MeritBooks-Transaction-Posting-Engine-Spec.md` — GATE 2 source of truth for the posting engine.
- `merit-suite-architecture.md` — suite-level architecture & ownership zones.
- `merit-suite-shared-object-ownership-matrix.md` — who owns each `core` object/field.
- `merit-suite-event-gl-posting-contract.md` — FROZEN v3 event contract.
- `merit-suite-identity-access-model.md` — identity/roles/memberships (Core-owned).
- `merit-suite-seeded-test-tenant.md` — the sandbox round-trip completion criteria.
- `claude-project-instructions-2.md` — the mandatory build Rules (12 in the read copy; Rules 13–16 governance live in memory/Master Doc).
- `MeritBooks-Future-Session-Instructions.md` — the required session workflow.
- `meritbooks-exhaustive-feature-audit.md` — the 461-item cross-reference checklist (living version = Master Doc Part V).
- `memory.md` — durable notes on Mike, decisions, preferences, workflow.
- `MERITBOOKS-HANDOFF-session37.md` — newest handoff in Project knowledge (Stripe "Pay Now").

## Keeping this folder honest

- Re-reconcile `CANON-ANCHOR.md` whenever the canon or gate state changes (at minimum, each
  session end alongside the handoff).
- When the Master Document is amended (with Mike's sign-off), update the affected digest here.
- If a digest and its source doc ever disagree, the **source doc wins** — fix the digest.
