-- =============================================================================
-- Migration 193: Onboarding v2 — part 1 (docs/ia/08-ONBOARDING-V2-SPEC.md §3,
--                docs/FPB-onboarding.md §9). One migration object per client being
--                converted, its sources and staged files, firm mapping memory, the 24
--                preflight findings, immutable tie-out snapshots and the Conversion
--                Certificate (preparer + a DIFFERENT reviewer, DB-enforced).
-- =============================================================================
-- §1  public.migration_waves         a wave IS a cutover date (OM-2): unique per org while
--                                    open; (id, cutover_date) is a key so every project in a
--                                    wave carries the wave's cutover (composite FK, §2).
-- §2  public.migration_projects      OM-1, one per client (location) while not archived:
--                                    stage (storage values only — the UI shows plain
--                                    labels), cutover, history depth, practice-close mode,
--                                    chart strategy, lead / preparer / reviewer (Clerk user
--                                    ids; preparer ≠ reviewer), the linked historical-
--                                    conversion session, and the certificate. "Signed off"
--                                    and "Live" REQUIRE a certificate (CHECK).
-- §3  public.migration_sources       OM-3: the systems this client uses (catalog slug, role,
--                                    tier) and their honest status.
-- §4  public.migration_runs          OM-4: every file drop / pull — file name, SHA-256,
--                                    parser, counts, control totals. Superseded on re-drop.
-- §5  public.staged_records          OM-4: normalized rows (money in cents) with their
--                                    source reference and the master-data decision
--                                    (new / matched to an existing record / merge / ignore).
--                                    Staging is NOT the books: nothing here posts.
-- §6  public.mapping_sets            OM-5: the firm's mapping memory per source family.
--     public.mapping_rules           one answer per source key (number / normalized name),
--                                    evidence count, conflict flag, settled-by.
--     public.mapping_rule_evidence   which client approved which answer (client-scoped, so a
--                                    bookkeeper only ever sees evidence from their clients).
-- §7  public.client_mappings         OM-5: per project, the resolved source → MeritBooks
--                                    account with band, confidence, the rule that made it and
--                                    the type guard; an incompatible type needs a typed reason.
-- §8  public.preflight_findings      OM-8: one row per (project, check) with severity, $,
--                                    plain message and the person's disposition.
-- §9  public.tieout_snapshots        OM-9: IMMUTABLE (service role may only insert/select).
-- §10 public.conversion_certificates OM-10: CC-#### per org, preparer ≠ approver (CHECK),
--                                    issued needs an approver, voided needs a reason, one
--                                    live certificate per project.
-- §11 public.migration_events        append-only trail: stage moves, decisions, comments.
-- §12 RLS + grants: members SELECT their org only; every write is the service role (the
--     app, after its permission + client-scope check, org pinned — the 171 / 184 / 188
--     pattern). anon nothing. M1 lesson: NO new functions, no triggers.
-- §13 core.apply_client_scope_rls() + core.apply_projects_only_seat_deny() (guarded).
--
-- No GL effect: nothing here writes gl_entries / gl_entry_lines / fiscal_periods (the app
-- posts the opening entry through the existing conversion path and hard-closes pre-cutover
-- periods through setPeriodStatus). Idempotent. PGlite-compatible (no subqueries in
-- CHECKs). Apply to Supabase FIRST, then commit the code that depends on it.
-- =============================================================================

