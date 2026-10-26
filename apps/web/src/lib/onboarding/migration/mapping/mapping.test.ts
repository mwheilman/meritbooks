import { describe, it, expect } from 'vitest';
import { bandFor, bandTotals, runCascade, typeGuard, AI_CAP } from './cascade';
import { crosswalkFor, isOpeningBalanceEquity } from './crosswalk';
import { familyFor, nameKey, numberKey, recomputeRule, ruleKeysFor } from './memory';
import { mergeSourceAccounts } from '../source-accounts';
import type { MappingRuleRef, MappingSourceAccount, MappingTarget } from '../types';

const T: MappingTarget[] = [
  { id: 't1000', number: '1000', name: 'Operating cash', type: 'ASSET' },
  { id: 't1100', number: '1100', name: 'Accounts receivable', type: 'ASSET' },
  { id: 't1090', number: '1090', name: 'Payment clearing', type: 'ASSET' },
  { id: 't2000', number: '2000', name: 'Accounts payable', type: 'LIABILITY' },
  { id: 't2300', number: '2300', name: 'Sales tax payable', type: 'LIABILITY' },
  { id: 't3020', number: '3020', name: 'Retained earnings', type: 'EQUITY' },
  { id: 't5100', number: '5100', name: 'Materials', type: 'COGS' },
  { id: 't6120', number: '6120', name: 'Vehicle fuel', type: 'OPEX' },
  { id: 't6810', number: '6810', name: 'Taxes & licenses', type: 'OPEX' },
  { id: 't4010', number: '4010', name: 'Revenue - Install', type: 'REVENUE' },
];
const roles = new Map([['AR_CONTROL', 't1100'], ['AP_CONTROL', 't2000'], ['UNDEPOSITED_FUNDS', 't1090'], ['SALES_TAX_PAYABLE', 't2300'], ['RETAINED_EARNINGS', 't3020']]);

const src = (o: Partial<MappingSourceAccount> & { key: string; name: string }): MappingSourceAccount => ({
  number: o.key, type: null, sourceType: null, detailType: null, balanceCents: 0, ...o,
});

describe('type guard and bands (same bands as the bank feed)', () => {
  it('asset→asset ok, COGS↔OPEX warns, liability→expense blocks, OTHER/unknown allowed', () => {
    expect(typeGuard('ASSET', 'ASSET')).toBe('ok');
    expect(typeGuard('COGS', 'OPEX')).toBe('warn');
    expect(typeGuard('LIABILITY', 'OPEX')).toBe('block');
    expect(typeGuard('OTHER', 'REVENUE')).toBe('ok');
    expect(typeGuard(null, 'REVENUE')).toBe('ok');
  });
  it('Ready ≥ 0.90 only without a warning; a block is always Decide', () => {
    expect(bandFor(0.95, 'ok')).toBe('ready');
    expect(bandFor(0.95, 'warn')).toBe('check');
    expect(bandFor(0.75, 'ok')).toBe('check');
    expect(bandFor(0.69, 'ok')).toBe('decide');
    expect(bandFor(0.99, 'block')).toBe('decide');
  });
});

