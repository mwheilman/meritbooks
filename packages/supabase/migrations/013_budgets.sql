-- Migration 013: Budget table for GL account-level budgets
-- Enables audit #113: Budget vs Actual with variance

CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  department_id uuid REFERENCES departments(id),
  fiscal_year int NOT NULL,
  period_number int NOT NULL CHECK (period_number BETWEEN 1 AND 13),
  amount_cents bigint NOT NULL DEFAULT 0,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, location_id, account_id, department_id, fiscal_year, period_number)
);

-- Budget versions for tracking changes
CREATE TABLE IF NOT EXISTS budget_versions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id),
  fiscal_year int NOT NULL,
  version_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_budgets_org ON budgets(org_id);
CREATE INDEX idx_budgets_lookup ON budgets(org_id, location_id, fiscal_year, period_number);
CREATE INDEX idx_budgets_account ON budgets(account_id);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation" ON budgets FOR ALL USING (org_id = public.get_org_id());
CREATE POLICY "org_isolation" ON budget_versions FOR ALL USING (org_id = public.get_org_id());

CREATE TRIGGER trg_budgets_updated_at BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
