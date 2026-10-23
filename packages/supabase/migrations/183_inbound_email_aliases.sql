-- =============================================================================
-- Migration 183: per-company inbound email addresses + inbound message log (Wave 2D)
-- =============================================================================
-- FPB: docs/FPB-ap-intake.md (audit §2.6, AP-01, AP-02, IN-04).
--
-- THE GAP. Migration 135 gave each TENANT one inbound AP address, so every emailed
-- bill landed on the default company, and the address was never shown. This gives
-- every COMPANY two addresses — ap-<company>@<domain> (vendor bills) and
-- receipts-<company>@<domain> (receipts, slice 2B) — and logs every message.
--
-- §1  core.inbound_aliases          one address = one company + one purpose; sender
--                                   rules; Gmail forwarding-confirmation capture
-- §2  core.inbound_messages         one row per (message, address): what came in and
--                                   what happened; UNIQUE provider id = redelivery guard
-- §3  core.inbound_attachment_fingerprints  sha256 per drafted attachment, UNIQUE per
--                                   org = the "same PDF twice" guarantor
-- §4  slug + alias generation: core.inbound_alias_slug(), core.ensure_inbound_aliases(),
--     an AFTER INSERT trigger on core.locations, and a backfill of every company.
--     Local parts are GLOBALLY unique on the shared platform domain (domain null) and
--     never collide with another org's legacy (135) address.
-- §5  RLS + grants (171 pattern): members SELECT their org; every write is the service
--     role (the app, after its permission check, org pinned). Client scope re-applied.
--
-- The domain itself is NOT stored for platform aliases (domain null): the app composes
-- local_part@INBOUND_EMAIL_DOMAIN, so moving the inbound domain is an env change.
-- Addresses are stable: renaming a company does NOT change its address (vendors use it).
--
-- M1 lesson: every new function is EXECUTE-revoked from public/anon/authenticated, then
-- granted explicitly. Idempotent. PGlite-compatible (no subqueries in CHECK). No GL effect.
-- Apply to Supabase FIRST, then commit the code that uses it.
-- =============================================================================

