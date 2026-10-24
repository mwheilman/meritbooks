# Merit Suite — shared records across Merit CRM, Merit Projects and Merit Books

Status: owner-directed design (2026-10-24: "contemplate how this will interact with Merit CRM, Merit Books.
Merit Projects can have its own CRM lead flow… when a customer is created with Merit Projects or Merit Books,
how do they feed into and get reconciled with the other — same for all entries that live in both").
Governed by the suite architecture (one Postgres, reference-never-copy) and the shared object ownership matrix.
This document extends the matrix; it does not change any existing ownership.

## 1. The answer in one paragraph

Nothing is synced, so nothing has to be reconciled after the fact. A customer, contact, site, vendor, item,
employee or job exists **once** in the suite's core tables. Merit CRM, Merit Projects and Merit Books are three
doors into the same record: each creates and edits it through the same core actions, and each owns only its own
fields on it. What can still go wrong is people creating the same customer twice through different doors, and two
modules disagreeing about money for a job. The suite handles the first with **matching at the door** and a
**shared duplicate review with merge**, and the second with **continuous tie-outs** that show "Ties to Books" or a
dollar-ranked exception, in both apps.

## 2. Where each shared record lives

| Record | Home | Thin core fields | Depth added by |
|---|---|---|---|
| Customer (company or household) | `core.customers` | name, contact basics, address, tax id, identity status | Books: terms, credit, AR standing, payment methods, tax exemption · Projects/CRM: relationship stage, source, owner |
| Contact (a person at a customer, vendor or prospect) | `core.contacts` (new) | name, email, phone, role, consent | CRM: marketing preferences · Projects: job roles (who signs, who pays) · Books: billing contact flag |
| Site / property / service location | `core.sites` (new) | address, geo, access notes, customer link | Projects: equipment, gate codes, jobs · Books: ship-to / tax jurisdiction |
| Vendor / subcontractor | `core.vendors` | name, contact, address | Books: W-9, 1099, terms, approval · Projects: trades, compliance view, commitments |
| Lead, opportunity, pipeline, activities, follow-ups | `crm` schema (new; the reserved Merit CRM namespace) | — | Built now by Projects as its lead flow; Merit CRM adds marketing, campaigns and sequences on the same rows later |
| Job | `core.jobs` + `pm.*` | per the matrix | per the matrix |
| Item / price book | `core.items` + module depth | per the matrix | per the matrix |
| Employee / user | `core.employees`, `core.users`, `core.memberships` | per the matrix and identity model | per the matrix |

Why leads live in a `crm` schema and not inside Projects: when a company later buys Merit CRM, the leads, contacts
and activities it already has must simply appear there. A lead built inside `pm` would have to be copied out, which is
exactly the sync the suite forbids. Merit Projects is the first module to give `crm` a screen; it does not own it
alone. Ownership of the `crm` tables is "the CRM capability", provided by whichever of Merit CRM or Merit Projects the
tenant has (the same pattern the matrix uses for rev-rec inputs).

Relationship stage is **derived, never stored as a second status**: a customer is a *prospect* until it has a signed
contract (Projects) or an issued invoice (Books), then a *customer*; *former* after 24 months without either. One
view computes it, so the two apps can never disagree.

## 3. Matching at the door (every module, every create)

Every create of a customer, contact, site or vendor — from a Projects lead form, a Projects job, a Books invoice, a
Books import, a CRM web form, an email-to-lead, or an AI intake — goes through one core matcher first:

`core.match_parties(kind, name, email, phone, address, tax_id)` returns ranked candidates with the fields that matched.

- **Exact identifier** (same email, same phone, same tax id, or same normalized name + address) → the door offers the
  existing record by default ("Already in Merit: Harbor Holdings — used in Books since March"). Creating a second one
  needs a typed reason.
- **Likely match** (similar name plus one shared identifier) → the user picks: use existing, or create new.
- **No match** → create.

A database safety net catches any door that skips the matcher (older code, imports, Books screens not yet updated): a
trigger on insert into `core.customers`, `core.vendors` and `core.contacts` computes the same score and, for a strong
match, files a row in `core.duplicate_reviews`. Nothing is ever merged automatically.

## 4. Duplicate review and merge (one queue, both apps)

`core.duplicate_reviews` holds candidate pairs (kind, survivor suggestion, score, matched fields, source door, status).
It shows in Projects (Customers → Possible duplicates) and in Books (its existing customer dedupe surface reads the
same rows). A person with the customer-edit capability in either app resolves it:

- **Merge**: `core.merge_parties(kind, survivor, victim, field_choices)` repoints every reference to the victim in every
  schema (found from the foreign-key catalog, so Books, Projects and CRM tables added later are covered), keeps the
  field values chosen per field (each module's own fields stay with that module's choice), moves contacts and sites,
  soft-archives the victim with `merged_into`, and writes the full before/after to the audit log. Posted Books records
  are repointed, never altered in amount or date. Blocked when the two records belong to different tenants, or when a
  money conflict exists that only Books can settle (two different AR credit limits or payment terms: Books picks).
- **Not a duplicate**: remembered, so the pair is never suggested again.

## 5. Records that look shared but are two stages (never one record two apps edit)

| Projects (operations) | Books (money) | Rule |
|---|---|---|
| Estimate / proposal for a job | Books estimate (non-job quotes) | Job estimates originate in Projects when Projects is on; Books estimates stay for non-job sales |
| Billing request / pay app / draw | Issued invoice | Projects requests, Books issues and owns (matrix) |
| Deposit request | Customer deposit / retainer held | Projects requests, Books holds and applies |
| Commitment: job PO or subcontract | Bill matched to it; Books PO for non-job buying | Projects owns job POs (owner ruling); Books matches bills to them |
| Time entry (hours) | Payroll and labor cost | Projects hours, Books dollars (owner ruling D9) |
| Field payment taken on a phone | Payment applied, fees settled | Projects captures, Books applies |
| Change order | Supplemental invoice or credit | Projects scope, Books money |

When Merit Projects is on for a company, Books' own entry path for the job-side of each pair is switched off for that
company (owner ruling), so nobody can key the same thing in both apps.

## 6. Continuous tie-outs (the reconciliation that remains)

Because amounts move as events, the suite checks every night and on demand that both sides agree, per job and per
company, and shows the result in both apps:

| Check | Projects side | Books side | Exception when |
|---|---|---|---|
| Job cost | Operational cost roll-up from cleared JOB_COST events | GL lines with the job dimension | Totals differ by more than $1 |
| Billing | Billing requests accepted | Invoices issued for the job | A request has no invoice after 2 business days, or amounts differ |
| Deposits | Deposit requests | Deposits held and applied | Held ≠ requested − applied |
| Commitments | Commitment value and billed-to-date | Bills matched to the commitment | Billed in Books > committed, or matched bills ≠ billed-to-date |
| Time | Approved hours by job | Payroll-allocated hours by job | Hours differ after the payroll run |
| Events | Messages sent | Messages accepted | Any rejected or unanswered message older than 1 hour |
| Customers | Projects/CRM customers in use | Books customers in use | Pending duplicate reviews |

Each exception names the job, the dollar difference, the likely cause and the one action that fixes it (resend,
open the bill, approve the time). A job card shows "Ties to Books" with the as-of time when all checks pass.

## 7. What each module does

- **Merit Projects (now):** builds `core.contacts`, `core.sites`, the `crm` schema and its lead flow, the matcher, the
  duplicate queue and merge, the tie-out views; uses the matcher on every create door it owns.
- **Merit Books (Books session):** calls `core.match_parties` on its create doors (customer, vendor, invoice quick-add,
  imports) and reads `core.duplicate_reviews` in its existing dedupe screen; adds the Projects-only-seat policy to new
  tables (see BOOKS-NOTE-1110). No Books table changes ownership.
- **Merit CRM (future module):** adds marketing depth to the `crm` tables and `core.contacts`; Projects' lead screens
  remain for tenants without Merit CRM and hand off to Merit CRM's screens when both are owned.

## 8. The phone app

The owner ruled the field app is a phone app. The suite already defines **Merit Workforce** as the one employee app
(Books FPB-workforce-app: clock, pay, receipts). There will be one native phone app, Merit Workforce, for iOS and
Android: Projects supplies the field work (today's jobs, clock in/out, daily log, photos, checklists, punch, crew time)
and Books supplies pay, commissions and receipts, each card calling its own module's actions. Offline-first for the
Projects cards.

## 9. Build contract (migration 1111 ↔ apps; both sides build to these names)

Tables
- `core.contacts` (id, org_id, customer_id?, vendor_id?, first_name, last_name, email, phone, title, roles text[],
  is_primary, can_sign, can_pay, sms_consent, email_consent, consent_at, identity_status, created_by, timestamps)
- `core.sites` (id, org_id, customer_id, location_id?, name, address_line1, address_line2, city, state, zip, lat, lng,
  access_notes, tax_jurisdiction, identity_status, timestamps)
- `crm.pipelines` (id, org_id, location_id, key, name, pack_key, is_default) · `crm.pipeline_stages` (id, pipeline_id,
  key, name, kind open|won|lost, probability_pct, sort)
- `crm.leads` (id, org_id, location_id, pipeline_id, stage_id, title, customer_id?, contact_id?, site_id?, source,
  source_detail, campaign, owner_membership_id?, estimated_value_cents, expected_close_on, next_step, next_step_on,
  lost_reason, won_at, lost_at, converted_estimate_id?, converted_job_id?, created_by, timestamps)
- `crm.lead_stage_events`, `crm.activities` (lead/customer/contact/job links, kind call|sms|email|meeting|site_visit|
  note|portal_message|signed_document, direction, subject, body, outcome, occurred_at), `crm.followups` (lead_id,
  due_on, kind, assigned_membership_id, done_at, cadence_key)
- `core.duplicate_reviews` (id, org_id, kind customer|vendor|contact, a_id, b_id, score, matched text[], source,
  status open|merged|not_duplicate, resolved_by, resolved_at)

Functions (definer, org-guarded, capability-checked like 1110)
- `core.match_parties(p_kind, p_name, p_email, p_phone, p_address, p_tax_id, p_limit default 5)` →
  (id, name, score numeric, matched text[], detail jsonb)
- `core.merge_parties(p_kind, p_survivor, p_victim, p_field_choices jsonb)` → jsonb summary; `core.dismiss_duplicate(p_review)`
- `core.create_contact(...)`, `core.create_site(...)` (match first; return existing on exact identifier)
- `crm.create_lead(...)`, `crm.move_lead(p_lead, p_stage, p_reason)`, `crm.log_activity(...)`, `crm.complete_followup(...)`,
  `crm.convert_lead(p_lead, p_target 'estimate'|'job', p_job_type_key)` → ids (creates customer via matcher if needed)
- Views: `core.v_customer_relationship` (customer_id, stage prospect|customer|former, since), `pm.v_customer_360`
  (definer; money columns masked per caller like 1110), `pm.v_job_tieout` (job_id, check_key, projects_cents,
  books_cents, diff_cents, status ok|exception|pending, cause, action), `pm.v_company_tieout` (summary per company)
- Capabilities: reuse `projects.leads` and `projects.customers` (no new keys).
