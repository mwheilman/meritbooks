# MeritBooks — IT Runbook: Automated Invoice Email Ingestion

**Audience:** Merit's IT team / IT provider.
**Purpose:** provision the external services MeritBooks needs to pull vendor invoices in from email automatically, and confirm the whole path works end to end.
**Owner of the app side:** the MeritBooks build (Mike). This doc is only the parts that live **outside** the app — the accounts, DNS, OAuth apps, and secrets that only your team can create.

---

## 0. The one-paragraph mental model

A vendor invoice needs to travel: **email → MeritBooks → stored file → read by OCR/AI → a *draft* bill in the AP review queue.** MeritBooks never auto-pays and never posts to the ledger from email; it only produces a reviewable draft. There are **two front doors** for the "email → MeritBooks" hop, and one shared **reader** behind them. Your team provisions the two front doors and the reader's credentials. That's it.

```
                         ┌─────────────────────────────────────────┐
 Option A: Connect       │                                         │
 mailbox (Gmail/Outlook) │   MeritBooks                            │
   OAuth  ───────────────►   • store the file (always, first)      │
                         │   • read it (OCR/AI reader)             ├──► Draft in
 Option B: Forwarding    │   • create a PROPOSED bill draft        │    AP Intake
 address ap-<co>@… ──────►   • NEVER posts to GL, never pays       │    Queue (human
                         │                                         │    approves)
                         └─────────────────────────────────────────┘
                              Reader = Claude vision (wired) OR
                              Azure Document Intelligence (optional)
```

**Responsibilities at a glance:**

| Piece | Who provisions | Who builds the code |
|---|---|---|
| Google OAuth app (Gmail) | **IT** | MeritBooks |
| Microsoft/Entra OAuth app (Outlook/365) | **IT** | MeritBooks |
| Forwarding domain + MX + email-parse provider | **IT** | MeritBooks (webhook exists) |
| Shared secrets in Vercel | **IT** (set values) | MeritBooks (reads them) |
| Reader credentials (Bedrock/Vertex/Azure key) | **IT + Mike** (billing) | MeritBooks |
| Onboarding "Connect email" UX, token storage, poller | — | **MeritBooks** |

> **Where the app lives.** Today the app is deployed at `https://meritbooks-web.vercel.app`. The intended production hostname is `https://app.meritbooks.app` (not cut over yet). **Register every redirect URI and webhook URL below for BOTH hostnames** so nothing breaks at cutover.

---

## Option A — Connected mailbox (the automatic experience)

The user clicks **Connect Gmail** or **Connect Outlook** in onboarding, grants read access once, and MeritBooks watches that mailbox for invoices from then on. This is the elegant path. It requires an OAuth app per provider.

### A1. Google (Gmail / Google Workspace)

1. In **Google Cloud Console**, create (or reuse) a project, e.g. `meritbooks-email`.
2. **APIs & Services → Enable APIs → enable "Gmail API".**
3. **OAuth consent screen:**
   - **If every mailbox you'll connect is inside your own Google Workspace**, set **User type = Internal**. This is strongly preferred — it avoids Google's app-verification and the annual third-party CASA security assessment.
   - **If you need to connect Gmail accounts outside your Workspace** (external), User type = External, and be aware: the scope below is a **restricted scope**, so Google will require **app verification + an annual independent security assessment (CASA)** before more than 100 users can connect. Budget weeks, not hours, for that. Recommend starting Internal.
4. **Scopes:** add `https://www.googleapis.com/auth/gmail.readonly` (needed to read message bodies + attachments). Metadata-only scopes can't retrieve attachments, so readonly is required.
5. **Credentials → Create OAuth client ID → Application type: Web application.**
   - **Authorized redirect URIs** (add all):
     - `https://meritbooks-web.vercel.app/api/integrations/email/google/callback`
     - `https://app.meritbooks.app/api/integrations/email/google/callback`
6. Copy the **Client ID** and **Client secret** → hand to Mike to set as Vercel env vars `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (see §D).

### A2. Microsoft (Outlook / Microsoft 365)

1. In **Microsoft Entra ID (Azure AD) → App registrations → New registration**, name `meritbooks-email`.
   - **Supported account types:** "Accounts in this organizational directory only" if all mailboxes are in your tenant; "any org directory" if you'll connect external 365 tenants.
   - **Redirect URI (Web):** add both
     - `https://meritbooks-web.vercel.app/api/integrations/email/microsoft/callback`
     - `https://app.meritbooks.app/api/integrations/email/microsoft/callback`
