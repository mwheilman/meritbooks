# Turning on the bills and receipts email inboxes — IT one-pager

**Who this is for:** whoever manages the company's domain (DNS) and the Vercel project.
**Time:** about 20 minutes, plus up to an hour for DNS to update.
**What it touches:** only addresses ending in `@inbound.meritbooks.app`. Your normal company email is not affected.
**Spec:** `docs/FPB-ap-intake.md`. The same steps are in the app under **Settings → Email inboxes → Setup guide**.

## What you get

Every company in MeritBooks already has two addresses:

| Address | Use |
|---|---|
| `ap-<company>@inbound.meritbooks.app` (e.g. `ap-heritage-interiors@…`) | Vendors email bills here, or you forward them. Each PDF becomes a **draft bill on that company**, with the vendor filled in and the sender shown. |
| `receipts-<company>@inbound.meritbooks.app` | Cardholders forward receipts. Each one is matched to the card charge. |

The addresses are shown, with a Copy button, on **Bills**, **Bills → Intake**, **Settings → Companies**, **Settings → Email inboxes** and the last onboarding step. Until setup is finished they say **"Not yet active — your admin needs to finish email setup."**

Nothing is paid or posted to the books from an email. A person reviews and approves every draft.

## Step 1 — Create a Postmark account (recommended service)

1. Go to **postmarkapp.com** and sign up. The free trial is enough to test; see postmarkapp.com/pricing for the paid plans.
2. Create a **Server** named "MeritBooks inbound".
3. Open the server → the **Inbound** message stream → **Settings**.
4. In **Inbound domain**, enter `inbound.meritbooks.app` and save.

## Step 2 — Add one DNS record

In the DNS settings for `meritbooks.app` (wherever the domain is managed: GoDaddy, Cloudflare, Route 53, Namecheap, …), add:

| Type | Name / host | Value / points to | Priority |
|---|---|---|---|
| MX | `inbound` | `inbound.postmarkapp.com` | 10 |

That's the only DNS change. **Settings → Email inboxes → Check DNS** in the app confirms it.

## Step 3 — Make a webhook password and point Postmark at MeritBooks

1. Make up a long password, **at least 20 characters** (let a password manager generate one). Letters and numbers only keeps it simple.
2. In Postmark's Inbound **Settings**, set the **Webhook URL** to the line below, with your password in place of `YOUR-PASSWORD`:

   ```
   https://meritbooks:YOUR-PASSWORD@meritbooks-web.vercel.app/api/webhooks/inbound-email
   ```

   (Use your production web address if it is not `meritbooks-web.vercel.app`, e.g. `app.meritbooks.app`.)
3. Optional, stronger: Postmark publishes the IP addresses it sends webhooks from. You can list them in `INBOUND_EMAIL_ALLOWED_IPS` (step 4) so only Postmark can reach the endpoint.

Postmark does not sign its webhooks, so this password (HTTP Basic auth in the URL) is how MeritBooks knows a message really came from Postmark. Without it, MeritBooks refuses every message.

## Step 4 — Add the settings in Vercel

Vercel → the MeritBooks project → **Settings → Environment Variables** → add, for **Production**:

| Name | Value |
|---|---|
| `INBOUND_EMAIL_PROVIDER` | `postmark` |
| `INBOUND_EMAIL_DOMAIN` | `inbound.meritbooks.app` |
| `INBOUND_EMAIL_SECRET` | the password from step 3 |
| `INBOUND_EMAIL_ALLOWED_IPS` | *(optional)* Postmark's webhook IPs, comma-separated |
| `INBOUND_EMAIL_PROVIDER_ADDRESS` | *(optional)* the server's own Postmark inbound address (`…@inbound.postmarkapp.com`) — lets you test **before** DNS is ready by sending to `thataddress+ap-heritage-interiors@inbound.postmarkapp.com` |

Then **redeploy** (Deployments → ⋯ → Redeploy). The app now shows **Active**.

## Step 5 — Send a test

1. From your own email, send an invoice PDF to one company's AP address (copy it from the Bills page).
2. Within a minute it appears in **Bills → Intake** as a draft on that company, showing who sent it.
3. **Settings → Email inboxes** lists the message and what happened to it ("Draft bill created", "Duplicate — ignored", "Sender not allowed", …).

## Forwarding an existing AP mailbox

**Gmail / Google Workspace**

1. Gmail → Settings (gear) → See all settings → **Forwarding and POP/IMAP** → **Add a forwarding address** → paste the company's AP address.
2. Gmail sends a confirmation email to that address. MeritBooks catches it: **Settings → Email inboxes** shows "Forwarding to confirm" with a **Confirm in Gmail** button and the code.
3. Back in Gmail, choose "Forward a copy of incoming mail to …", or better, create a filter (e.g. *has attachment* from your vendors) that forwards only bills.

**Outlook / Microsoft 365**

1. Outlook on the web → Settings → Mail → **Rules** → Add new rule → **Forward to** the company's AP address (or Mail → Forwarding to forward everything).
2. Microsoft 365 blocks forwarding to outside addresses by default. The IT admin may need to allow it: **Microsoft Defender → Policies → Anti-spam → Outbound policy → Automatic forwarding: On** for that mailbox.

## Who may send

Each address can accept mail from **anyone** (default — best for a bills address you give to every vendor), **known vendors and your team**, or **only listed domains / people**. Change it under **Settings → Email inboxes → Settings** on the address. Mail from someone who isn't allowed is refused and **not stored**; the log shows it with an **Allow sender** button.

## Using SendGrid instead

Set `INBOUND_EMAIL_PROVIDER=sendgrid`. In SendGrid → Settings → **Inbound Parse** → Add Host & URL: host `inbound.meritbooks.app`, the same webhook URL as step 3, **"Send Raw" off**. The MX record points to `mx.sendgrid.net` (priority 10). For stronger security, create an Inbound Parse **security policy** with signature verification and put its public key in `SENDGRID_INBOUND_PUBLIC_KEY`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Still "Not yet active" | Step 4 variables are set for Production and you redeployed. The password is at least 16 characters. |
| Active, but nothing arrives | **Check DNS** on Settings → Email inboxes. In Postmark → Inbound → Activity, a message marked "Inbound error" with 401 means the password in the webhook URL and `INBOUND_EMAIL_SECRET` differ. |
| A bill arrived twice | It didn't draft twice: the same file is recognised (log shows "Duplicate — ignored"). |
| A vendor says they sent it | Look for "Sender not allowed" in the log and click **Allow sender**, then ask them to resend. |