describe('the cascade — first hit wins, every hit names its rule', () => {
  const sources = [
    src({ key: '1200', name: 'Accounts Receivable (A/R)', detailType: 'AccountsReceivable', type: 'ASSET', balanceCents: 19061460 }),
    src({ key: '1499', name: 'Undeposited Funds', detailType: 'UndepositedFunds', type: 'ASSET', balanceCents: 1894000 }),
    src({ key: '6125', name: 'Truck fuel – installers', type: 'OPEX', balanceCents: 988000 }),
    src({ key: '2310', name: 'Sales tax payable – Polk Co', type: 'LIABILITY', balanceCents: -1290644 }),
    src({ key: '3900', name: 'Opening Balance Equity', detailType: 'OpeningBalanceEquity', type: 'EQUITY', balanceCents: -725000 }),
    src({ key: '5100', name: 'Job materials', type: 'COGS', balanceCents: 10 }),
    src({ key: '9999', name: 'Mystery account', type: 'OPEX', balanceCents: 1 }),
  ];

  it('without memory: crosswalk, numbers, names, then nothing — ordered largest balance first', () => {
    const out = runCascade({ sources, targets: T, rules: [], roleTargets: roles, retainedEarningsTargetId: 't3020', chartStrategy: 'tenant_standard' });
    expect(out.map((p) => p.key)).toEqual(['1200', '1499', '2310', '6125', '3900', '5100', '9999']);
    const by = new Map(out.map((p) => [p.key, p]));
    expect(by.get('1200')).toMatchObject({ targetAccountId: 't1100', source: 'crosswalk', confidence: 0.95, band: 'ready' });
    expect(by.get('1499')).toMatchObject({ targetAccountId: 't1090', source: 'crosswalk', band: 'ready' });
    expect(by.get('3900')).toMatchObject({ targetAccountId: 't3020', confidence: 0.7, band: 'check' });
    expect(by.get('5100')).toMatchObject({ targetAccountId: 't5100', source: 'number', confidence: 0.75, band: 'check' });
    expect(by.get('9999')).toMatchObject({ targetAccountId: null, source: 'unmapped', band: 'decide' });
    // "Sales tax payable – Polk Co" contains the target name → name heuristic 0.70 with an ok guard.
    expect(by.get('2310')).toMatchObject({ targetAccountId: 't2300', source: 'name', band: 'check' });
  });

  it('keep-source-chart trusts the number (0.99); tenant standard does not (0.75)', () => {
    const keep = runCascade({ sources: [src({ key: '5100', name: 'Job materials', type: 'COGS' })], targets: T, rules: [], roleTargets: new Map(), chartStrategy: 'keep_source_chart' });
    expect(keep[0]).toMatchObject({ source: 'number', confidence: 0.99, band: 'ready' });
  });

  it('the firm memory wins first: 0.97 with ≥2 clients, 0.93 with one, 0.66 when clients disagree', () => {
    const rules: MappingRuleRef[] = [
      { id: 'r1', matchKind: 'exact_number', matchValue: '6125', targetAccountId: 't6120', evidenceCount: 2, conflict: false },
      { id: 'r2', matchKind: 'normalized_name', matchValue: nameKey('Mystery account')!, targetAccountId: 't6810', evidenceCount: 1, conflict: false },
    ];
    const out = new Map(runCascade({ sources, targets: T, rules, roleTargets: roles, chartStrategy: 'tenant_standard' }).map((p) => [p.key, p]));
    expect(out.get('6125')).toMatchObject({ source: 'rule', ruleId: 'r1', confidence: 0.97, band: 'ready', targetAccountId: 't6120' });
    expect(out.get('9999')).toMatchObject({ source: 'rule', ruleId: 'r2', confidence: 0.93, band: 'ready' });
    const conflicted = runCascade({ sources: [sources[2]], targets: T, rules: [{ ...rules[0], conflict: true }], roleTargets: roles, chartStrategy: 'tenant_standard' });
    expect(conflicted[0]).toMatchObject({ confidence: 0.66, band: 'decide', conflict: true });
  });

  it('a liability proposed onto an expense lands in Decide with a type warning, whatever the confidence', () => {
    const rules: MappingRuleRef[] = [{ id: 'r3', matchKind: 'exact_number', matchValue: '2310', targetAccountId: 't6810', evidenceCount: 3, conflict: false }];
    const out = runCascade({ sources: [sources[3]], targets: T, rules, roleTargets: roles, chartStrategy: 'tenant_standard' });
    expect(out[0]).toMatchObject({ typeGuard: 'block', band: 'decide' });
    expect(out[0].reason).toMatch(/needs a typed reason/);
  });

  it('AI alone never lands in Ready (capped at 0.89)', () => {
    const ai = new Map([['9999', { targetAccountId: 't6810', confidence: 0.99, reasoning: 'licence fees' }]]);
    const out = runCascade({ sources: [sources[6]], targets: T, rules: [], roleTargets: new Map(), chartStrategy: 'tenant_standard', ai });
    expect(out[0]).toMatchObject({ source: 'ai', confidence: AI_CAP, band: 'check' });
  });

  it('second client in a wave: memory from the first lands ≥ 80% of balance-bearing accounts in Ready without AI (AC-6)', () => {
    const clientA = [
      src({ key: '6125', name: 'Truck fuel – installers', type: 'OPEX', balanceCents: 100 }),
      src({ key: '6990', name: 'Ask My Accountant', type: 'OPEX', balanceCents: 100 }),
      src({ key: '4000', name: 'Sales', type: 'REVENUE', balanceCents: -100 }),
      src({ key: '5000', name: 'Cost of goods sold', type: 'COGS', balanceCents: 100 }),
      src({ key: '6000', name: 'Rent', type: 'OPEX', balanceCents: 100 }),
    ];
    const answers: Record<string, string> = { '6125': 't6120', '6990': 't6810', '4000': 't4010', '5000': 't5100', '6000': 't6810' };
    const rules: MappingRuleRef[] = clientA.flatMap((a) => ruleKeysFor({ number: a.number, name: a.name }).map((k, i) => ({ id: `${a.key}-${i}`, matchKind: k.matchKind, matchValue: k.matchValue, targetAccountId: answers[a.key], evidenceCount: 1, conflict: false })));
    const clientB = clientA.map((a) => ({ ...a, balanceCents: a.balanceCents * 7 }));
    const out = runCascade({ sources: clientB, targets: T, rules, roleTargets: roles, chartStrategy: 'tenant_standard' });
    const ready = out.filter((p) => p.band === 'ready').length;
    expect(ready / out.length).toBeGreaterThanOrEqual(0.8);
  });

  it('band totals sum to their rows', () => {
    const t = bandTotals([{ band: 'ready', balanceCents: 100 }, { band: 'ready', balanceCents: -50 }, { band: 'decide', balanceCents: 7 }]);
    expect(t).toEqual({ ready: { count: 2, cents: 150 }, check: { count: 0, cents: 0 }, decide: { count: 1, cents: 7 } });
  });
});