2. **API permissions → Add → Microsoft Graph → Delegated → `Mail.Read`.** (Delegated = acts as the signed-in user who connected their mailbox. `Mail.Read` is required to fetch attachments.) Click **Grant admin consent** for your tenant.
3. **Certificates & secrets → New client secret.** Copy the **secret value now** (it's shown once).
4. Copy **Application (client) ID**, **Directory (tenant) ID**, and the **secret** → hand to Mike for Vercel env vars `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_TENANT_ID`, `MS_OAUTH_CLIENT_SECRET` (see §D).

> **What MeritBooks does with these:** on connect, it exchanges the OAuth code for a refresh token, stores **only** an encrypted reference in Supabase Vault (never the token in a plain table), and a background job polls each connected mailbox for new messages with attachments. Read-only. A user can disconnect at any time, which revokes and deletes the stored reference.

---

## Option B — Forwarding address (the always-works fallback)

Every company gets an address like **`ap-<company-slug>@inbound.meritbooks.app`**. The customer either (a) sets a forwarding rule in their mail client so invoices auto-forward there, or (b) hands the address to vendors directly. Good for shared AP mailboxes and vendors you can't OAuth. The receiving webhook already exists — it needs a domain and an email-parse provider in front of it.

### B1. DNS

1. Choose the inbound subdomain: **`inbound.meritbooks.app`** (keeps it off your main mail flow).
2. Point that subdomain's **MX record** at your chosen email-parse provider (per that provider's docs). Add any SPF/DKIM records the provider requires for inbound.

### B2. Email-parse provider — pick one

The MeritBooks webhook expects **JSON with base64 attachments**. Provider fit matters:

| Provider | Payload | Adapter needed? | Notes |
|---|---|---|---|
| **Postmark Inbound** (recommended) | JSON + base64 | **No** — matches the webhook exactly | Fastest to stand up and verify. |
| SendGrid Inbound Parse | multipart form-data | **Yes** — small converter | Cheaper/bundled; needs a Cloudflare Worker to reshape to JSON. |
| Mailgun Routes | multipart form-data | **Yes** — small converter | Same caveat as SendGrid. |
| Cloudflare Email Worker | you write it | **Yes** — you own the parse | No provider fee, most IT effort. |

If you pick a multipart provider, MeritBooks will supply the tiny adapter spec — but **Postmark is the recommendation** because it drops in with zero glue.

### B3. Point the provider at the webhook

- **Webhook URL:** `https://app.meritbooks.app/api/webhooks/inbound-email` (and/or the `meritbooks-web.vercel.app` host until cutover).
- **Auth:** the endpoint requires a shared secret. Configure the provider to send header **`x-inbound-email-secret: <value>`** (or `Authorization: Bearer <value>`). The value must match the `INBOUND_EMAIL_SECRET` env var (see §D). **The endpoint rejects everything if the secret is unset or mismatched** — this is deliberate.

### B4. Accepted attachments (both options)

PDF, JPEG, PNG, WebP, GIF, up to **15 MB** each. Other types are skipped and reported (not silently dropped). Every accepted file is stored **before** any reading, so nothing is ever lost even if the reader is down.

---

## C. The reader (OCR/AI) — required for either front door to actually read an invoice

