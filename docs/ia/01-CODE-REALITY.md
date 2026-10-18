# Code reality — tenancy, roles, access, dashboards (Explore audit, 2026-10-18)

## Hierarchy today
- `core.organizations` = tenant (no tenant_type column; only `billing_plan` direct|firm|enterprise; `entitlements jsonb`, `onboarding_state`, `clerk_org_id`).
- `core.locations` = company / legal entity / client book (comment "portfolio companies"). Columns: `parent_entity_id` + `ownership_pct` (029), `is_management_company` (111), `onboarding_status` (121), `functional_currency` (133). FPB-tenant-model decided "a managed client is a location, not its own org" (conflicts with FPB-identity-multitenancy which suggested per-client orgs; code follows location model).
- No explicit tenant→client relation; proxies: `is_management_company`, `customers.is_portfolio_company`, `core.practice_assignments` (one owner per (org,location,function) for close|ar|ap|review|onboarding; keyed to employees).
- Consolidation: `public.entity_ownership` (effective-dated parent→child %, FULL|EQUITY|NONE); intercompany via counterparty_location_id; engine walks `locations.parent_entity_id` subtree but NO code writes that column. **No named/saved consolidation groups; no permission on groups; `GET /api/consolidation/statements` has no permission check; `canConsolidate` enforced only client-side.**
- Platform level: `core.users.is_platform_staff` + `PLATFORM_STAFF_CLERK_IDS`; `core.platform_admin_sessions` (only tenant-reset writes it); `/platform` Operator Console read-only (metrics, fee revenue, ops health; entitlements/billing are placeholders). **No platform provisioning of tenants** — tenants only self-serve via /setup.

## Identity & roles today
- `core.users`, `core.memberships` (user↔org↔role, admin_scope MANAGEMENT|PREPARER), `core.membership_locations` (write-only mirror, nothing reads it). **Real authority = `core.employees.role` + `public.employee_locations`.**
- Roles (permissions.ts): company_admin (all), cfo (all), merit_controller (all; tenant-specific name — must be renamed), assistant_cfo (portcos_and_3rdparty), accounting_manager (portcos_and_3rdparty; described as assigning access but blocked — only company_admin canManageUsers), accounting_specialist (assigned), check_processor (assigned), general_admin (assigned), business_user (own_company; its /business/* pages don't exist). Custom roles + cell overrides exist (mig 130).
- **Client access is UI-only**: RLS is org_id only; APIs don't check location_id vs assignment; `portcos_and_3rdparty` ignores assignments; dashboard + `/api/portfolio` show all companies to everyone; `/api/portfolio` + `/api/portfolio/assignments` have no permission check.
- Active company: cookie `mb_active_company` ('all' sentinel); no in-app tenant switcher. Planes: books (all), practice (supervisors), platform (staff).

## "Portfolio" occurrences to remove
Pages `/portfolio`, `/portfolio/[locationId]`, `/onboarding/portfolio`; APIs `/api/portfolio*`, `/api/onboarding/portfolio/*`; nav "Entities"→/portfolio, "Many Companies"; help copy (help-content.ts :39, :861-873); profitability-board copy; operations page copy; control-tower link; `customers.is_portfolio_company`; scope enum `portcos_and_3rdparty`; modules lib/portfolio/*, lib/companies/portfolio/*. (Job-cost "portfolio" names are unrelated.)

## Dashboards today
`/` front-door → /onboarding | /onboarding/tour | /dashboard. **One /dashboard for every role** (company card grid + activity feed, fixed layout). /inbox (approvals/exceptions/alerts/drafts), /close (status board), /portfolio "Entities" (RAG per company + owner assignment), /team, /operations (client health), /platform, /consolidation. **No user/role dashboard-layout storage; no widget registry** (only localStorage on FP&A + bank-feed views).
