-- =============================================================================
-- Migration 188: document intelligence — classify every document and route its
--                content to the right module (docs/FPB-document-intelligence.md).
-- =============================================================================
-- §1  public.document_intelligence   one row per document: what it is (doc_class), how
--                                    sure, who typed it (ai | rules | user), which company
--                                    it belongs to (location_id + source), counterparty,
--                                    key dates, amount (bigint cents), summary, the bytes'
--                                    SHA-256 (dedupe), status, and the AI retry state the
--                                    `documents.classify_retry` job works from.
-- §2  public.document_proposals      one row per (document, target kind): the module
--                                    proposal. staged = the existing extractor's output in
--                                    the module's parse-response shape; native = a draft in
--                                    the module's own queue (AP intake ai_decisions row,
--                                    vendor_document_submissions row); route = typed and
--                                    pointed at the page. Accepting is done by the MODULE's
--                                    own create path — this table never creates a lease,
--                                    loan, bill or journal line.
--                                    UNIQUE (org, document, target kind) + partial UNIQUE
--                                    (org, content_sha256, target kind) while pending /
--                                    accepted → the same file never yields a second lease.
-- §3  public.document_links          two-way document ↔ record links (target_type,
--                                    target_id) with provenance (ai | user | module).
-- §4  RLS + grants: members SELECT their org only; every write is the service role (the
--     app, after its permission check, org pinned — the 171 / 184 pattern). anon nothing.
--     M1 lesson: no new functions.
-- §5  core.apply_client_scope_rls() re-run (all three tables carry location_id).
--
-- No GL effect. Idempotent. PGlite-compatible (no subqueries in CHECKs). Apply to
-- Supabase FIRST, then commit the code that depends on it.
-- =============================================================================

