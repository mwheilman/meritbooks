-- Migration 011: Enhance Jobs for Construction/HVAC Reality
-- The base jobs table has contract_amount and estimated_cost but is missing
-- the pricing model, markup rate, retainage percentage, and contact fields
-- that construction, HVAC, and cabinetry businesses need daily.

-- Pricing model: determines how revenue is calculated
-- FIXED_PRICE: contract_amount is the revenue ceiling
-- COST_PLUS: revenue = actual_cost × (1 + markup_pct/100)
-- TIME_AND_MATERIALS: revenue = labor_hours × bill_rate + materials + markup
-- UNIT_PRICE: revenue = units_completed × unit_price (less common)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pricing_model text
  NOT NULL DEFAULT 'FIXED_PRICE'
  CHECK (pricing_model IN ('FIXED_PRICE', 'COST_PLUS', 'TIME_AND_MATERIALS', 'UNIT_PRICE'));

-- Markup percentage for cost-plus and T&M jobs
-- e.g., 15.00 = 15% markup on costs
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS markup_pct numeric(5,2) DEFAULT 0;

-- Estimated total revenue (distinct from contract_amount for cost-plus)
-- For fixed price: estimated_revenue = contract_amount
-- For cost-plus: estimated_revenue = estimated_cost × (1 + markup_pct/100)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimated_revenue_cents bigint;

-- Retainage: percentage withheld from each draw until completion
-- Standard construction: 5-10%
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retainage_pct numeric(5,2) DEFAULT 0;

-- Job site / project location (different from the company location)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_site_address text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_site_city text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_site_state text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_site_zip text;

-- Project contacts
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS superintendent text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project_manager text;

-- Sales tax: is this job taxable? Which jurisdiction?
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_taxable boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tax_jurisdiction text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tax_rate_pct numeric(5,3) DEFAULT 0;

-- Actual revenue recognized vs billed (for WIP analysis)
-- actual_revenue_cents tracks what's been earned per rev rec method
-- billed_to_date_cents already exists (what's been invoiced)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actual_revenue_cents bigint NOT NULL DEFAULT 0;

-- Original contract amount (before change orders)
-- contract_amount_cents gets updated as COs are approved
-- This preserves the original for comparison
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS original_contract_cents bigint;

-- Approved change order total (running sum for quick reference)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS approved_co_cents bigint NOT NULL DEFAULT 0;

-- Notes / special conditions
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN jobs.pricing_model IS 'FIXED_PRICE, COST_PLUS, TIME_AND_MATERIALS, or UNIT_PRICE';
COMMENT ON COLUMN jobs.markup_pct IS 'For cost-plus/T&M: markup applied to costs to calculate revenue';
COMMENT ON COLUMN jobs.estimated_revenue_cents IS 'Total expected revenue. Fixed=contract, Cost-plus=est_cost*(1+markup)';
COMMENT ON COLUMN jobs.retainage_pct IS 'Percentage withheld from draws. Standard 5-10% for construction';
COMMENT ON COLUMN jobs.original_contract_cents IS 'Contract amount at job creation, before change orders';
COMMENT ON COLUMN jobs.approved_co_cents IS 'Running total of approved change order amounts';