-- ── §1 waves ─────────────────────────────────────────────────────────────────
create table if not exists public.migration_waves (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  name                   text not null,
  cutover_date           date not null,
  purpose                text,
  default_history_depth  text not null default 'opening_only',
  target_go_live         date,
  status                 text not null default 'open',
  created_by             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
comment on table public.migration_waves is
  'Mig 193 (OM-2): a group of clients moving on the same cutover date. A wave IS its cutover date — unique per org while open; projects reference (id, cutover_date) so they always carry it.';

create unique index if not exists ux_migration_waves_id_cutover on public.migration_waves (id, cutover_date);
create unique index if not exists ux_migration_waves_open_cutover on public.migration_waves (org_id, cutover_date) where status = 'open';
create index if not exists ix_migration_waves_org on public.migration_waves (org_id, cutover_date);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'migration_waves_values_chk') then
    alter table public.migration_waves add constraint migration_waves_values_chk
      check (char_length(btrim(name)) between 1 and 120
             and default_history_depth in ('opening_only','monthly','monthly_plus_detail')
             and status in ('open','closed')
             and (purpose is null or char_length(purpose) <= 300));
  end if;
end $$;

-- ── §2 projects ──────────────────────────────────────────────────────────────
create table if not exists public.migration_projects (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id) on delete cascade,
  wave_id                 uuid,
  stage                   text not null default 'plan',
  stage_changed_at        timestamptz not null default now(),
  skipped_stages          text[] not null default '{}',
  cutover_date            date,
  history_depth           text not null default 'opening_only',
  history_start           date,
  target_go_live          date,
  shadow_mode             text not null default 'clean_switch',
  chart_strategy          text not null default 'tenant_standard',
  mapping_set_id          uuid,
  systems_confirmed       boolean not null default false,
  lead_user_id            text,
  preparer_user_id        text,
  reviewer_user_id        text,
  conversion_session_id   uuid references public.ai_decisions(id) on delete set null,
  blocker_summary         jsonb not null default '{}'::jsonb,
  certificate_id          uuid,
  certified_at            timestamptz,
  live_at                 timestamptz,
  notes                   text,
  created_by              text,
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
comment on table public.migration_projects is
  'Mig 193 (OM-1): one client being brought onto MeritBooks. Stage values are storage only (UI: Gather info · Connect systems · Check data quality · Match accounts · Prove balances · Practice close · Signed off · Live). Written only by the service role (lib/onboarding/migration).';

create unique index if not exists ux_migration_projects_client on public.migration_projects (org_id, location_id) where archived_at is null;
create index if not exists ix_migration_projects_stage on public.migration_projects (org_id, stage);
create index if not exists ix_migration_projects_wave on public.migration_projects (wave_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'migration_projects_wave_fk') then
    alter table public.migration_projects add constraint migration_projects_wave_fk
      foreign key (wave_id, cutover_date) references public.migration_waves (id, cutover_date)
      on update cascade on delete set null (wave_id);
  end if;
exception when others then
  -- `on delete set null (col)` needs PG 15+; fall back to the plain form.
  if not exists (select 1 from pg_constraint where conname = 'migration_projects_wave_fk') then
    alter table public.migration_projects add constraint migration_projects_wave_fk
      foreign key (wave_id, cutover_date) references public.migration_waves (id, cutover_date)
      on update cascade;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'migration_projects_values_chk') then
    alter table public.migration_projects add constraint migration_projects_values_chk
      check (stage in ('plan','connect','preflight','map','tie_out','shadow_close','certified','live','paused','abandoned')
             and skipped_stages <@ array['plan','connect','preflight','map','tie_out','shadow_close']::text[]
             and history_depth in ('opening_only','monthly','monthly_plus_detail')
             and shadow_mode in ('parallel','clean_switch','none')
             and chart_strategy in ('keep_source_chart','tenant_standard')
             -- a project in a wave carries the wave's cutover (the FK above checks the pair)
             and (wave_id is null or cutover_date is not null)
             -- the reviewer is never the preparer
             and (preparer_user_id is null or reviewer_user_id is null or preparer_user_id <> reviewer_user_id)
             -- "Signed off" and "Live" need a certificate (the go-live gate)
             and (stage not in ('certified','live') or certificate_id is not null)
             and (stage <> 'live' or live_at is not null)
             and (history_start is null or cutover_date is null or history_start <= cutover_date)
             and jsonb_typeof(blocker_summary) = 'object'
             and (notes is null or char_length(notes) <= 4000));
  end if;