Getting the email in is only half of it. Something has to turn the PDF into fields (vendor, invoice #, date, total, lines). Two engines:

1. **Claude vision — already fully wired (default).** Needs a working model credential. **The current `ANTHROPIC_API_KEY` account is disabled**, so this is the active blocker for reading. Two ways to give it a valid credential:
   - Re-enable/fund the Anthropic account (appeal in progress), **or**
   - Point the AI gateway at **Amazon Bedrock** or **Google Vertex AI** (same Claude models, separate billing relationship). This is the recommended unblock. IT provisions the Bedrock/Vertex access + credentials; MeritBooks repoints the gateway.
2. **Azure Document Intelligence — optional, higher fidelity on messy scans.** The connector is **scaffolded but not finished** in the app — it needs a build task before it does anything. If you want it: create an **Azure AI Document Intelligence** resource, copy the **Endpoint** and a **Key**, and provide them as `AZURE_DOC_INTELLIGENCE_ENDPOINT` / `AZURE_DOC_INTELLIGENCE_KEY`. MeritBooks then finishes + verifies the live call. Until then it silently falls back to Claude vision.

**Until one reader has a valid credential, invoices still arrive and are stored, but land in the AP queue as `PENDING_PARSE` (unread).** They are not lost — they read automatically once the credential is live.

---

## D. Secrets to set (Vercel → `meritbooks-web` project → Settings → Environment Variables)

Mike sets these; IT supplies the values from the steps above.

| Env var | For | Source |
|---|---|---|
| `INBOUND_EMAIL_SECRET` | Forwarding webhook auth | Any long random string; also configured in the email provider (B3) |
| `GOOGLE_OAUTH_CLIENT_ID` | Gmail connect | Google Cloud (A1) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Gmail connect | Google Cloud (A1) |
| `MS_OAUTH_CLIENT_ID` | Outlook connect | Entra (A2) |
| `MS_OAUTH_TENANT_ID` | Outlook connect | Entra (A2) |
| `MS_OAUTH_CLIENT_SECRET` | Outlook connect | Entra (A2) |
| `MAILBOX_POLL_SECRET` | Auth for the mailbox-poll cron | Any long random string; also set in the scheduler that calls it |
| `AZURE_DOC_INTELLIGENCE_ENDPOINT` | *(optional)* Azure reader | Azure resource (C2) |
| `AZURE_DOC_INTELLIGENCE_KEY` | *(optional)* Azure reader | Azure resource (C2) |

> Generate a random secret with: `openssl rand -base64 32`.

---

## E. Verification checklist (how we confirm it actually works)

Run these after provisioning. The goal is to move each row from ❓ to ✅.

**Forwarding path (Option B):**
1. ❓ Send a test email with a PDF invoice attached to `ap-<test-company>@inbound.meritbooks.app`.
2. ❓ Confirm the email provider shows the message delivered and the webhook returned **HTTP 200**.
3. ❓ In MeritBooks → **Bills → Intake Queue**, confirm a new draft appeared for the right company with the PDF attached.
4. ❓ If a reader credential is live: confirm the draft is **PARSED** (vendor/total populated). If not: confirm it's **PENDING_PARSE** (stored, awaiting reader) — that's the correct degraded state.

**Connected-mailbox path (Option A):**
1. ❓ In onboarding/settings, click **Connect Gmail** (or Outlook), complete the consent screen, land back on MeritBooks showing **Connected**.
2. ❓ Send/receive a test invoice into that mailbox.
3. ❓ Within one poll cycle, confirm a draft appears in the Intake Queue (same as B3 above).
4. ❓ Click **Disconnect** and confirm the connection drops and polling stops.

**Reader:**
1. ❓ With a valid Bedrock/Vertex/Anthropic (or Azure) credential set, re-open a `PENDING_PARSE` draft's source and confirm it re-reads to **PARSED**.

---

## F. Security posture (for your review)

- The forwarding webhook and the mailbox-poll cron both **fail closed** — no secret, no access. Secrets are compared in constant time.
- Mailbox OAuth tokens are stored **only** as encrypted references in Supabase Vault, never in a readable table; the row carries a pointer, not the token.
- Mailbox scopes are **read-only** (`gmail.readonly`, Graph `Mail.Read`). MeritBooks never sends mail from, deletes from, or modifies a connected mailbox.
- Every ingested file is org-scoped (RLS) to exactly the tenant its address/mailbox resolved to; a message that can't be attributed to a tenant is dropped and logged, never guessed.
- Nothing on this path posts to the general ledger or moves money. It produces a **draft** a human must approve.

---

## G. What MeritBooks is building on its side (so you know the seams line up)

- Onboarding **"Set up automated invoice ingestion"** step offering both options (Connect mailbox / Show forwarding address).
- Google + Microsoft OAuth **connect + callback** routes at the redirect URIs in §A, Vault-backed token storage, and a **mailbox-poll cron** route guarded by `MAILBOX_POLL_SECRET`.
- Surfacing each company's forwarding address in onboarding/settings with a copy button and a test-send affordance.
- Finishing + verifying the Azure reader **if** you choose to provision it.

**Honest status:** the forwarding webhook and the whole store→read→draft pipeline already exist in the app; the connect-mailbox flow and the onboarding UX are being built now. None of it is "done" until the items in §E are checked ✅ against live credentials — which is exactly why this runbook exists.
