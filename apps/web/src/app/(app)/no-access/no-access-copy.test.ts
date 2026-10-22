import { describe, it, expect } from 'vitest';
import { noAccessCopy } from './no-access-copy';

describe('/no-access copy names what was blocked', () => {
  it('capability label + action + client name', () => {
    const c = noAccessCopy({ capability: 'ap.bills', action: 'approve', clientId: 'x', clientName: 'Clive Power Equipment' });
    expect(c.title).toBe('You can’t approve Bills for Clive Power Equipment');
    expect(c.message).toMatch(/permission to approve Bills for Clive Power Equipment/);
    expect(c.detail).toMatch(/^Approve · Bills — /);
  });
  it('a client id without a resolvable name still says it is client-specific', () => {
    expect(noAccessCopy({ capability: 'ap.bills', action: 'view', clientId: 'x' }).title).toBe('You can’t see Bills for this client');
  });
  it('defaults to view, and never shows a raw key', () => {
    const c = noAccessCopy({ capability: 'bank.reconciliations' });
    expect(c.title).not.toMatch(/bank\.reconciliations/);
    expect(c.title).toMatch(/^You can’t see /);
  });
  it('unknown / missing capability → generic copy', () => {
    expect(noAccessCopy({ capability: 'nope.nope', action: 'approve' })).toMatchObject({ title: "You don't have access to this", detail: null });
    expect(noAccessCopy({}).detail).toBeNull();
  });
});