end $$;

-- ── §3 sources ───────────────────────────────────────────────────────────────
create table if not exists public.migration_sources (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id) on delete cascade,
  project_id      uuid not null references public.migration_projects(id) on delete cascade,
  system_id       text not null,
  role            text not null,
  tier            text not null,
  status          text not null default 'planned',
  entities        text[] not null default '{}',
  last_run_id     uuid,
  last_pulled_at  timestamptz,
  note            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.migration_sources is
  'Mig 193 (OM-3): a system the client uses (catalog slug from lib/onboarding/migration/catalog.ts) — how it connects today (native_api | recipe | generic_file) and its status. MeritBooks only ever reads a source.';

create unique index if not exists ux_migration_sources_system on public.migration_sources (project_id, system_id);
create index if not exists ix_migration_sources_org on public.migration_sources (org_id, location_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'migration_sources_values_chk') then
    alter table public.migration_sources add constraint migration_sources_values_chk
      check (system_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'
             and role in ('ledger_source','field_system','bank','card_spend','payroll','crm','docs')
             and tier in ('native_api','recipe','generic_file')
             and status in ('planned','connected','pulled','stale','error','archived')
             and (note is null or char_length(note) <= 1000));
  end if;
end $$;

-- ── §4 runs ──────────────────────────────────────────────────────────────────
create table if not exists public.migration_runs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references core.organizations(id) on delete cascade,
  location_id     uuid not null references core.locations(id) on delete cascade,
  project_id      uuid not null references public.migration_projects(id) on delete cascade,
  source_id       uuid references public.migration_sources(id) on delete set null,
  run_kind        text not null,
  status          text not null default 'staged',
  entity          text,
  parser          text,
  label           text,
  file_name       text,
  file_path       text,
  file_sha256     text,
  as_of           date,
  record_counts   jsonb not null default '{}'::jsonb,
  control_totals  jsonb not null default '{}'::jsonb,
  warnings        jsonb not null default '[]'::jsonb,
  dropped_count   integer not null default 0,
  error           text,
  created_by      text,
  created_at      timestamptz not null default now()
);
comment on table public.migration_runs is
  'Mig 193 (OM-4): one file drop or pull into staging, with its SHA-256, parser, counts and control totals (the evidence chain). Superseded when the same slot is dropped again.';

create index if not exists ix_migration_runs_project on public.migration_runs (project_id, created_at desc);
create index if not exists ix_migration_runs_source on public.migration_runs (source_id, entity, status);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'migration_runs_values_chk') then
    alter table public.migration_runs add constraint migration_runs_values_chk
      check (run_kind in ('file_parse','pull','opening_post','undo')
             and status in ('running','staged','superseded','posted','undone','failed')
             and (entity is null or entity in ('account','tb_line','customer','vendor','item','dimension','job',
                                               'open_invoice','open_bill','bank_balance','evidence'))
             and (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$')
             and (file_name is null or char_length(file_name) <= 300)
             and dropped_count >= 0
             and jsonb_typeof(record_counts) = 'object'
             and jsonb_typeof(control_totals) = 'object'
             and jsonb_typeof(warnings) = 'array'
             and (status <> 'failed' or error is not null));
  end if;
end $$;

-- ── §5 staged records ────────────────────────────────────────────────────────
create table if not exists public.staged_records (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id) on delete cascade,
  project_id         uuid not null references public.migration_projects(id) on delete cascade,
  run_id             uuid not null references public.migration_runs(id) on delete cascade,
  entity             text not null,
  external_id        text,
  display_name       text not null,
  dedupe_key         text,
  amount_cents       bigint not null default 0,
  payload            jsonb not null default '{}'::jsonb,
  source_ref         jsonb not null default '{}'::jsonb,
  match_status       text not null default 'new',
  matched_object_id  uuid,
  match_confidence   numeric(4,3),
  match_reason       text,
  decision_by        text,
  decision_at        timestamptz,
  created_at         timestamptz not null default now()
);
comment on table public.staged_records is
  'Mig 193 (OM-4): normalized staged rows (money in cents) with their source reference. "Staged, not in your books": nothing here posts. match_status records the master-data decision (Already in Merit → matched).';