-- ── §1 inbound_aliases ────────────────────────────────────────────────────────
create table if not exists core.inbound_aliases (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references core.organizations(id) on delete cascade,
  location_id           uuid not null references core.locations(id) on delete cascade,
  purpose               text not null,
  local_part            text not null,
  domain                text,
  is_active             boolean not null default true,
  sender_rule           text not null default 'known_vendors',
  allowed_domains       text[] not null default array[]::text[],
  allowed_senders       text[] not null default array[]::text[],
  fwd_confirm_from      text,
  fwd_confirm_code      text,
  fwd_confirm_url       text,
  fwd_confirm_at        timestamptz,
  fwd_confirm_verified  boolean,
  last_received_at      timestamptz,
  messages_count        integer not null default 0,
  updated_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table core.inbound_aliases is
  'Mig 183: one inbound email address per company and purpose (ap | receipts). domain null = the platform domain (INBOUND_EMAIL_DOMAIN). Created by trigger on core.locations; written only by the service role (lib/email/inbound-aliases).';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbound_aliases_purpose_chk') then
    alter table core.inbound_aliases add constraint inbound_aliases_purpose_chk
      check (purpose in ('ap', 'receipts'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_aliases_local_chk') then
    alter table core.inbound_aliases add constraint inbound_aliases_local_chk
      check (local_part ~ '^[a-z0-9][a-z0-9-]{1,62}$' and right(local_part, 1) <> '-');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_aliases_domain_chk') then
    alter table core.inbound_aliases add constraint inbound_aliases_domain_chk
      check (domain is null or (domain = lower(domain) and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_aliases_rule_chk') then
    alter table core.inbound_aliases add constraint inbound_aliases_rule_chk
      check (sender_rule in ('any', 'known_vendors', 'listed_domains')
             and cardinality(allowed_domains) <= 100
             and cardinality(allowed_senders) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_aliases_fwd_chk') then
    -- a forwarding-confirmation link is only ever shown if it is an https google.com URL
    alter table core.inbound_aliases add constraint inbound_aliases_fwd_chk
      check ((fwd_confirm_url is null or fwd_confirm_url ~ '^https://([a-z0-9-]+\.)*google\.com/')
             and (fwd_confirm_code is null or fwd_confirm_code ~ '^[0-9]{4,12}$')
             and messages_count >= 0);
  end if;
end $$;

-- Security review (Wave 2 M6): a new address accepts only verified known vendors + the
-- team (+ cardholders on receipts addresses) until an admin opens it up. Re-applied for a
-- DB that ran an earlier draft of this migration with default 'any'.
alter table core.inbound_aliases alter column sender_rule set default 'known_vendors';

create unique index if not exists ux_inbound_aliases_platform_local
  on core.inbound_aliases (lower(local_part)) where domain is null;
create unique index if not exists ux_inbound_aliases_domain_local
  on core.inbound_aliases (lower(domain), lower(local_part)) where domain is not null;
create unique index if not exists ux_inbound_aliases_company_purpose
  on core.inbound_aliases (location_id, purpose);
create index if not exists ix_inbound_aliases_org on core.inbound_aliases (org_id, purpose);

-- ── §2 inbound_messages ───────────────────────────────────────────────────────
create table if not exists core.inbound_messages (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references core.organizations(id) on delete cascade,
  location_id            uuid references core.locations(id) on delete cascade,
  alias_id               uuid references core.inbound_aliases(id) on delete set null,
  purpose                text not null default 'ap',
  provider               text not null,
  provider_message_id    text not null,
  message_id_header      text,
  from_address           text not null,
  from_name              text,
  to_address             text not null,
  subject                text,
  received_at            timestamptz not null default now(),
  attachments_count      integer not null default 0,
  accepted_count         integer not null default 0,
  outcome                text not null default 'processing',
  detail                 text,
  attachments            jsonb not null default '[]'::jsonb,
  intake_draft_ids       uuid[] not null default array[]::uuid[],
  bill_ids               uuid[] not null default array[]::uuid[],
  document_ids           uuid[] not null default array[]::uuid[],
  receipt_ids            uuid[] not null default array[]::uuid[],
  email_document_id      uuid,
  spam_score             numeric(6,2),
  sender_verified        boolean not null default false,
  sender_auth            text,
  duplicate_deliveries   integer not null default 0,
  last_duplicate_at      timestamptz,
  processing_started_at  timestamptz not null default now(),
  processed_at           timestamptz,
  created_at             timestamptz not null default now()
);
comment on table core.inbound_messages is
  'Mig 183: every inbound email attributable to a tenant — one row per (message, address). The UNIQUE (org, to_address, provider, provider_message_id) key is the redelivery guarantor. Rejected senders: the log row only, never their content. Service-role writes.';

-- Wave 2 M6: the provider's SPF/DKIM/DMARC verdict on the From address (for an earlier draft).
alter table core.inbound_messages add column if not exists sender_verified boolean not null default false;
alter table core.inbound_messages add column if not exists sender_auth text;
comment on column core.inbound_messages.sender_verified is
  'Mig 183 (M6): the receiving provider verified the From domain (DMARC pass, or aligned DKIM / SPF pass). false = the sender is treated as unknown (no vendor match, no cardholder trust, no known-vendor rule pass) and the log/draft says "Sender not verified".';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbound_messages_outcome_chk') then
    alter table core.inbound_messages add constraint inbound_messages_outcome_chk
      check (outcome in ('processing','bill_drafted','receipt_attached','ignored_duplicate','rejected_sender',
                         'rejected_spam','alias_inactive','no_attachment','forwarding_confirmation','not_handled','failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inbound_messages_values_chk') then
    alter table core.inbound_messages add constraint inbound_messages_values_chk
      check (purpose in ('ap','receipts')
             and provider in ('postmark','sendgrid','generic')
             and length(provider_message_id) between 1 and 500
             and length(from_address) between 1 and 320
             and length(to_address) between 3 and 320
             and attachments_count >= 0 and accepted_count >= 0 and duplicate_deliveries >= 0
             and jsonb_typeof(attachments) = 'array');
  end if;
end $$;

create unique index if not exists ux_inbound_messages_delivery
  on core.inbound_messages (org_id, lower(to_address), provider, provider_message_id);
create index if not exists ix_inbound_messages_org_time on core.inbound_messages (org_id, received_at desc);
create index if not exists ix_inbound_messages_location_time on core.inbound_messages (location_id, received_at desc);
create index if not exists ix_inbound_messages_alias on core.inbound_messages (alias_id, received_at desc);

-- ── §3 inbound_attachment_fingerprints ────────────────────────────────────────
create table if not exists core.inbound_attachment_fingerprints (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references core.organizations(id) on delete cascade,
  location_id       uuid references core.locations(id) on delete cascade,
  sha256            text not null,
  file_name         text,
  size_bytes        bigint,
  inbound_message_id uuid references core.inbound_messages(id) on delete set null,
  intake_draft_id   uuid,
  document_id       uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table core.inbound_attachment_fingerprints is
  'Mig 183: sha256 of every emailed attachment that became a draft bill. UNIQUE (org_id, sha256) — the same PDF can never draft twice in one tenant (a rejected draft releases its fingerprint in the app).';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inbound_fingerprints_sha_chk') then
    alter table core.inbound_attachment_fingerprints add constraint inbound_fingerprints_sha_chk
      check (sha256 ~ '^[0-9a-f]{64}$' and (size_bytes is null or size_bytes >= 0));
  end if;
end $$;
create unique index if not exists ux_inbound_fingerprints_org_sha on core.inbound_attachment_fingerprints (org_id, sha256);

-- ── §4 slug + alias generation ────────────────────────────────────────────────
-- "Heritage Interiors, LLC" → heritage-interiors ; "[SANDBOX] Coho Flooring" → coho-flooring.
create or replace function core.inbound_alias_slug(p_name text) returns text
  language sql immutable set search_path = pg_catalog, pg_temp as
$$
  select coalesce(
    nullif(
      trim(both '-' from left(
        trim(both '-' from regexp_replace(
          regexp_replace(
            regexp_replace(lower(coalesce(p_name, '')), '\[[^]]*\]', ' ', 'g'),
            '[[:space:],]+(llc|l\.l\.c\.|inc|incorporated|corp|corporation|co|ltd|lp|llp|pllc|pc)\.?[[:space:]]*$', '', 'g'),
          '[^a-z0-9]+', '-', 'g')),
        40)),
      ''),
    'company')
$$;

-- Is this local part unavailable for the given company? Taken by another company's alias
-- on the platform domain, or equal to ANOTHER org's legacy (135) inbound_ap_address.
create or replace function core.inbound_local_taken(p_local text, p_location uuid, p_org uuid) returns boolean
  language sql stable security definer set search_path = core, public, pg_temp as
$$
  select exists (
           select 1 from core.inbound_aliases a
            where a.domain is null and lower(a.local_part) = lower(p_local) and a.location_id <> p_location)
      or exists (
           select 1 from core.organizations o
            where o.id <> p_org and o.inbound_ap_address is not null
              and lower(split_part(o.inbound_ap_address, '@', 1)) = lower(p_local))
$$;

-- Give one company its ap- and receipts- addresses (idempotent; returns rows created).
-- Both purposes share one slug: the company name, then name + org slug, then name-2…
create or replace function core.ensure_inbound_aliases(p_location uuid) returns integer
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
declare
  v_org uuid; v_name text; v_org_slug text; v_base text; v_slug text; v_cand text;
  v_existing text; v_try int; v_n int := 0; v_purpose text;
begin
  select l.org_id, l.name, o.slug into v_org, v_name, v_org_slug
    from core.locations l join core.organizations o on o.id = l.org_id
   where l.id = p_location;
  if v_org is null then return 0; end if;

  -- reuse the slug of an alias this company already has (keeps ap-/receipts- paired)
  select a.local_part into v_existing from core.inbound_aliases a
   where a.location_id = p_location and a.domain is null order by a.created_at limit 1;
  if v_existing is not null then
    v_slug := regexp_replace(v_existing, '^(ap|receipts)-', '');
  else
    v_base := core.inbound_alias_slug(v_name);
    for v_try in 0 .. 60 loop
      v_cand := case
        when v_try = 0 then v_base
        when v_try = 1 then
          case when v_org_slug is null then null
               else trim(both '-' from left(v_base || '-' || core.inbound_alias_slug(v_org_slug), 40)) end
        else trim(both '-' from left(v_base, 36)) || '-' || v_try::text
      end;
      continue when v_cand is null;
      if not core.inbound_local_taken('ap-' || v_cand, p_location, v_org)
         and not core.inbound_local_taken('receipts-' || v_cand, p_location, v_org) then
        v_slug := v_cand;
        exit;
      end if;
    end loop;
    if v_slug is null then
      v_slug := trim(both '-' from left(v_base, 24)) || '-' || substr(replace(p_location::text, '-', ''), 1, 8);
    end if;
  end if;

  foreach v_purpose in array array['ap', 'receipts'] loop
    insert into core.inbound_aliases (org_id, location_id, purpose, local_part)
    values (v_org, p_location, v_purpose, v_purpose || '-' || v_slug)
    on conflict do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end
$$;

-- New company → addresses. Never blocks company creation: a failure only warns
-- (the app re-runs ensure_inbound_aliases lazily when it lists addresses).
create or replace function core.trg_locations_inbound_aliases() returns trigger
  language plpgsql security definer set search_path = core, public, pg_temp as
$$
begin
  begin
    perform core.ensure_inbound_aliases(new.id);
  exception when others then
    raise warning 'inbound alias generation failed for location %: %', new.id, sqlerrm;
  end;
  return new;
end
$$;

drop trigger if exists trg_locations_inbound_aliases on core.locations;
create trigger trg_locations_inbound_aliases after insert on core.locations
  for each row execute function core.trg_locations_inbound_aliases();

revoke all on function core.inbound_alias_slug(text) from public, anon;
grant execute on function core.inbound_alias_slug(text) to authenticated, service_role;
revoke all on function core.inbound_local_taken(text, uuid, uuid) from public, anon, authenticated;
grant execute on function core.inbound_local_taken(text, uuid, uuid) to service_role;
revoke all on function core.ensure_inbound_aliases(uuid) from public, anon, authenticated;
grant execute on function core.ensure_inbound_aliases(uuid) to service_role;
revoke all on function core.trg_locations_inbound_aliases() from public, anon, authenticated;

-- Backfill every existing company (oldest first, so the first company keeps the plain slug).
do $$
declare r record;
begin
  for r in select id from core.locations order by created_at, id loop
    perform core.ensure_inbound_aliases(r.id);
  end loop;
end $$;

-- Wave 2 M6: any address the backfill / trigger created with the old 'any' default and no
-- person has edited since (updated_by null) moves to 'known_vendors'. Addresses an admin
-- deliberately set (updated_by not null) keep their rule.
update core.inbound_aliases
   set sender_rule = 'known_vendors', updated_at = now()
 where sender_rule = 'any' and updated_by is null;

-- ── §5 RLS + grants ───────────────────────────────────────────────────────────
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['inbound_aliases', 'inbound_messages', 'inbound_attachment_fingerprints'] loop
    execute format('alter table core.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'core' and tablename = t and policyname <> 'client_scope_rls' loop
      execute format('drop policy if exists %I on core.%I', p.policyname, t);
    end loop;
    execute format(
      'create policy member_read on core.%I for select to authenticated using (org_id is not null and org_id = public.get_org_id())', t);
    execute format('create policy service_all on core.%I for all to service_role using (true) with check (true)', t);
    execute format('revoke all on table core.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on table core.%I from authenticated', t);
    execute format('grant select on table core.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table core.%I to service_role', t);
  end loop;
end $$;

-- End migration 183.
do $$ begin
  if to_regprocedure('core.apply_client_scope_rls()') is not null then
    perform core.apply_client_scope_rls();
  end if;
end $$;
