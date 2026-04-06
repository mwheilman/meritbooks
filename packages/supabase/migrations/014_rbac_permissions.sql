-- Migration 014: Role Permission Overrides
-- Supports the 3-layer RBAC architecture:
--   Layer 1: System defaults (hardcoded in permissions.ts)
--   Layer 2: Tier-level overrides (this table, user_id IS NULL)
--   Layer 3: Individual overrides (this table, user_id IS NOT NULL)
--
-- Resolution: system default → tier override → individual override

-- Tier-level and individual permission overrides
CREATE TABLE IF NOT EXISTS role_permission_overrides (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  
  -- If role is set but employee_id is NULL → tier-level override
  -- If both role and employee_id are set → individual override
  role text NOT NULL,
  employee_id uuid REFERENCES employees(id) ON DELETE CASCADE,
  
  -- The feature being configured
  feature_id text NOT NULL,
  
  -- Action-level permissions (null = inherit from parent layer)
  action_view boolean,
  action_create boolean,
  action_edit boolean,
  action_approve boolean,
  action_delete boolean,
  action_export boolean,
  action_request boolean,
  action_post boolean,
  action_resolve boolean,
  action_reconcile boolean,
  action_manage boolean,
  action_generate boolean,
  action_run boolean,
  action_assign boolean,
  
  -- Metadata
  set_by uuid REFERENCES employees(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Unique: one override per role+feature at tier level, one per employee+feature at individual level
  CONSTRAINT unique_tier_override UNIQUE (org_id, role, feature_id) WHERE employee_id IS NULL,
  CONSTRAINT unique_individual_override UNIQUE (org_id, employee_id, feature_id) WHERE employee_id IS NOT NULL
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_role_perm_overrides_role ON role_permission_overrides(org_id, role) WHERE employee_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_role_perm_overrides_employee ON role_permission_overrides(org_id, employee_id) WHERE employee_id IS NOT NULL;

-- RLS
ALTER TABLE role_permission_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "role_permission_overrides_org_isolation" ON role_permission_overrides
  FOR ALL USING (org_id = (SELECT org_id FROM employees WHERE clerk_user_id = auth.uid() LIMIT 1));

-- Employee-location assignments (if not already created)
-- This tracks which companies each employee can access
CREATE TABLE IF NOT EXISTS employee_locations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES employees(id),
  assigned_at timestamptz DEFAULT now(),
  
  CONSTRAINT unique_employee_location UNIQUE (employee_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_locations_employee ON employee_locations(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_locations_location ON employee_locations(location_id);

ALTER TABLE employee_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_locations_org_isolation" ON employee_locations
  FOR ALL USING (org_id = (SELECT org_id FROM employees WHERE clerk_user_id = auth.uid() LIMIT 1));

-- Add clerk_user_id to employees if not present
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'employees' AND column_name = 'clerk_user_id'
  ) THEN
    ALTER TABLE employees ADD COLUMN clerk_user_id text;
    CREATE INDEX idx_employees_clerk_user ON employees(clerk_user_id);
  END IF;
END $$;

-- Add role column to employees if not present (replacing the old role system)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'employees' AND column_name = 'role'
  ) THEN
    ALTER TABLE employees ADD COLUMN role text DEFAULT 'accounting_specialist';
  END IF;
END $$;

-- Add display_name, website, created_by, deleted_at to vendors if not present
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendors' AND column_name = 'display_name') THEN
    ALTER TABLE vendors ADD COLUMN display_name text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendors' AND column_name = 'website') THEN
    ALTER TABLE vendors ADD COLUMN website text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendors' AND column_name = 'created_by') THEN
    ALTER TABLE vendors ADD COLUMN created_by text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendors' AND column_name = 'deleted_at') THEN
    ALTER TABLE vendors ADD COLUMN deleted_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vendors' AND column_name = 'updated_at') THEN
    ALTER TABLE vendors ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;

-- Add display_name, contact, credit_limit, portfolio flag, deleted_at to customers if not present
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'display_name') THEN
    ALTER TABLE customers ADD COLUMN display_name text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'contact_first_name') THEN
    ALTER TABLE customers ADD COLUMN contact_first_name text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'contact_last_name') THEN
    ALTER TABLE customers ADD COLUMN contact_last_name text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'credit_limit_cents') THEN
    ALTER TABLE customers ADD COLUMN credit_limit_cents bigint;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'tax_exempt') THEN
    ALTER TABLE customers ADD COLUMN tax_exempt boolean DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'tax_id') THEN
    ALTER TABLE customers ADD COLUMN tax_id text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'is_portfolio_company') THEN
    ALTER TABLE customers ADD COLUMN is_portfolio_company boolean DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'location_id') THEN
    ALTER TABLE customers ADD COLUMN location_id uuid REFERENCES locations(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'website') THEN
    ALTER TABLE customers ADD COLUMN website text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'created_by') THEN
    ALTER TABLE customers ADD COLUMN created_by text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'deleted_at') THEN
    ALTER TABLE customers ADD COLUMN deleted_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'updated_at') THEN
    ALTER TABLE customers ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END $$;