describe('crosswalk library', () => {
  it('maps QuickBooks detail types and account types to roles', () => {
    expect(crosswalkFor({ detailType: 'AccountsReceivable', sourceType: null })?.role).toBe('AR_CONTROL');
    expect(crosswalkFor({ detailType: null, sourceType: 'Credit Card' })?.role).toBe('CREDIT_CARD_PAYABLE');
    expect(crosswalkFor({ detailType: 'GlobalTaxPayable', sourceType: null })?.role).toBe('SALES_TAX_PAYABLE');
    expect(crosswalkFor({ detailType: 'SomethingElse', sourceType: 'Expense' })).toBeNull();
    expect(isOpeningBalanceEquity({ detailType: null, name: 'Opening Balance Equity' })).toBe(true);
  });
});

describe('firm mapping memory', () => {
  it('keys by number and by a normalized name', () => {
    expect(numberKey(' 6125 ')).toBe('6125');
    expect(numberKey('Truck fuel')).toBeNull();
    expect(nameKey('6125 · Truck Fuel – Installers')).toBe('truck fuel installers');
    expect(nameKey('Repairs & Maintenance Expense')).toBe('repairs and maintenance');
    expect(ruleKeysFor({ number: '6125', name: 'Truck fuel' })).toEqual([
      { matchKind: 'exact_number', matchValue: '6125' },
      { matchKind: 'normalized_name', matchValue: 'truck fuel' },
    ]);
  });
  it('recomputes the answer by majority (ties → earliest), flags a conflict, honors a settled answer', () => {
    const ev = [
      { locationId: 'A', targetAccountId: 't6120', decidedAt: '2026-10-01' },
      { locationId: 'B', targetAccountId: 't6810', decidedAt: '2026-10-16' },
    ];
    expect(recomputeRule(ev, null)).toEqual({ targetAccountId: 't6120', evidenceCount: 1, conflict: true });
    expect(recomputeRule([...ev, { locationId: 'C', targetAccountId: 't6810', decidedAt: '2026-10-17' }], null)).toEqual({ targetAccountId: 't6810', evidenceCount: 2, conflict: true });
    expect(recomputeRule([ev[0]], null)).toEqual({ targetAccountId: 't6120', evidenceCount: 1, conflict: false });
    expect(recomputeRule(ev, 't6810')?.targetAccountId).toBe('t6810');
    expect(recomputeRule([], null)).toBeNull();
  });
  it('families', () => {
    expect(familyFor('quickbooks-desktop')).toBe('quickbooks');
    expect(familyFor('sage-intacct')).toBe('sage_intacct');
    expect(familyFor('servicetitan')).toBe('generic');
  });
});

describe('source chart merge (TB is the authority for balances)', () => {
  it('merges the account list onto TB lines by number, keeps chart-only accounts with zero balance', () => {
    const merged = mergeSourceAccounts(
      [
        { number: '1200', name: 'Accounts Receivable', type: 'ASSET', sourceType: 'Accounts Receivable', detailType: 'AccountsReceivable', active: true, balanceCents: 999 },
        { number: '6999', name: 'Old account', type: 'OPEX', sourceType: 'Expense', detailType: null, active: false, balanceCents: 0 },
      ],
      [
        { number: '1200', name: 'Accounts Receivable (A/R)', debitCents: 19061460, creditCents: 0 },
        { number: '2000', name: 'Accounts Payable', debitCents: 0, creditCents: 500 },
      ],
    );
    const by = new Map(merged.map((m) => [m.key, m]));
    expect(by.get('1200')).toMatchObject({ balanceCents: 19061460, detailType: 'AccountsReceivable', fromTb: true });
    expect(by.get('2000')).toMatchObject({ balanceCents: -500, fromTb: true });
    expect(by.get('6999')).toMatchObject({ balanceCents: 0, active: false, fromTb: false });
  });
});
