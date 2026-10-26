import { describe, it, expect } from 'vitest';
import { STAGE_DEFINITIONS, blockerSummary, deriveStages, nextAction, stageLabel, storedStage, type StageFacts } from './stages';
import { STAGES } from './types';

const base: StageFacts = {
  cutoverDate: null,
  systemsConfirmed: false,
  sourceCount: 0,
  sourcesPulled: 0,
  filesMissing: 0,
  preflightRan: false,
  openBlockers: 0,
  openBlockerCents: 0,
  undecidedWarnings: 0,
  balanceAccounts: 0,
  balanceAccountsMatched: 0,
  unmatchedBalanceCents: 0,
  openingStaged: false,
  openingPosted: false,
  tieDifferences: 0,
  tieDifferenceCents: 0,
  proofSigned: false,
  shadowMode: 'clean_switch',
  certificateIssued: false,
  live: false,
  skipped: [],
};
const f = (o: Partial<StageFacts>): StageFacts => ({ ...base, ...o });

const planned = { cutoverDate: '2026-09-30', systemsConfirmed: true, sourceCount: 2 };
const connected = { ...planned, sourcesPulled: 2 };
const checked = { ...connected, preflightRan: true };
const matched = { ...checked, balanceAccounts: 40, balanceAccountsMatched: 40 };
const loaded = { ...matched, openingStaged: true, openingPosted: true };

describe('stage copy (spec §5.3.1 — binding UI labels)', () => {
  it('has the eight stages in order with plain labels, one-liners and a done-when rule each', () => {
    expect(STAGE_DEFINITIONS.map((d) => d.stage)).toEqual([...STAGES]);
    expect(STAGE_DEFINITIONS.map((d) => d.label)).toEqual(['Gather info', 'Connect systems', 'Check data quality', 'Match accounts', 'Prove balances', 'Practice close', 'Signed off', 'Live']);
    for (const d of STAGE_DEFINITIONS) {
      expect(d.oneLine.length).toBeGreaterThan(5);
      expect(d.whatHappens.length).toBeGreaterThan(20);
      expect(d.whoDoesIt.length).toBeGreaterThan(5);
      expect(d.doneWhen).toMatch(/\.$/);
    }
  });
  it('never shows a storage value', () => {
    expect(stageLabel('tie_out')).toBe('Prove balances');
    expect(stageLabel('shadow_close')).toBe('Practice close');
    expect(stageLabel('paused')).toBe('Paused');
    expect(stageLabel('nonsense')).toBe('Gather info');
  });
});

describe('stage machine — each stage’s "done when" is its rule', () => {
  it('starts in Gather info until the cutover is set and every system is named', () => {
    expect(deriveStages(base).current).toBe('plan');
    expect(deriveStages(f({ cutoverDate: '2026-09-30', sourceCount: 2 })).current).toBe('plan');
    expect(deriveStages(f(planned)).current).toBe('connect');
  });
  it('Connect systems is done when every source has pulled and no required file is missing', () => {
    expect(deriveStages(f({ ...planned, sourcesPulled: 1 })).current).toBe('connect');
    expect(deriveStages(f({ ...connected, filesMissing: 1 })).current).toBe('connect');
    expect(deriveStages(f(connected)).current).toBe('preflight');
  });
  it('Check data quality needs the run, no open blocker and every warning decided', () => {
    expect(deriveStages(f({ ...checked, openBlockers: 1, openBlockerCents: 421250 })).current).toBe('preflight');
    expect(deriveStages(f({ ...checked, undecidedWarnings: 2 })).current).toBe('preflight');
    expect(deriveStages(f(checked)).current).toBe('map');
  });
  it('Match accounts is done when every account with a balance is matched', () => {
    expect(deriveStages(f({ ...checked, balanceAccounts: 40, balanceAccountsMatched: 38 })).current).toBe('map');
    expect(deriveStages(f(matched)).current).toBe('tie_out');
  });
  it('a clean switch skips the practice close (shown as skipped, never done); parallel needs an explicit skip', () => {
    const clean = deriveStages(f({ ...loaded, proofSigned: true }));
    expect(clean.stages.find((x) => x.stage === 'shadow_close')!.status).toBe('skipped');
    expect(clean.current).toBe('certified');
    const parallel = deriveStages(f({ ...loaded, proofSigned: true, shadowMode: 'parallel' }));
    expect(parallel.current).toBe('shadow_close');
    const skipped = deriveStages(f({ ...loaded, proofSigned: true, shadowMode: 'parallel', skipped: ['shadow_close'] }));
    expect(skipped.current).toBe('certified');
  });
  it('stages can be done out of order — the current stage is the first one not done', () => {
    const d = deriveStages(f({ ...matched, sourcesPulled: 1 }));
    expect(d.current).toBe('connect');
    expect(d.stages.find((x) => x.stage === 'map')!.status).toBe('done');
  });
  it('the stored stage never claims "Signed off" without a prepared certificate, and never "Live" without going live', () => {
    expect(storedStage(f({ ...loaded }))).toBe('tie_out');
    expect(storedStage(f({ ...loaded, proofSigned: true }))).toBe('certified');
    expect(storedStage(f({ ...loaded, proofSigned: true, certificateIssued: true }))).toBe('certified');
    expect(storedStage(f({ ...loaded, proofSigned: true, certificateIssued: true, live: true }))).toBe('live');
    // A signed-off client stays signed off even if data changes underneath.
    expect(storedStage(f({ ...base, certificateIssued: true }))).toBe('certified');
  });
});

