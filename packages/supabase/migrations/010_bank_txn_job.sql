-- Migration 010: Add job_id columns to bank_transactions
-- Enables job costing from bank feed: COGS transactions require job assignment.

ALTER TABLE bank_transactions ADD COLUMN job_id uuid REFERENCES jobs(id);
ALTER TABLE bank_transactions ADD COLUMN final_job_id uuid REFERENCES jobs(id);

CREATE INDEX idx_bank_txns_job ON bank_transactions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_bank_txns_final_job ON bank_transactions(final_job_id) WHERE final_job_id IS NOT NULL;
