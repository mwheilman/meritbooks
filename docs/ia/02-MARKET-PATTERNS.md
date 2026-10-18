# Market patterns — multi-client accounting IA & role dashboards (research, 2026-10-18)

## Platform admin (operator)
Stripe Connect accounts list: status tabs (Restricted / Restricted soon / In review / Enabled / "Accounts to review"), filters, saved views, per-account "Actions required". Clerk impersonation (short-lived actor tokens, `act` claim → banner, 10/30-min timeouts). Shopify collaborator access (tenant-issued request code, scoped role, auto-expiry, actions retained in log). Google Access Approval/Transparency (consent before support access; every access logged w/ reason+ticket).
→ Recommended: onboarding funnel status tabs; tenant health table sortable by risk; billing exceptions; integration health; consent-based, time-boxed support access with tenant-visible log.

## Tenant administrator (firm admin / accounting manager)
Intuit Accountant Suite: Home = customizable widgets (tasks, disconnected bank feeds, alerts); Clients list = fast registry (search, client #, lead accountant, multi-entity group column, jump-in); Work > Client Insights (broken feeds, unposted txns, last close date across clients); Books Close grid (client, period, due, preparer/reviewer/approver, status, tasks done); user groups for bulk client access; header turns a distinct color when in the firm's OWN books. Xero Partner Hub widgets (org watchlist, bank-feed alerts), staff per client, Xero Ask client requests. Double: on track / blocked / where managers step in; time by client/team → margin leak. Digits: firm-wide open items, blocked work, assignments; materiality thresholds. Karbon: My Week buckets; capacity weekly by assignee; 90-day view. Uku: auto-reassign on vacation.
Books-health columns: feed status, AI queue size, oldest unreviewed, unreconciled count/value, last close date, open client requests, anomalies.
Client requests: QBO "Ask client" from selected txns → client answers in a requests inbox → flows back; Financial Cents auto-follow-ups + magic links.

## Tenant users
- **Bookkeeper (primary):** per-client checklist (QBO Books review: transaction review → reconciliation → final review → wrap-up); low-confidence view (Docyt); My Week (Karbon). Questions: which of my clients is furthest from close; what did AI not categorize / low confidence; what's unreconciled; what am I waiting on the client for; what's due today/this week.
- **Accounting manager/reviewer:** review queue; Books Close grid w/ assignees; Sage close progress monitor (overdue / at risk / on track / complete; top overdue; by entity and assignee); capacity.
- **Controller:** close-through by module per entity; exceptions/unusual entries; approvals; recs done.
- **CFO/finance director:** cash & runway, P&L vs budget/forecast, AR/AP exposure, close blockers, entity side-by-side (Rillet Launchpad = KPI tiles + work queues + sync health).
- **Owner:** business at a glance + Needs Attention (things needing input + work already done worth a quick review) + privacy toggle hiding figures; answers accountant requests.
- **HR/payroll:** next pay date & funding, payroll awaiting approval, payroll JE posted/tied, tax filings.
- **Ops leader/dept manager:** my department vs budget; approvals.
- **Auditor/view-only:** locked periods, PBC status, audit trail, statements with drill.

## Permissioned consolidation
Sage Intacct "top level" = all entities a user is permitted; restricted users see only their entities; dashboards need rights to dashboard AND data. NetSuite subsidiary restriction on role (All/Active/User/Selected; view-not-edit cross-sub excluding payroll). Campfire: consolidated / entity group / entity views.
→ Consolidation group as first-class object; separate `consolidation:view` permission scoped to a group, granted only if user can access every member (eliminations leak the other side); consolidated option appears in switcher only for holders; eliminations shown as explicit lines.

## Customizable dashboards
NetSuite publishing: publish layout to roles; new users only vs override existing; restriction Locked / Add-Move only / Unlocked; required portlets. Business Central role centers: headlines → cues (count tiles that drill to lists) → parts; lazy load. Salesforce: org default / app default / app+profile (most specific wins). Intacct: fewest dashboards by role. HubSpot gap: no team defaults.
→ Three layers: system role template → tenant-published role layout (lock level) → user personalization; republish asks new-only vs override; "Reset to role default"; widget catalog filtered by permission (never blank widgets); required widgets; lazy load.

## Anti-patterns
Dashboards for monitoring not exploring (NN/g); giant hero numbers without context; vanity metrics ("AI auto-approved 95%" with no link); metrics without actions (every tile must open its queue/report); welcome banners pushing actions down; blank widgets for missing rights; dashboard sprawl.
