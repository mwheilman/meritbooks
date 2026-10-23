# Feature Product Brief: Payables email inbox (AP intake by email) — Wave 2D

**Status:** authored 2026-10-23 (slice 2D). **Migration:** `183_inbound_email_aliases.sql`.
**Sources:** `docs/audit-2026-10/FEATURE-GAP-AUDIT.md` §2.6, AP-01, AP-02, IN-04, OB-06 (partial), §6.3 Wave 2D,
§6.4 item 6; migration 135 (org-level `inbound_ap_address`); `lib/ap/inbound-intake.ts`,
`lib/ap/doc-intelligence/intake-queue.ts`; Postmark inbound webhook + webhooks-overview docs; SendGrid
"Securing your Inbound Parse Webhooks".

## 0. The one-paragraph version

Today the webhook, the AI read and the intake queue are coded, but nothing can reach them: `INBOUND_EMAIL_SECRET`
is unset (the endpoint rejects everything), there is no provider or MX record, the address is per *tenant* (every
bill lands on the default company) and it is never shown in the app. This slice gives **every company two
addresses** — `ap-<company>@<domain>` for vendor bills and `receipts-<company>@<domain>` for receipts — shows them
with a copy button on Bills, the intake queue, Settings and onboarding, verifies the provider (fail closed), dedupes
by provider message id **and by the sha256 of each attachment**, turns each PDF/image (or an HTML-only invoice
email, rendered to PDF) into a draft bill **on that company** with the vendor matched and the sender shown, keeps
the original email as a document, logs every message and what happened to it, and lets the admin restrict who may
send. It is live the moment the owner creates a Postmark account, sets one MX record and pastes two values into
Vercel.

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **"Draft bill" = a PROPOSED intake draft** (`ai_decisions`, feature `AP_DOC_INTAKE`) carrying the alias's company, not a `bills` row | Canon §3: AI proposes facts, a human approves; auto-post is off. Approving a draft still goes through the gated `/api/bills/create` (Zod, compliance holds, approver routing). The queue is where AP staff already work. |
| D2 | **Provider-agnostic adapters**: `postmark` (default, recommended), `sendgrid` (Inbound Parse, multipart), `generic` (JSON) | Owner hasn't approved a provider. Switching provider = one env var. |
| D3 | **Postmark auth = HTTP Basic auth in the webhook URL** (+ optional IP allowlist) | Postmark does **not** sign webhooks (no HMAC); its docs recommend Basic auth + IP allowlisting. |
| D4 | SendGrid auth = **ECDSA signature** (`X-Twilio-Email-Event-Webhook-Signature`/`-Timestamp` over timestamp + raw body) when `SENDGRID_INBOUND_PUBLIC_KEY` is set, else Basic auth | SendGrid's security policy. Verified on the raw bytes before parsing. |
| D5 | Generic auth = HMAC-SHA256 of `timestamp.rawBody` (`x-inbound-signature`, `x-inbound-timestamp`, ±5 min) **or** the shared secret (`x-inbound-email-secret` / Bearer / Basic) | Keeps the pre-existing contract working; gives a stronger option for self-hosted relays (Cloudflare Email Worker). |
| D6 | **Fail closed**: no secret/key for the configured provider → every request 401 | Never let an unauthenticated caller post drafts into a tenant. |
| D7 | Addresses are **globally unique local parts** on one shared platform domain (`INBOUND_EMAIL_DOMAIN`); `domain` column is null = platform domain (custom white-label domains later) | Many tenants have a company called "Main Office". |
| D8 | Aliases are created **by a DB trigger** on `core.locations` insert (+ backfill) | Every creation path (onboarding, new-entity, import, seed) gets addresses with no app change. |
| D9 | Duplicate PDF guarantor = `core.inbound_attachment_fingerprints` UNIQUE `(org_id, sha256)` | "No duplicate bills from the same PDF sent twice" is enforced by the database, not by a race-prone read. A fingerprint whose draft was **rejected** may be re-used (resend after a wrong company). |
| D10 | Rejected senders: **content is not stored** — only the log row | We do not retain files from senders the tenant blocked. The admin can "Allow this sender" from the log. |
| D11 | The legacy org address `ap-<org-slug>@…` (mig 135) keeps working, routed to the org's default company, labelled "organization address" | Nothing already forwarded breaks. |
| D12 | Receipts aliases call a pluggable handler (`InboundPurposeHandler`); slice 2B supplies `handleInboundReceiptEmail` | 2B owns receipt matching; until wired the message is logged `not_handled` (never dropped silently — the email document is kept). |

## 2. Users and jobs

| Persona | Job |
|---|---|
| Owner / admin | "Turn it on" (IT one-pager), see Active / Not yet active, set who may send, confirm Gmail forwarding |
| AP clerk / bookkeeper | Give vendors the address; see each emailed bill arrive as a draft on the right company; review and approve |
| Vendor | Emails a PDF to one address; nothing else to learn |
| Staff with a Gmail/Outlook AP mailbox | Set up auto-forwarding to the company's address |

