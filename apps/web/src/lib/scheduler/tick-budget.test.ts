/**
 * Guard: every scheduler job must be able to START inside one tick. runTick only starts a unit
 * while the budget left is ≥ the job's timeoutMs, so a job whose timeoutMs is not strictly below
 * the tick budget (dispatch.ts TICK_BUDGET_MS) would be deferred on every tick and never run
 * (the documents-classify-retry incident). Covers the registry and the jobs still waiting for
 * the lead to register them.
 */

import { describe, it, expect } from 'vitest';
import { JOBS } from './registry';
import { TICK_BUDGET_MS } from './dispatch';
import { CASH_FORECAST_SNAPSHOT_JOB } from '@/lib/cash/forecast/snapshot-job';

describe('scheduler tick budget', () => {
  it('every registered job has 0 < timeoutMs < TICK_BUDGET_MS', () => {
    const over = JOBS.filter((j) => !(j.timeoutMs > 0 && j.timeoutMs < TICK_BUDGET_MS)).map((j) => `${j.key}: ${j.timeoutMs} ms`);
    expect(over, `jobs that can never start inside a ${TICK_BUDGET_MS} ms tick`).toEqual([]);
  });

  it('the cash forecast snapshot job (pending registration) fits too', () => {
    expect(CASH_FORECAST_SNAPSHOT_JOB.timeoutMs).toBeGreaterThan(0);
    expect(CASH_FORECAST_SNAPSHOT_JOB.timeoutMs).toBeLessThan(TICK_BUDGET_MS);
  });
});