describe('the one next step (Tower "Next step" + workspace primary button)', () => {
  it('names the exact verb', () => {
    expect(nextAction(base).label).toBe('Set the cutover date');
    expect(nextAction(f({ cutoverDate: '2026-09-30' })).label).toBe('Name the systems');
    expect(nextAction(f({ ...planned, filesMissing: 3 })).label).toBe('Drop 3 files');
    expect(nextAction(f(connected)).label).toBe('Check data quality');
    expect(nextAction(f({ ...checked, openBlockers: 2 })).label).toBe('Fix 2 data issues');
    expect(nextAction(f({ ...checked, balanceAccounts: 40, balanceAccountsMatched: 2 })).label).toBe('Match 38 accounts');
    expect(nextAction(f(matched)).label).toBe('Load opening balances');
    expect(nextAction(f({ ...matched, openingStaged: true })).label).toBe('Post the opening entry');
    expect(nextAction(f({ ...loaded, tieDifferences: 2, tieDifferenceCents: 314000 })).label).toBe('Fix 2 differences');
    expect(nextAction(f(loaded)).label).toBe('Sign balance proof');
    expect(nextAction(f({ ...loaded, proofSigned: true })).label).toBe('Sign off and issue');
    expect(nextAction(f({ ...loaded, proofSigned: true, certificateIssued: true })).label).toBe('Go live');
    expect(nextAction(f({ ...loaded, proofSigned: true, certificateIssued: true, live: true })).kind).toBe('done');
  });
});

describe('blocker summary — dollars by class, a plain phrase for the Tower', () => {
  it('sums the classes and phrases the current stage', () => {
    const b = blockerSummary(f({ ...checked, openBlockers: 2, openBlockerCents: 482450 }));
    expect(b.dataQualityCents).toBe(482450);
    expect(b.totalCents).toBe(482450);
    expect(b.phrase).toBe('$4,824.50 · 2 data blockers');
    const m = blockerSummary(f({ ...checked, balanceAccounts: 40, balanceAccountsMatched: 2, unmatchedBalanceCents: 9241000 }));
    expect(m.phrase).toBe('$92,410.00 · 38 to decide');
    const t = blockerSummary(f({ ...loaded, tieDifferences: 2, tieDifferenceCents: 314000 }));
    expect(t.balanceCents).toBe(314000);
    expect(t.phrase).toBe('$3,140.00 · 2 differences');
    expect(blockerSummary(f({ ...loaded, proofSigned: true, tieDifferenceCents: 5 })).balanceCents).toBe(0);
    expect(blockerSummary(f({ ...planned, filesMissing: 3 })).phrase).toBe('3 files missing');
  });
});
