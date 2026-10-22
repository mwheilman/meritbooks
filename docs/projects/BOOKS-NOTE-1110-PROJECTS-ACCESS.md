# Note for the Books session — migration 1110 (Merit Projects access)

Migration `1110_pm_access.sql` (Projects band) plugs Merit Projects into the Books RBAC v2 model. What it
changes outside `pm`, all additive and covered by Books `access-foundations.test.ts` (82/82) and the full
Books suite (4,255 pass):

1. `core.capabilities_module_chk` now allows `module = 'projects'`; 20 `projects.*` capabilities are
   mirrored from `packages/projects-access` (the Projects code source of truth).
2. `core.rbac_mirror_capabilities` deprecates only keys of the modules present in its input, so a Books
   re-mirror never deprecates `projects.*` (behaviour for Books input is unchanged; an empty input no
   longer deprecates everything). The Books registry guard test now compares books/core/platform only.
3. Ten Projects persona role templates + two permission sets are platform templates (audience
   internal_staff), provisioned into every tenant; existing members were backfilled with Projects
   assignments (owners/admins → Projects Owner; others → Projects PM + a legacy all-jobs set).
4. `core.memberships.projects_only boolean not null default false` — an explicit, opt-in flag set only via
   `pm.set_projects_only()` (never on owner/admin seats; a trigger clears it on promotion). A flagged seat is
   a "Projects-only seat" (crew, field and office staff with no Books access).
5. Restrictive policy `projects_only_seat_deny` on every RLS-enabled table in `public` and `core`
   (exceptions with reasons in `pm.access_seat_exceptions`). It is false only for flagged seats, so Books
   staff, legacy members, members without assignments and service paths are unaffected.

**Ask:** when a Books migration creates or recreates an RLS table in `public` or `core`, add once after
`enable row level security`:

```sql
select core.apply_projects_only_seat_deny('public.<table>');
```

Skip only if Projects-only seats genuinely need the table (then ask Projects to add an exemption with a
reason). The Projects guard test (`pm.access_seat_unprotected_tables()` must be empty) fails for any
uncovered table. Please don't change the meaning of `core.is_projects_only_seat()`.

Also open for Books: `core.jobs` money columns remain member-readable for unflagged seats (Books reads them
through RLS clients); a masked view on the Books side would let Projects drop its row-narrowing workaround.
