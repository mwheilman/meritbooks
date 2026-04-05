-- Migration 012: Expand rev rec and pricing for service companies
-- Merit's portfolio includes marketing, bookkeeping, HR, admin, IT
-- alongside construction/HVAC/cabinetry. Rev rec must handle all types.

-- Add service-company rev rec methods to the enum
ALTER TYPE rev_rec_method_enum ADD VALUE IF NOT EXISTS 'RATABLY';
ALTER TYPE rev_rec_method_enum ADD VALUE IF NOT EXISTS 'AS_BILLED';
ALTER TYPE rev_rec_method_enum ADD VALUE IF NOT EXISTS 'MILESTONE';
ALTER TYPE rev_rec_method_enum ADD VALUE IF NOT EXISTS 'SUBSCRIPTION';

-- Expand pricing_model for service companies
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_pricing_model_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_pricing_model_check
  CHECK (pricing_model IN ('FIXED_PRICE', 'COST_PLUS', 'TIME_AND_MATERIALS', 'UNIT_PRICE', 'RETAINER', 'SUBSCRIPTION', 'HOURLY'));

-- Service engagement fields
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS monthly_retainer_cents bigint;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS service_start_date date;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS service_end_date date;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS billing_frequency text DEFAULT 'MONTHLY'
  CHECK (billing_frequency IN ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY', 'ONE_TIME'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hourly_rate_cents bigint;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_hours numeric(8,2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actual_hours numeric(8,2) NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS total_milestones int;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completed_milestones int NOT NULL DEFAULT 0;

COMMENT ON COLUMN jobs.monthly_retainer_cents IS 'Monthly fee for retainer/subscription engagements';
COMMENT ON COLUMN jobs.billing_frequency IS 'How often the client is invoiced';
COMMENT ON COLUMN jobs.hourly_rate_cents IS 'Bill rate for T&M and hourly engagements';
COMMENT ON COLUMN jobs.budget_hours IS 'Estimated total hours for T&M engagements';
