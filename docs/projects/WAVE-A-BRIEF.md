# Wave A build brief (shared by every Wave A agent)

Owner directive (2026-10-24): "build everything to get this system live; deploy as many agents as needed."
Approved spec: the expert-panel Claude Doc (summarized in docs/projects/WAVE0-ACCESS-FOUNDATION-SPEC.md,
docs/suite/SHARED-RECORDS-CRM-PROJECTS-BOOKS.md, docs/projects/WAVE1-SCHEDULE-SPEC.md; panel seat files with full
feature tables in /home/claude/panel/0*.md and 10-platform.md — read the rows for your area).

## Live foundation you build on (do not break)
- Migrations 1100–1112 are LIVE. 1110 = access (policy classes J/M/C/S/P/O registered in pm.access_table_classes,
  pm.can / my_location_ids / my_job_ids / my_money_job_ids, masked views + pm.access_apply_masks(), guarded definer
  RPCs in pm.access_rpc_guards, projects_only_seat_deny via core.apply_projects_only_seat_deny on every new
  public/core table). 1111 = shared records + crm schema (crm registries crm.access_table_classes /
  crm.access_rpc_registry). 1112 = schedule.
- Books (apps/web) is built by a separate session; Books migrations are 0xx/1xx (up to 190). Never edit Books code or
  Books migrations. Reuse Books' core services where they exist instead of duplicating (read before building):
  approvals 092/165/174, notifications/request engine 178, documents 090/188 + `documents` storage bucket, customer and
  vendor portal tokens 141/142, vendor requirements 180, invoice pay links 176.
- App conventions: apps/projects route() REQUIRES `access: {cap, action}`; RLS client only (never service role);
  getAccess()/can() in lib/access; money display helpers in components/money/visibility.ts; merit-ui design system is
  binding (packages/merit-ui/README.md); every row clickable; loading/empty/error states; no `any`; money bigint cents.

## Migration numbers (one per agent — never create another number)
1113 approvals · 1114 notifications · 1115 documents & e-sign · 1116 job page & setup v2 (only if needed) ·
1117 field-service depth. Each migration: idempotent, PGlite-safe, org-guarded definer functions with pinned
search_path, every new table classified and every new definer RPC registered so the 1110/1111 guard tests pass,
core.apply_projects_only_seat_deny on new public/core tables.

## Shared files
- lib/nav.ts, the shell (components/shell/**) and the job page tab list belong to the Job-page agent (A5). Others:
  list the nav items / shell slots you need in your final reply; A5 adds Approvals, Inbox/notifications bell,
  Documents and field-service items proactively per the spec, pointing at the routes named below.
- Routes: approvals `/approvals`, notifications `/inbox` + bell API `/api/notifications`, documents `/documents`,
  e-sign `/sign/[token]` (public, token-scoped), field service under existing areas.

## Tests (must pass before you report)
- `cd packages/projects-access && npx vitest run` (replays all migrations incl. the other Wave A files in progress — if
  another agent's unfinished migration breaks the replay, say so; don't edit it).
- `cd apps/web && npx vitest run src/test/access-foundations.test.ts`
- `npx tsc --noEmit -p apps/projects` and `cd apps/projects && npx vitest run`
Don't apply anything live, don't commit or push.