create index if not exists ix_staged_records_project on public.staged_records (project_id, entity);
create index if not exists ix_staged_records_run on public.staged_records (run_id);
create index if not exists ix_staged_records_dedupe on public.staged_records (project_id, entity, dedupe_key);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'staged_records_values_chk') then
    alter table public.staged_records add constraint staged_records_values_chk
      check (entity in ('account','tb_line','customer','vendor','item','dimension','job',
                        'open_invoice','open_bill','bank_balance','evidence')
             and char_length(display_name) between 1 and 300
             and match_status in ('new','matched','merge_proposed','conflict','ignored')
             and (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1))
             and (match_status <> 'matched' or matched_object_id is not null)
             and (decision_at is null or decision_by is not null)
             and jsonb_typeof(payload) = 'object'
             and jsonb_typeof(source_ref) = 'object');
  end if;
end $$;

-- ── §6 mapping memory ────────────────────────────────────────────────────────
create table if not exists public.mapping_sets (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  name           text not null,
  source_family  text not null default 'generic',
  version        integer not null default 1,
  status         text not null default 'active',
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.mapping_sets is
  'Mig 193 (OM-5): the firm''s mapping memory for one source family — an approved mapping on one client is proposed on the next.';

create unique index if not exists ux_mapping_sets_family on public.mapping_sets (org_id, source_family) where status = 'active';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'mapping_sets_values_chk') then
    alter table public.mapping_sets add constraint mapping_sets_values_chk
      check (char_length(btrim(name)) between 1 and 120
             and source_family in ('quickbooks','xero','sage_intacct','sage_50','sage_desktop','netsuite','field','generic')
             and status in ('draft','active','retired')
             and version >= 1);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'migration_projects_mapping_set_fk') then
    alter table public.migration_projects add constraint migration_projects_mapping_set_fk
      foreign key (mapping_set_id) references public.mapping_sets (id) on delete set null;
  end if;
end $$;

