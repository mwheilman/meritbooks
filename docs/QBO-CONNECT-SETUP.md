# QuickBooks Online Connect: setup for Mike

**What this turns on:** a **Connect QuickBooks** button in onboarding. The customer signs in to
QuickBooks and approves read-only access. MeritBooks then pulls their chart of accounts, customers,
vendors, open invoices, open bills, a trial balance as of the cutover date, and their company details
(name, address, EIN, fiscal year). Nothing gets posted automatically: the pulled trial balance goes
through the same review, tie-out and approval steps as an uploaded file.

**If you skip this:** nothing breaks. The QuickBooks tile shows "Export from QuickBooks in 60 seconds"
and the customer uploads the reports themselves.

You need one Intuit developer app for all of MeritBooks, not one per customer. Each customer's
connection is stored separately and encrypted in Supabase Vault.

---

## 1. Create the Intuit app (about 10 minutes)

Intuit changes its portal from time to time. If a button has a different name, look for the closest
match.

1. Go to **https://developer.intuit.com** and sign in. You can use your normal Intuit login.
2. Open the **Dashboard** and click **Create an app**. Choose **QuickBooks Online and Payments**.
3. Name it **MeritBooks**.
4. When asked for scopes, tick **Accounting** (`com.intuit.quickbooks.accounting`) and nothing else.
   We only need to read. Leave Payments, Payroll and OpenID unticked.
5. Open the app, go to **Keys & credentials**, and stay on the **Development** (sandbox) section for now.
6. Under **Redirect URIs**, click **Add URI** and paste this exactly:
   ```
   https://meritbooks-web.vercel.app/api/integrations/erp/quickbooks/callback
   ```
   When `app.meritbooks.app` goes live, add
   `https://app.meritbooks.app/api/integrations/erp/quickbooks/callback` as well.
7. Copy the **Client ID** and **Client Secret**. You'll paste them into Vercel in step 2.
8. Intuit creates a **sandbox company** with fake data for you automatically (Dashboard → Sandbox).
   That's the company you'll connect to for the first test.

## 2. Add the five settings in Vercel

Go to Vercel → project **meritbooks-web** → **Settings → Environment Variables**. Add each of these for
**Production** and **Preview**:

| Name | What to put | Notes |
|---|---|---|
| `QBO_CLIENT_ID` | Client ID from step 1.7 | |
| `QBO_CLIENT_SECRET` | Client Secret from step 1.7 | Secret. Never paste it into chat or a file. |
| `QBO_REDIRECT_URI` | `https://meritbooks-web.vercel.app/api/integrations/erp/quickbooks/callback` | Must match step 1.6 exactly. |
| `QBO_ENVIRONMENT` | `sandbox` | Change to `production` in step 4. |
| `QBO_STATE_SECRET` | A random string of 32 or more characters | On your Mac, run `openssl rand -base64 48` in Terminal and paste the result. |

Then **redeploy** (Deployments → the latest one → ⋯ → Redeploy) so the app picks up the settings.

If any of the five is missing or too short, the app treats QuickBooks connect as "not set up" and
offers the upload path instead.

## 3. Test with the sandbox company

1. Sign in to MeritBooks and start onboarding, or open the QuickBooks tile.
2. Click **Connect QuickBooks**. Intuit's sign-in opens. Choose your **sandbox** company and click
   **Connect**.
3. You come back to MeritBooks and the tile shows the sandbox company's name.
4. Run the import. You should see the trial balance, the counts, and any clean-up warnings
   (for example "Payments waiting in Undeposited Funds").
5. To test disconnecting, click **Disconnect**. The link is revoked at Intuit and deleted on our side.

## 4. Go live with real customers (production keys)

Intuit won't give you production keys until you fill in its app profile and compliance questionnaire.
1. In the app, open **Keys & credentials → Production** and follow **Get production keys**. Intuit
   will ask for:
   - The app's **host domain** and **launch URL**. Use the MeritBooks URL.
   - A **privacy policy URL** and an **end-user license agreement (terms) URL**. These need to be real
     public pages.
   - A **disconnect URL** and a **Reconnect URL**. Intuit now requires the Reconnect URL, and shows it
     to customers when their connection is about to expire. Use the onboarding page, for example
     `https://meritbooks-web.vercel.app/onboarding`.
   - A short questionnaire about how you store data. The honest answers: read-only accounting scope,
     tokens encrypted in Supabase Vault, used only to migrate the customer's books.
2. In Production, add the same **Redirect URI** as in step 1.6.
3. In Vercel, replace `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` with the **production** values, set
   `QBO_ENVIRONMENT` = `production`, and redeploy.

Production and sandbox are separate. A company connected in sandbox has to reconnect after the switch.

## Good to know

- **Connections expire.** Intuit renews access every hour without anyone doing anything. A connection
  only stops working if:
  - the customer disconnects MeritBooks inside QuickBooks, or
  - the connection reaches Intuit's 5-year maximum.

  When that happens, the tile says so in plain English and shows a **Connect QuickBooks** button.
  Data that was already imported is never affected.
- **Rate limits.** Intuit allows about 500 requests per minute per company. One import uses a handful
  of requests and slows down automatically if Intuit asks it to.
- **Where tokens live:** encrypted in Supabase Vault and readable only by the server. The connection
  record that customers can see holds only the company name, status and a pointer to the vault entry.
