import { describe, expect, it } from 'vitest';
import { STAGED_ENTITIES } from './types';
import { READ_ONLY_PROMISE, SOURCE_SYSTEMS, getSourceSystem, recipeFileFor, searchSourceSystems, sourceGroups } from './catalog';

describe('source catalog', () => {
  it('has unique ids', () => {
    const ids = SOURCE_SYSTEMS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every system a recipe with at least 2 steps and 1 file of a real entity', () => {
    for (const s of SOURCE_SYSTEMS) {
      expect(s.recipe.steps.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.recipe.files.length, s.id).toBeGreaterThanOrEqual(1);
      expect(s.recipe.afterGoLive.length, s.id).toBeGreaterThan(0);
      for (const f of s.recipe.files) expect(STAGED_ENTITIES as readonly string[], `${s.id}/${f.key}`).toContain(f.entity);
      const keys = s.recipe.files.map((f) => f.key);
      expect(new Set(keys).size, s.id).toBe(keys.length);
      if (s.recipe.status === 'draft') expect(s.recipe.summary, s.id).toMatch(/draft, confirm with/);
    }
  });

  it('is honest about tiers: only QuickBooks Online and Plaid connect natively today', () => {
    const native = SOURCE_SYSTEMS.filter((s) => s.tier === 'native_api').map((s) => s.id).sort();
    expect(native).toEqual(['plaid', 'quickbooks']);
    expect(SOURCE_SYSTEMS.filter((s) => s.apiStatus === 'live').map((s) => s.id).sort()).toEqual(['plaid', 'quickbooks']);
    expect(getSourceSystem('other-file')?.tier).toBe('generic_file');
    expect(SOURCE_SYSTEMS.filter((s) => s.tier === 'generic_file').map((s) => s.id)).toEqual(['other-file']);
  });

  it('includes the owner-named six and the spec minimum set', () => {
    for (const id of ['servicetitan', 'buildertrend', 'innergy', 'simpro', 'rfms', 'c-systems']) {
      const s = getSourceSystem(id);
      expect(s, id).not.toBeNull();
      expect(s?.group).toBe('field');
      expect(s?.ongoingFeed).toBe(true);
    }
    for (const id of [
      'quickbooks', 'quickbooks-desktop', 'xero', 'sage-intacct', 'sage-50', 'sage-100-300', 'netsuite', 'freshbooks-wave', 'spreadsheets',
      'fieldedge', 'procore', 'jobber', 'housecall-pro', 'buildops', 'servicetrade', 'jobtread', 'knowify', 'contractor-foreman', 'foundation',
      'sage-100-contractor', 'jobnimbus', 'acculynx', 'compufloor', 'qfloors', 'rollmaster',
      'plaid', 'ramp', 'bank-statements', 'gusto', 'adp', 'paychex', 'quickbooks-payroll', 'paylocity',
      'concur', 'bill-com', 'hubspot', 'salesforce', 'documents', 'other-file',
    ]) {
      expect(getSourceSystem(id), id).not.toBeNull();
    }
  });

  it('asks every ledger for the cutover TB, chart, both agings and both party lists', () => {
    for (const s of SOURCE_SYSTEMS.filter((x) => x.group === 'ledger')) {
      expect(s.ongoingFeed, s.id).toBe(false);
      expect(s.recipe.afterGoLive, s.id).toMatch(/one-time source; MeritBooks becomes the book of record/);
      for (const e of ['tb_line', 'account', 'open_invoice', 'open_bill', 'customer', 'vendor'] as const) {
        expect(recipeFileFor(s, e)?.required, `${s.id}/${e}`).toBe(true);
      }
    }
  });

  it('carries the Innergy recipe from the design board and marks it draft', () => {
    const innergy = getSourceSystem('innergy');
    expect(innergy?.recipe.status).toBe('draft');
    expect(innergy?.recipe.steps).toHaveLength(4);
    expect(innergy?.recipe.steps[0].title).toBe('Open Innergy and go to the Jobs list');
    expect(innergy?.apiStatus).toBe('no_public_api');
    expect(innergy?.bridgeViaQuickBooks).toBe(true);
  });

  it('searches names, ids and aliases case- and punctuation-insensitively', () => {
    expect(searchSourceSystems('SIMPRO').map((s) => s.id)).toEqual(['simpro']);
    expect(searchSourceSystems('qbo').map((s) => s.id)).toContain('quickbooks');
    expect(searchSourceSystems('c-systems').map((s) => s.id)).toEqual(['c-systems']);
    expect(searchSourceSystems('peachtree').map((s) => s.id)).toEqual(['sage-50']);
    expect(searchSourceSystems('intacct').map((s) => s.id)).toEqual(['sage-intacct']);
    expect(searchSourceSystems('').length).toBe(SOURCE_SYSTEMS.length);
    expect(searchSourceSystems('zzzz-nothing')).toEqual([]);
  });

  it('groups every system exactly once, in display order', () => {
    const groups = sourceGroups();
    expect(groups.map((g) => g.group)).toEqual(['ledger', 'field', 'bank', 'payroll', 'spend', 'crm', 'docs']);
    expect(groups.reduce((n, g) => n + g.systems.length, 0)).toBe(SOURCE_SYSTEMS.length);
  });

  it('states the read-only promise and finds recipe slots', () => {
    expect(READ_ONLY_PROMISE('simPRO')).toBe('MeritBooks will only read. Nothing in simPRO changes.');
    const qbo = getSourceSystem('quickbooks');
    expect(qbo && recipeFileFor(qbo, 'open_invoice')?.key).toBe('ar_aging');
    expect(qbo && recipeFileFor(qbo, 'job')).toBeNull();
    expect(getSourceSystem('nope')).toBeNull();
  });
});
