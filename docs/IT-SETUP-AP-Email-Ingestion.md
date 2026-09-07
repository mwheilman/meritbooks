# IT Setup — Automatic Bill Reading by Email (MeritBooks)

**Goal:** let each company forward its vendor invoices to an email address and have
MeritBooks read them automatically into Accounts Payable. This needs a one-time central
setup, then a 2-minute step per company domain.

There are two parts. Part A is done once by whoever manages our email/DNS. Part B is
repeated once per company domain.

---

## Part A — One-time central setup (do this once)

We need an inbound email service that receives mail and forwards it to MeritBooks as a
web request. Any one of these works — pick the one we already use or the easiest for us:
**Cloudflare Email Routing, SendGrid Inbound Parse, Postmark, or Mailgun Routes.**

1. **Pick a subdomain** for inbound mail, e.g. `inbound.meritbooks.app` (or a subdomain
   on a domain we control).
2. **Add the MX record** for that subdomain as directed by the chosen provider, so mail
   sent to `something@inbound.meritbooks.app` reaches the provider.
3. **Point the provider's inbound webhook at MeritBooks:**
   - **URL:** `https://app.meritbooks.app/api/webhooks/inbound-email`
   - **Method:** POST
   - **Add a header** on every request:
     `x-inbound-email-secret: <SECRET>`
     (…or, if the provider only supports an Authorization header:
     `Authorization: Bearer <SECRET>`)
   - The provider should send the email's `from`, `to`, `subject`, and **attachments**
     in the request body. (SendGrid/Postmark/Mailgun do this by default; Cloudflare uses
     a small Email Worker — we can supply the 15-line script.)
4. **The `<SECRET>`**: generate one long random string (e.g. `openssl rand -hex 32`) and
   give it to us. We set it in MeritBooks as the `INBOUND_EMAIL_SECRET` environment
   variable. Until this is set, the endpoint safely rejects everything, so nothing can be
   spoofed into our books.

That's the whole central setup. Nothing here touches the companies' real mailboxes.

---

## Part B — Per company domain (repeat for each company)

Each company gets its own private ingest address so bills land in the right entity's books.

1. **Give the company a unique ingest address** on the subdomain from Part A, e.g.:
   - Heritage Interiors → `ap-heritage@inbound.meritbooks.app`
   - Clive Power Equipment → `ap-clive@inbound.meritbooks.app`
   - …one per entity. (We register each address inside MeritBooks — see "What to send
     back" — so it routes to that entity.)
2. **Forward the company's AP mail to it.** In that company's email system
   (Google Workspace / Microsoft 365), create a forwarding rule so anything sent to their
   real AP address forwards to their MeritBooks ingest address:
   - e.g. forward `ap@heritageinteriors.com` → `ap-heritage@inbound.meritbooks.app`
   - If they don't have an `ap@` address, create one first, or just have staff forward/CC
     invoices to the ingest address directly.

That's it per domain — a forwarding rule.

---

## What to send back to us

For each company, reply with one line:

> **Heritage Interiors — `ap-heritage@inbound.meritbooks.app`**

…and separately, the **one shared secret** from Part A (send it securely — password
manager or encrypted, not plain email).

We'll register each address to its entity in MeritBooks and set the secret. After that,
any invoice emailed or forwarded to a company's AP address shows up in that company's AP
inbox, already read, for a person to approve.

---

### Notes / FAQ for IT

- **Security:** every request must carry the shared secret; requests without it are
  rejected. The secret is the only thing that authorizes posting into our books, so treat
  it like a password. We can rotate it any time.
- **No mailbox access needed.** We are not asking for OAuth into anyone's mailbox or for
  admin access to read mail — just a forwarding rule and an inbound webhook. (A future
  version may offer one-click Gmail/Outlook linking as an alternative; this forwarding
  method needs none of that.)
- **Attachments:** PDFs and images of invoices are what we read. Plain-text/HTML-only
  emails are captured too, but a PDF/image attachment gives the best extraction.
- **Volume/where it goes:** each message becomes a "pending" AP intake item for review;
  nothing posts to the ledger automatically — a person always confirms.
- **Test:** once set up, forward one sample invoice to a company's ingest address; it
  should appear in that company's AP intake queue within a minute.
