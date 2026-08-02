import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { startRun } from './runner';
import type { AgentRecipe, StepExecuteResult } from './types';

/**
 * The runner engine, tested against a no-DB fake so persistence falls back to
 * EPHEMERAL and audit is a no-op — isolating the drive/sequencing logic. This proves
 * the two safety-critical behaviors: AUTO steps auto-advance, and a PROPOSE/HUMAN_GATE
 * step that returns WAITING pauses the whole run (a human must act).
 */

// A fake client whose every access throws ⇒ persistInsert/recordStepAudit/logAction
// all hit their try/catch and no-op, so the run is ephemeral and un-audited.
const noDb = {
  from() { throw new Error('no db'); },
  schema() { return { from() { throw new Error('no db'); } }; },
} as unknown as SupabaseClient;

const ctx = { supabase: noDb, orgId: 'org-1', userId: 'user-1', locationId: null };

function recipe(steps: AgentRecipe['steps']): AgentRecipe {
  return {
    key: 'TEST',
    label: 'Test recipe',
    description: 'test',
    steps,
    async init() { return { title: 'test run', state: { seeded: true } }; },
  };
}

const done = (summary: string): StepExecuteResult => ({ status: 'DONE', summary });
const waiting = (summary: string): StepExecuteResult => ({ status: 'WAITING', summary, gatePrompt: summary });
const failed = (summary: string): StepExecuteResult => ({ status: 'FAILED', summary });

describe('agent runner — drive sequencing', () => {
  it('auto-advances through AUTO steps to COMPLETED', async () => {
    const r = recipe([
      { name: 'a', label: 'A', kind: 'AUTO', async execute() { return done('a'); } },
      { name: 'b', label: 'B', kind: 'AUTO', async execute() { return done('b'); } },
    ]);
    const res = await startRun(ctx, r, {});
    expect('run' in res).toBe(true);
    if (!('run' in res)) return;
    expect(res.run.status).toBe('COMPLETED');
    expect(res.run.steps.map((s) => s.status)).toEqual(['DONE', 'DONE']);
    expect(res.run.persisted).toBe(false); // ephemeral (no DB)
  });

  it('pauses at a PROPOSE step that returns WAITING (dial did not permit auto)', async () => {
    const r = recipe([
      { name: 'a', label: 'A', kind: 'AUTO', async execute() { return done('a'); } },
      { name: 'b', label: 'B', kind: 'PROPOSE', feature: 'X', async execute() { return waiting('needs review'); } },
      { name: 'c', label: 'C', kind: 'AUTO', async execute() { return done('c'); } },
    ]);
    const res = await startRun(ctx, r, {});
    if (!('run' in res)) throw new Error('expected run');
    expect(res.run.status).toBe('PAUSED');
    expect(res.run.currentStepIndex).toBe(1);
    expect(res.run.steps[0].status).toBe('DONE');
    expect(res.run.steps[1].status).toBe('WAITING');
    expect(res.run.steps[2].status).toBe('PENDING'); // downstream never ran
    expect(res.run.pausedReason).toBe('needs review');
  });

  it('always pauses at a HUMAN_GATE step', async () => {
    const r = recipe([
      { name: 'gate', label: 'Gate', kind: 'HUMAN_GATE', async execute() { return waiting('approve me'); } },
    ]);
    const res = await startRun(ctx, r, {});
    if (!('run' in res)) throw new Error('expected run');
    expect(res.run.status).toBe('PAUSED');
    expect(res.run.steps[0].status).toBe('WAITING');
  });

  it('fails the run when a step fails', async () => {
    const r = recipe([
      { name: 'a', label: 'A', kind: 'AUTO', async execute() { return failed('boom'); } },
      { name: 'b', label: 'B', kind: 'AUTO', async execute() { return done('b'); } },
    ]);
    const res = await startRun(ctx, r, {});
    if (!('run' in res)) throw new Error('expected run');
    expect(res.run.status).toBe('FAILED');
    expect(res.run.error).toBe('boom');
    expect(res.run.steps[1].status).toBe('PENDING');
  });

  it('rejects the start when init returns an error', async () => {
    const r: AgentRecipe = {
      key: 'TEST', label: 't', description: 't', steps: [],
      async init() { return { error: 'bad input' }; },
    };
    const res = await startRun(ctx, r, {});
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toBe('bad input');
  });
});
