-- Migration 018: Make gl_entries user-attribution columns nullable (Session 13)
--
-- Context: created_by / posted_by on gl_entries are typed uuid, but this app
-- authenticates with Clerk, whose user IDs are TEXT (e.g. "user_3Bw...") and do
-- not cast to uuid. Writing the Clerk id fails ("invalid input syntax for type
-- uuid"); the internal-invoice booking code therefore writes NULL for these
-- columns (the lifecycle TIMESTAMPS still capture WHEN each action happened).
-- created_by was NOT NULL, which blocked the null write, so we drop NOT NULL.
-- posted_by was already nullable; the statement is idempotent and harmless.
--
-- This was applied live against production on 2026-05-30 to unblock the
-- internal-invoice -> GL booking flow; this file records it so the repo and
-- database stay in sync.
--
-- NOTE (deferred, tracked): the proper fix for audit attribution is to convert
-- these columns (and the internal_invoices.*_by columns) from uuid to TEXT so
-- they can store the Clerk id. That ALTER is blocked because five financial
-- views depend on these tables (v_balance_sheet, v_gl_detail,
-- v_income_statement, v_journal_entry_audit, v_trial_balance) and a TYPE change
-- requires dropping and recreating those views. Handle that as its own careful
-- migration. A column-TYPE change is blocked by dependent views; a NOT NULL
-- constraint change (this migration) is not.

alter table gl_entries alter column created_by drop not null;
alter table gl_entries alter column posted_by drop not null;