## 3. Data model (migration 183)

| Table | Purpose | Key rules |
|---|---|---|
| `core.inbound_aliases` | One address: `org_id`, `location_id` (company), `purpose` ap \| receipts, `local_part` (e.g. `ap-heritage`), `domain` (null = platform domain), `is_active`, `sender_rule` any \| known_vendors \| listed_domains, `allowed_domains[]`, `allowed_senders[]`, forwarding confirmation (`fwd_confirm_from`, `fwd_confirm_code`, `fwd_confirm_url`, `fwd_confirm_at`, `fwd_confirm_verified`), `last_received_at`, `messages_count` | UNIQUE `lower(local_part)` where domain null; UNIQUE `(lower(domain), lower(local_part))` otherwise; UNIQUE `(location_id, purpose)`; local part `^[a-z0-9][a-z0-9-]{1,62}$`; domains lower-case; confirm URL must be `https://…google.com/…` |
| `core.inbound_messages` | Log of every attributable delivery: provider, `provider_message_id`, `message_id_header`, from/name, `to_address`, subject, `received_at`, `attachments_count`, `accepted_count`, `outcome`, `detail`, `attachments` jsonb (per-file result), linked `intake_draft_ids[]`, `bill_ids[]`, `document_ids[]`, `receipt_ids[]`, `email_document_id`, spam score, `duplicate_deliveries`, `processed_at` | outcome ∈ processing · bill_drafted · receipt_attached · ignored_duplicate · rejected_sender · rejected_spam · alias_inactive · no_attachment · forwarding_confirmation · not_handled · failed; UNIQUE `(alias_id, provider, provider_message_id)` = the redelivery guarantor |
| `core.inbound_attachment_fingerprints` | sha256 of every attachment that produced a draft | UNIQUE `(org_id, sha256)`; sha256 `^[0-9a-f]{64}$` |