create table if not exists public.mapping_rules (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  mapping_set_id       uuid not null references public.mapping_sets(id) on delete cascade,
  match_kind           text not null,
  match_value          text not null,
  source_label         text,
  source_account_type  text,
  target_account_id    uuid not null references public.accounts(id) on delete cascade,
  evidence_count       integer not null default 1,
  conflict             boolean not null default false,
  settled_by           text,
  settled_at           timestamptz,
  created_by           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.mapping_rules is
  'Mig 193 (OM-5): one remembered answer per source key. evidence_count = clients that approved this target; conflict = another client mapped the same key elsewhere (the accounting manager settles it once).';

create unique index if not exists ux_mapping_rules_key on public.mapping_rules (mapping_set_id, match_kind, match_value);
create index if not exists ix_mapping_rules_org on public.mapping_rules (org_id, mapping_set_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'mapping_rules_values_chk') then
    alter table public.mapping_rules add constraint mapping_rules_values_chk
      check (match_kind in ('exact_number','normalized_name')
             and char_length(match_value) between 1 and 200
             and evidence_count >= 0
             and (settled_at is null or settled_by is not null));
  end if;
end $$;

create table if not exists public.mapping_rule_evidence (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references core.organizations(id) on delete cascade,
  location_id        uuid not null references core.locations(id) on delete cascade,
  rule_id            uuid not null references public.mapping_rules(id) on delete cascade,
  project_id         uuid references public.migration_projects(id) on delete set null,
  target_account_id  uuid not null references public.accounts(id) on delete cascade,
  decided_by         text not null,
  decided_at         timestamptz not null default now()
);
comment on table public.mapping_rule_evidence is
  'Mig 193 (OM-5): which client approved which answer for a rule. Client-scoped, so the conflict detail a bookkeeper sees is limited to their own clients.';

create unique index if not exists ux_mapping_rule_evidence on public.mapping_rule_evidence (rule_id, location_id);

-- ── §7 client mappings ───────────────────────────────────────────────────────
create table if not exists public.client_mappings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references core.organizations(id) on delete cascade,
  location_id         uuid not null references core.locations(id) on delete cascade,
  project_id          uuid not null references public.migration_projects(id) on delete cascade,
  source_account_key  text not null,
  source_number       text,
  source_name         text not null,
  source_type         text,
  detail_type         text,
  balance_cents       bigint not null default 0,
  target_account_id   uuid references public.accounts(id) on delete set null,
  proposal_source     text not null default 'unmapped',
  rule_id             uuid references public.mapping_rules(id) on delete set null,
  confidence          numeric(4,3) not null default 0,
  band                text not null default 'decide',
  type_guard          text not null default 'ok',
  type_reason         text,
  conflict            boolean not null default false,
  reason              text,
  status              text not null default 'proposed',
  decided_by          text,
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on table public.client_mappings is
  'Mig 193 (OM-5): one client''s source account → MeritBooks account, with the rule that proposed it, its band (Ready ≥ 0.90 · Check 0.70–0.89 · Decide) and the type guard. Accepting an incompatible type needs a typed reason (printed on the certificate).';

create unique index if not exists ux_client_mappings_key on public.client_mappings (project_id, source_account_key);
create index if not exists ix_client_mappings_band on public.client_mappings (project_id, band, status);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_mappings_values_chk') then
    alter table public.client_mappings add constraint client_mappings_values_chk
      check (char_length(source_account_key) between 1 and 200
             and proposal_source in ('rule','crosswalk','number','name','ai','human','unmapped')
             and confidence >= 0 and confidence <= 1
             and band in ('ready','check','decide')
             and type_guard in ('ok','warn','block')
             and status in ('proposed','accepted','needs_account')
             and (status <> 'accepted' or (target_account_id is not null and decided_by is not null and decided_at is not null))
             and (status <> 'accepted' or type_guard <> 'block' or char_length(btrim(coalesce(type_reason, ''))) >= 10)
             and (type_reason is null or char_length(type_reason) <= 1000));
  end if;
end $$;

-- ── §8 preflight findings ────────────────────────────────────────────────────
create table if not exists public.preflight_findings (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid not null references core.locations(id) on delete cascade,
  project_id        uuid not null references public.migration_projects(id) on delete cascade,
  check_id          text not null,
  severity          text not null,
  name              text not null,
  title             text not null,
  message           text not null,
  fix               text,
  amount_cents      bigint not null default 0,
  accounts          text[] not null default '{}',
  records           jsonb not null default '{}'::jsonb,
  disposition       text not null default 'open',
  disposition_note  text,
  disposed_by       text,
  disposed_at       timestamptz,
  run_at            timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.preflight_findings is
  'Mig 193 (OM-8): the 24 data-quality checks per client (one row per check, refreshed on every run) and the person''s decision on each. A blocker can only be fixed in source or carried as one reconciling item; dispositions print on the certificate.';

create unique index if not exists ux_preflight_findings_check on public.preflight_findings (project_id, check_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'preflight_findings_values_chk') then
    alter table public.preflight_findings add constraint preflight_findings_values_chk
      check (check_id ~ '^PF-(0[1-9]|1[0-9]|2[0-4])$'
             and severity in ('blocker','warning','info','passed','not_applicable')
             and disposition in ('open','fixed_in_source','carry_as_reconciling_item','accepted_with_note','not_applicable')
             and amount_cents >= 0
             and (disposition = 'open' or (disposed_by is not null and disposed_at is not null))
             -- a blocker is never simply "accepted": fix it in the source or carry it as a reconciling item
             and (severity <> 'blocker' or disposition in ('open','fixed_in_source','carry_as_reconciling_item'))
             and (disposition not in ('accepted_with_note','carry_as_reconciling_item')
                  or char_length(btrim(coalesce(disposition_note, ''))) >= 10)
             and (disposition_note is null or char_length(disposition_note) <= 2000)
             and jsonb_typeof(records) = 'object');
  end if;
end $$;

-- ── §9 tie-out snapshots (immutable) ─────────────────────────────────────────
create table if not exists public.tieout_snapshots (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.organizations(id) on delete cascade,
  location_id    uuid not null references core.locations(id) on delete cascade,
  project_id     uuid not null references public.migration_projects(id) on delete cascade,
  kind           text not null default 'cutover_tb',
  as_of          date,
  ties           jsonb not null default '[]'::jsonb,
  all_tied       boolean not null default false,
  blocker_count  integer not null default 0,
  content_hash   text not null,
  computed_by    text,
  computed_at    timestamptz not null default now()
);
comment on table public.tieout_snapshots is
  'Mig 193 (OM-9): an immutable proof — the five ties (trial balance, A/R, A/P, bank, equity) as computed when the preparer signed. The certificate references the snapshot id; the hash is over the ties JSON.';

create index if not exists ix_tieout_snapshots_project on public.tieout_snapshots (project_id, computed_at desc);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tieout_snapshots_values_chk') then
    alter table public.tieout_snapshots add constraint tieout_snapshots_values_chk
      check (kind in ('cutover_tb','monthly_grid','subledger','independent','shadow_close')
             and content_hash ~ '^[0-9a-f]{64}$'
             and blocker_count >= 0
             and (not all_tied or blocker_count = 0)
             and jsonb_typeof(ties) = 'array');
  end if;
end $$;

-- ── §10 conversion certificates ──────────────────────────────────────────────
create table if not exists public.conversion_certificates (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references core.organizations(id) on delete cascade,
  location_id             uuid not null references core.locations(id) on delete cascade,
  project_id              uuid not null references public.migration_projects(id) on delete cascade,
  certificate_number      text not null,
  version                 integer not null default 1,
  supersedes_id           uuid references public.conversion_certificates(id) on delete set null,
  status                  text not null default 'prepared',
  cutover_date            date not null,
  history_depth           text not null,
  snapshot_id             uuid not null references public.tieout_snapshots(id),  -- NO ACTION: checked at statement end (org purge cascades cleanly)
  sources                 jsonb not null default '[]'::jsonb,
  mapping_summary         jsonb not null default '{}'::jsonb,
  preflight_dispositions  jsonb not null default '[]'::jsonb,
  ties                    jsonb not null default '[]'::jsonb,
  content_hash            text not null,
  prepared_by             text not null,
  prepared_at             timestamptz not null default now(),
  approved_by             text,
  approved_at             timestamptz,
  void_reason             text,
  voided_by               text,
  voided_at               timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
comment on table public.conversion_certificates is
  'Mig 193 (OM-10): the Conversion Certificate. The preparer signs the balance proof; a DIFFERENT person signs it off (CHECK). Issued needs the approver; voided needs a reason. One live certificate per project.';

create unique index if not exists ux_conversion_certificates_number on public.conversion_certificates (org_id, certificate_number);
create unique index if not exists ux_conversion_certificates_live on public.conversion_certificates (project_id) where status <> 'voided';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversion_certificates_values_chk') then
    alter table public.conversion_certificates add constraint conversion_certificates_values_chk
      check (certificate_number ~ '^CC-[0-9]{4,}$'
             and version >= 1
             and status in ('prepared','issued','voided')
             and history_depth in ('opening_only','monthly','monthly_plus_detail')
             and content_hash ~ '^[0-9a-f]{64}$'
             -- segregation of duties: the reviewer who signs off is never the preparer
             and (approved_by is null or approved_by <> prepared_by)
             and (status <> 'issued' or (approved_by is not null and approved_at is not null))
             and (status <> 'voided' or (char_length(btrim(coalesce(void_reason, ''))) >= 10
                                         and voided_by is not null and voided_at is not null))
             and jsonb_typeof(sources) = 'array'
             and jsonb_typeof(ties) = 'array'
             and jsonb_typeof(preflight_dispositions) = 'array'
             and jsonb_typeof(mapping_summary) = 'object');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'migration_projects_certificate_fk') then
    alter table public.migration_projects add constraint migration_projects_certificate_fk
      foreign key (certificate_id) references public.conversion_certificates (id);  -- NO ACTION (see snapshot_id)
  end if;
end $$;

-- ── §11 events (append-only) ─────────────────────────────────────────────────
create table if not exists public.migration_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references core.organizations(id) on delete cascade,
  location_id  uuid not null references core.locations(id) on delete cascade,
  project_id   uuid not null references public.migration_projects(id) on delete cascade,
  kind         text not null,
  actor        text,
  actor_kind   text not null default 'user',
  summary      text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
comment on table public.migration_events is
  'Mig 193: append-only trail of a client migration — what the system did and what people decided (stage moves, files, checks, matches, signatures, comments).';

create index if not exists ix_migration_events_project on public.migration_events (project_id, created_at desc);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'migration_events_values_chk') then
    alter table public.migration_events add constraint migration_events_values_chk
      check (kind in ('created','plan_updated','stage_changed','stage_skipped','source_added','source_removed',
                      'source_status','file_staged','pull_staged','preflight_run','finding_decided',
                      'mapping_proposed','mapping_decided','rule_settled','master_decided','opening_staged',
                      'proof_signed','certificate_issued','certificate_voided','went_live','comment','ask')
             and actor_kind in ('user','system')
             and char_length(summary) between 1 and 600
             and jsonb_typeof(detail) = 'object');
  end if;
end $$;

-- ── §12 RLS + grants (members read their org; service role writes) ───────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['migration_waves', 'migration_projects', 'migration_sources', 'migration_runs',
                           'staged_records', 'mapping_sets', 'mapping_rules', 'mapping_rule_evidence',
                           'client_mappings', 'preflight_findings', 'tieout_snapshots',
                           'conversion_certificates', 'migration_events'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t
                and policyname not in ('client_scope_rls', 'projects_only_seat_deny') loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy member_read on public.%I for select to authenticated using (org_id = public.get_org_id())', t);
    execute format('create policy service_all on public.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- Proof and trail are immutable: the service role may only add and read them.
revoke update, delete, truncate on table public.tieout_snapshots from service_role;
revoke update, delete, truncate on table public.migration_events from service_role;

-- Keep updated_at fresh if the shared trigger fn exists (no new function).
do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    foreach t in array array['migration_waves', 'migration_projects', 'migration_sources', 'mapping_sets',
                             'mapping_rules', 'client_mappings', 'preflight_findings', 'conversion_certificates'] loop
      begin
        execute format('create trigger trg_%s_updated before update on public.%I for each row execute function public.set_updated_at()', t, t);
      exception when duplicate_object then null; end;
    end loop;
  end if;
end $$;

-- End migration 193.

-- ── §13 client scope + Projects-only seat deny (guarded: absent in the replay) ─
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
do $$
declare t text;
begin
  if to_regprocedure('core.apply_projects_only_seat_deny(regclass)') is not null then
    foreach t in array array['migration_waves', 'migration_projects', 'migration_sources', 'migration_runs',
                             'staged_records', 'mapping_sets', 'mapping_rules', 'mapping_rule_evidence',
                             'client_mappings', 'preflight_findings', 'tieout_snapshots',
                             'conversion_certificates', 'migration_events'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;