-- ── §1 document_intelligence ─────────────────────────────────────────────────
create table if not exists public.document_intelligence (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  document_id       uuid not null references public.documents(id) on delete cascade,
  -- The company the document belongs to (suggested or confirmed). Null = not known yet.
  location_id       uuid references core.locations(id) on delete set null,
  location_source   text,
  content_sha256    text,
  duplicate_of      uuid references public.documents(id) on delete set null,
  doc_class         text not null default 'other',
  confidence        numeric(4,3) not null default 0,
  class_source      text not null default 'rules',
  rules_class       text,
  rules_confidence  numeric(4,3),
  status            text not null default 'queued',
  ai_status         text not null default 'pending',
  ai_attempts       integer not null default 0,
  next_retry_at     timestamptz,
  ai_last_error     text,
  ai_model          text,
  ai_decision_id    uuid,
  counterparty      text,
  company_hint      text,
  key_dates         jsonb not null default '{}'::jsonb,
  amount_cents      bigint,
  summary           text,
  reason            text,
  text_chars        integer,
  source            text not null default 'center',
  classified_at     timestamptz,
  routed_at         timestamptz,
  reviewed_by       text,
  reviewed_at       timestamptz,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.document_intelligence is
  'Mig 188: what each document is and where it goes (FPB-document-intelligence). AI or deterministic rules classify; a person confirms. Written only by the service role (lib/documents/intelligence). No GL effect.';

create unique index if not exists ux_document_intelligence_doc on public.document_intelligence (org_id, document_id);
create index if not exists ix_document_intelligence_status on public.document_intelligence (org_id, status, created_at desc);
create index if not exists ix_document_intelligence_retry on public.document_intelligence (next_retry_at)
  where next_retry_at is not null;
create index if not exists ix_document_intelligence_hash on public.document_intelligence (org_id, content_sha256);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'document_intelligence_values_chk') then
    alter table public.document_intelligence add constraint document_intelligence_values_chk
      check (doc_class in ('lease','loan','insurance_policy','coi','w9','vendor_bill','customer_contract',
                           'purchase_order','bank_statement','card_statement','payroll_register',
                           'fixed_asset_invoice','subscription','formation','tax_document','form_1099',
                           'budget','prepaid','ledger_report','other')
             and (rules_class is null or rules_class in ('lease','loan','insurance_policy','coi','w9','vendor_bill',
                           'customer_contract','purchase_order','bank_statement','card_statement',
                           'payroll_register','fixed_asset_invoice','subscription','formation','tax_document',
                           'form_1099','budget','prepaid','ledger_report','other'))
             and class_source in ('ai','rules','user')
             and status in ('queued','classified','routed','proposal_created','accepted','linked',
                            'dismissed','needs_review','duplicate')
             and ai_status in ('pending','done','unavailable','failed','budget_blocked','skipped')
             and source in ('center','onboarding','email','portal','backfill','module')
             and (location_source is null or location_source in ('ai','rules','user','single_company','upload'))
             and confidence >= 0 and confidence <= 1
             and (rules_confidence is null or (rules_confidence >= 0 and rules_confidence <= 1))
             and ai_attempts >= 0
             and (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$')
             and jsonb_typeof(key_dates) = 'object');
  end if;
end $$;

-- ── §2 document_proposals ────────────────────────────────────────────────────
create table if not exists public.document_proposals (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references core.organizations(id) on delete cascade,
  document_id          uuid not null references public.documents(id) on delete cascade,
  intelligence_id      uuid references public.document_intelligence(id) on delete cascade,
  location_id          uuid references core.locations(id) on delete set null,
  target_kind          text not null,
  mode                 text not null,
  status               text not null default 'pending',
  extract_state        text not null default 'pending',
  payload              jsonb not null default '{}'::jsonb,
  title                text,
  summary              text,
  confidence           numeric(4,3),
  extractor_feature    text,
  extractor_model      text,
  ai_decision_id       uuid,
  native_table         text,
  native_id            uuid,
  target_href          text,
  content_sha256       text,
  accepted_target_type text,
  accepted_target_id   uuid,
  decided_by           text,
  decided_at           timestamptz,
  decision_note        text,
  last_error           text,
  created_by           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table public.document_proposals is
  'Mig 188: a module proposal made from a document (a lease, loan, policy, bill draft, vendor submission …). The module''s own create path finalizes; this row records the outcome. Written only by the service role.';

create unique index if not exists ux_document_proposals_doc_kind on public.document_proposals (org_id, document_id, target_kind);
create unique index if not exists ux_document_proposals_hash_kind on public.document_proposals (org_id, content_sha256, target_kind)
  where content_sha256 is not null and status in ('pending','accepted');
create index if not exists ix_document_proposals_target on public.document_proposals (org_id, target_kind, status, created_at desc);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'document_proposals_values_chk') then
    alter table public.document_proposals add constraint document_proposals_values_chk
      check (target_kind in ('lease','debt_instrument','insurance_policy','prepaid','subscription',
                             'customer_contract','fixed_asset','bill','vendor_coi','vendor_w9',
                             'payroll_register','bank_statement','formation','budget','filed')
             and mode in ('staged','native','route')
             and status in ('pending','accepted','dismissed','superseded','failed')
             and extract_state in ('done','pending','failed','not_needed')
             and (confidence is null or (confidence >= 0 and confidence <= 1))
             and (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$')
             and (status not in ('accepted','dismissed') or decided_at is not null)
             and jsonb_typeof(payload) = 'object');
  end if;
end $$;

-- ── §3 document_links ────────────────────────────────────────────────────────
create table if not exists public.document_links (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.organizations(id) on delete cascade,
  document_id   uuid not null references public.documents(id) on delete cascade,
  target_type   text not null,
  target_id     uuid not null,
  location_id   uuid references core.locations(id) on delete set null,
  link_kind     text not null default 'source',
  created_via   text not null default 'user',
  proposal_id   uuid references public.document_proposals(id) on delete set null,
  label         text,
  created_by    text,
  created_at    timestamptz not null default now()
);
comment on table public.document_links is
  'Mig 188: two-way document ↔ record links ("Linked to Lease: Office – 123 Main" / "Source document"). created_via ai | user | module. Written only by the service role.';

create unique index if not exists ux_document_links_pair on public.document_links (org_id, document_id, target_type, target_id);
create index if not exists ix_document_links_target on public.document_links (org_id, target_type, target_id);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'document_links_values_chk') then
    alter table public.document_links add constraint document_links_values_chk
      check (link_kind in ('source','supporting')
             and created_via in ('ai','user','module')
             and char_length(target_type) between 1 and 64
             and target_type ~ '^[a-z][a-z0-9_]*$');
  end if;
end $$;

-- ── §4 RLS + grants (members read their org; service role writes) ─────────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['document_intelligence', 'document_proposals', 'document_links'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t and policyname not in ('client_scope_rls', 'projects_only_seat_deny', 'governance_release_gate', 'budget_department_scope') loop
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

-- Keep updated_at fresh if the shared trigger fn exists.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    begin
      create trigger trg_document_intelligence_updated before update on public.document_intelligence
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
    begin
      create trigger trg_document_proposals_updated before update on public.document_proposals
        for each row execute function public.set_updated_at();
    exception when duplicate_object then null; end;
  end if;
end $$;

-- End migration 188.

-- ── §5 client scope (every new table carries location_id) ────────────────────
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;

-- ── Projects-only seat deny (1110 contract; guarded: absent in the PGlite replay) ──
-- Every RLS table this migration creates gets the RESTRICTIVE projects_only_seat_deny policy.
do $$
declare t text;
begin
  if to_regprocedure('core.apply_projects_only_seat_deny(regclass)') is not null then
    foreach t in array array['document_intelligence', 'document_proposals', 'document_links'] loop
      perform core.apply_projects_only_seat_deny(('public.' || t)::regclass);
    end loop;
  end if;
end $$;