Functions: `core.inbound_alias_slug(text)` (immutable slugify: strip `[…]` tags, lower, non-alnum → `-`, trim, ≤ 40),
`core.ensure_inbound_aliases(location uuid)` (idempotent; base slug, then `<slug>-<org-slug>`, then `<slug>-2…`; never
takes a local part that is another org's legacy `inbound_ap_address`), trigger `trg_locations_inbound_aliases`.
RLS: members SELECT their org (client-scope restrictive policy re-applied); all writes service role (the app, after
its permission check, org pinned). M1: every function EXECUTE-revoked from public/anon, granted explicitly.

## 4. Behaviour (field-level)

**Routing.** Recipients = envelope + OriginalRecipient + To + Cc (normalised, de-duplicated). For each recipient:
(a) domain = `INBOUND_EMAIL_DOMAIN` (or the alias's custom domain) → alias by local part; (b) `<hash>+<alias>@…`
where `<hash>@…` = `INBOUND_EMAIL_PROVIDER_ADDRESS` (Postmark's own inbound address — lets the owner test before
DNS) → alias by the plus part; (c) legacy `ap-<org-slug>` org address → org default company, purpose ap. No match
→ **403** (Postmark stops retrying), nothing stored. Each matched alias is processed independently.

**Pipeline per (message, alias).** 1 claim the log row (`processing`); a redelivery of the same provider id bumps
`duplicate_deliveries` and returns 200 (a `failed` row is retried; a `processing` row younger than 10 min is
"in flight"); 2 alias inactive → `alias_inactive`; 3 spam (provider verdict Yes) → `rejected_spam`; 4 Gmail
forwarding-confirmation → stored on the alias, `forwarding_confirmation`; 5 sender rule fails →
`rejected_sender` (nothing stored); 6 keep the original email as a document (`.eml`, headers + text + HTML,
attachments stored separately); 7 purpose handler (AP below, receipts = 2B); 8 finalize outcome + linked ids;
bump alias `last_received_at`.

**Sender rules.** `any` (default). `known_vendors`: sender = a vendor email in the org, or sender domain = a vendor
email's domain (not for free-mail domains like gmail.com), or in `allowed_senders`. `listed_domains`: sender domain
∈ `allowed_domains` or sender ∈ `allowed_senders`. **Active team members of the org are always allowed** (they
forward bills). Matching is case-insensitive.

**AP handler.** Accepted parts: PDF, JPEG, PNG, WEBP, GIF ≤ 15 MB; inline images < 30 KB (signature logos) are
ignored; other types are listed as skipped. For each accepted part: sha256 → fingerprint exists for the org (and its
draft is not REJECTED) → `duplicate` with a link to the original draft; else store the file (documents bucket,
`BILL`), create the draft (AI read via the gateway; **AI down / budget blocked / unreadable → PENDING_PARSE "needs
manual entry"**, file and sender kept), insert the fingerprint (a unique violation = a racing duplicate → the draft
is rejected as a duplicate). Vendor match: AI vendor name (exact → fuzzy), **else the sender's email/domain against
vendor emails** (works even when AI is down). No accepted attachment but an HTML/text body that looks like an
invoice (invoice/bill/amount due/total keywords) → the body is rendered to a PDF and read like an attachment; else
`no_attachment`. Outcome: any draft → `bill_drafted`; only duplicates → `ignored_duplicate`; else `no_attachment` /
`failed`.

**Status shown to users.** `Active` when the provider's credential and `INBOUND_EMAIL_DOMAIN` are set; otherwise
"Not yet active — your admin needs to finish email setup". Admins additionally see an MX check (DNS lookup of the
domain → points to the provider's inbound host?) and the last message time.

## 5. UI (merit-ui)

| Where | What |
|---|---|
| Bills (header card) | `01 // AP inbox` — the company's AP address, Copy, status pill, "N received this week · last at …", links to the log and the setup guide |
| AP intake queue | Same card (compact); email drafts show "Sent to ap-…" |
| `/settings/inbound-email` (new page) | 01 Status (provider, domain, MX check, credential) · 02 Addresses — every company × purpose with Copy, active switch, sender rule · 03 Inbound log (filter by company / outcome, link to the draft bill / document, "Allow this sender") · 04 Forwarding confirmations · "Set up / IT guide" drawer |
| Settings → Companies | Each company row shows its AP + receipts address with Copy |
| Onboarding → Launch | "Forward bills to …" card with Copy |
| Help drawer (everywhere the card appears) | The IT one-pager in plain English + "Send a test" steps |

Editing (active, sender rules, dismiss confirmation) requires `settings_system:edit`; viewing addresses and the log
requires `bills:view`.

## 6. Acceptance criteria (testable)

1. A new company gets `ap-<slug>` and `receipts-<slug>` aliases automatically; existing companies are backfilled;
   two tenants' "Main Office" get different local parts; a local part never equals another org's legacy address.
2. A Postmark payload to `ap-heritage@<domain>` with a PDF creates exactly one PROPOSED draft on Heritage's
   location with `source: 'email'`, sender shown, and a stored source document + `.eml` document.
3. The same payload to `receipts-heritage@…` goes to the receipts handler, not AP; an unknown alias → 403, nothing stored.
4. Missing credential → 401 for every provider; wrong Basic password → 401; a bad/old HMAC → 401; a valid SendGrid
   ECDSA signature → accepted, a tampered body → 401.
5. Re-delivering the same provider MessageID creates no second draft and no second log row.
6. A different message carrying the same PDF → `ignored_duplicate`, no new draft; after the first draft is
   rejected, the PDF can be re-sent and drafts again.
7. Sender rules: `known_vendors` rejects a stranger, accepts a vendor email, a vendor domain, a team member;
   `listed_domains` accepts only listed domains/senders; a rejected message stores no document.
8. Vendor matched from the AI name, and from the sender email when AI is down; AI down → PENDING_PARSE draft, still
   on the right company.
9. Gmail forwarding confirmation is captured on the alias (code + google.com link) and not turned into a bill.
10. RLS: members read only their org's aliases/messages; members and anon cannot write any 183 table.
11. UI: the address and Copy button render on Bills, intake queue, Settings, onboarding; loading / empty / error
    states; "Not yet active" when unconfigured.

## 7. Benchmark (Bill.com / Ramp / Vic.ai / QBO)

| Capability | Best-in-class | Here |
|---|---|---|
| Per-entity inbox address shown with copy | Bill.com, Ramp | Yes (per company, two purposes) |
| Duplicate blocking | Ramp (invoice # + amount) | Message id + file hash (DB-enforced) + existing vendor/#/amount warning |
| Sender allow-list | Ramp | Yes (any / known vendors / listed domains + team) |
| Gmail forwarding confirmation surfaced | Ramp, Dext | Yes |
| HTML-body invoices | Vic.ai | Rendered to PDF and read |
| Auto-reply to sender | Bill.com | **Deferred** — backscatter/loop risk; needs a verified sending domain (Resend key rotation open) |
| Statements vs bills routing | Bill.com | **Deferred** — the AI read classifies only bills today |
| Connected Gmail/Outlook mailbox (OAuth backfill) | Ramp | **Deferred** to Wave 6 (AP-03) |

## 8. Owner setup (plain English) — see `docs/IT-AP-EMAIL-SETUP.md`

1. Create a Postmark account → a Server → its **Inbound** stream. 2. In your DNS, add **MX** `inbound` →
`inbound.postmarkapp.com`, priority 10. 3. In Postmark's Inbound settings set Inbound domain `inbound.meritbooks.app`
and the webhook URL `https://meritbooks:<secret>@meritbooks-web.vercel.app/api/webhooks/inbound-email`.
4. In Vercel set `INBOUND_EMAIL_PROVIDER=postmark`, `INBOUND_EMAIL_DOMAIN=inbound.meritbooks.app`,
`INBOUND_EMAIL_SECRET=<secret>`; redeploy. 5. Email a PDF to a company's AP address; the draft appears in the queue.
