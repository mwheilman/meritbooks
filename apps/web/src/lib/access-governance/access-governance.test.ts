import { describe, it, expect } from 'vitest';
import { csvCell, neutralizeCell, toCsv } from './csv';
import { describeGrant, describeLogEntry, describeSuggestion, scopeLabel, summarizeSuggestions } from './describe';
import { accessRequestCreateSchema, reviewDecideSchema, templateUpdateDecideSchema } from '@/lib/validations/access-governance';

describe('CSV export is formula-injection safe', () => {
  it('prefixes cells whose first non-blank character is = + - @', () => {
    expect(neutralizeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(neutralizeCell('  +1+1')).toBe(`'  +1+1`);
    expect(neutralizeCell('-2')).toBe(`'-2`);
    expect(neutralizeCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(neutralizeCell('\tcmd')).toBe(`'\tcmd`);
    expect(neutralizeCell('Bookkeeper on Client One')).toBe('Bookkeeper on Client One');
    expect(neutralizeCell('a=b')).toBe('a=b');
  });
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(3)).toBe('"3"');
    expect(toCsv(['A', 'B'], [['=1', 'x,y']])).toBe(`"A","B"\r\n"'=1","x,y"\r\n`);
  });
});

describe('plain-English descriptions (Current / Proposed language only)', () => {
  it('describes grants and suggestions without template or version words', () => {
    expect(describeGrant('ap.bills', ['approve', 'view'])).toBe('see and approve Bills');
    const add = describeSuggestion({
      id: 'ap.bills:add', kind: 'add', capability: 'ap.bills', actions: ['approve'],
      constraints: { amount_limit: { max_per_item_cents: 2_500_000 } },
    });
    expect(add).toMatch(/^Adds: approve Bills up to \$25,000/);
    expect(describeSuggestion({ id: 'x', kind: 'remove', capability: 'ap.bills', actions: ['delete'] })).toBe('Removes: delete Bills.');
    const lim = describeSuggestion({
      id: 'y', kind: 'constraint', capability: 'ap.bills',
      before: { amount_limit: { max_per_item_cents: 100_000 } }, after: {},
    });
    expect(lim).toMatch(/Changes the limit on Bills: up to \$1,000(\.00)? → no limit/);
    const all = summarizeSuggestions([
      { id: 'a', kind: 'add', capability: 'ap.bills', actions: ['approve'] },
      { id: 'b', kind: 'remove', capability: 'ap.bills', actions: ['delete'] },
    ]);
    expect(all).toBe('Adds: approve Bills. Removes: delete Bills');
    for (const s of [add, all]) expect(s).not.toMatch(/template|version|draft/i);
  });
  it('describes log entries from the snapshot taken at the time', () => {
    const snap = { source_name: 'Bookkeeper', scope_type: 'client', location_name: 'Clive Power' };
    expect(describeLogEntry({ event: 'assignment.grant', before: null, after: snap, affectedNames: ['Dana Ruiz'] }))
      .toBe('Dana Ruiz was given Bookkeeper on Clive Power.');
    expect(describeLogEntry({ event: 'assignment.revoke', before: snap, after: { ...snap, status: 'revoked' }, affectedNames: ['Dana Ruiz'] }))
      .toBe('Dana Ruiz lost Bookkeeper on Clive Power.');
    expect(describeLogEntry({
      event: 'role.publish', before: { version: 1 }, after: { version: 2, adds: [{ capability: 'ap.bills', action: 'approve' }], removes: [] },
      affectedNames: [], subjectName: 'Controller',
    })).toBe('Role "Controller" has a new Current — adds: approve Bills.');
    expect(scopeLabel({ scope_type: 'all_clients' })).toBe('all clients');
  });
});

describe('request / review / suggestion validation', () => {
  it('a capability request needs actions and a reason', () => {
    expect(accessRequestCreateSchema.safeParse({ kind: 'capability', capability: 'ap.bills', actions: [], reason: 'need it' }).success).toBe(false);
    expect(accessRequestCreateSchema.safeParse({ kind: 'capability', capability: 'ap.bills', actions: ['view'], reason: 'x' }).success).toBe(false);
    expect(accessRequestCreateSchema.safeParse({ kind: 'capability', capability: 'ap.bills', actions: ['view'], reason: 'month end' }).success).toBe(true);
    expect(accessRequestCreateSchema.safeParse({ kind: 'client', reason: 'month end' }).success).toBe(false);
  });
  it('reduce needs a note; publishing suggestions needs a reason', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(reviewDecideSchema.safeParse({ itemId: id, decision: 'reduce' }).success).toBe(false);
    expect(reviewDecideSchema.safeParse({ itemId: id, decision: 'revoke' }).success).toBe(true);
    expect(templateUpdateDecideSchema.safeParse({ updateId: id, add: ['a'], publish: true }).success).toBe(false);
    expect(templateUpdateDecideSchema.safeParse({ updateId: id, skip: ['a'] }).success).toBe(true);
    expect(templateUpdateDecideSchema.safeParse({ updateId: id }).success).toBe(false);
  });
});
