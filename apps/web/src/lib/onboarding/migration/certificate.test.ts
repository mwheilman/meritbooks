import { describe, it, expect } from 'vitest';
import { canonicalJson, computeTies, nextCertificateNumber, proofGate, signOffGate, type TieInputs } from './certificate';
import { estimateTimeSaved, firstWeekChecklist, priorSystemFor, workflowFor } from './buyin';
import { matchNamed, matchParties } from './masters';
import { tinFingerprint } from '@/lib/vendors/tin-fingerprint';

const tied: TieInputs = {
  asOf: '2026-09-30',
  tb: {
    posted: true,
    lines: [
      { label: '1000 Operating cash', sourceCents: 5000000, meritCents: 5000000 },
      { label: '1100 Accounts receivable', sourceCents: 21488040, meritCents: 21488040 },
      { label: '2000 Accounts payable', sourceCents: -31820655, meritCents: -31820655 },
      { label: '3020 Retained earnings', sourceCents: 5332615, meritCents: 5332615 },
    ],
    sourceDebitCents: 31820655,
    sourceCreditCents: 31820655,
    identityDiffCents: 0,
    plNetCents: 0,
    plAcknowledged: false,
  },
  ar: { sourceAgingCents: 21488040, sourceControlCents: 21488040, meritSubledgerCents: 21488040, meritControlCents: 21488040, carriedCents: 0, evidenced: true },
  ap: { sourceAgingCents: 31820655, sourceControlCents: 31820655, meritSubledgerCents: 31820655, meritControlCents: 31820655, carriedCents: 0, evidenced: true },
  bank: [{ label: 'Farmers State ••4471', evidenceCents: 5000000, sourceGlCents: 5000000, meritGlCents: 5000000 }],
  equity: { sourceCents: -5332615, meritCents: -5332615, rollForward: null },
};

describe('the five ties — old books minus MeritBooks is zero', () => {
  it('all tie on a clean conversion; bank is evidenced by the statement, equity internal only', () => {
    const ties = computeTies(tied);
    expect(ties.map((t) => [t.key, t.status])).toEqual([['tb', 'tied'], ['ar', 'tied'], ['ap', 'tied'], ['bank', 'tied'], ['equity', 'tied']]);
    expect(ties.find((t) => t.key === 'bank')!.evidence).toBe('evidenced');
    expect(ties.find((t) => t.key === 'equity')!.evidence).toBe('internal_only');
    expect(ties.find((t) => t.key === 'ar')!.evidence).toBe('evidenced');
  });

  it('nothing posted → the trial balance is waiting (there is no MeritBooks side yet)', () => {
    const t = computeTies({ ...tied, tb: { ...tied.tb, posted: false } })[0];
    expect(t.status).toBe('waiting');
    expect(t.lines).toEqual([]);
  });

  it('an account that differs is listed with its difference in dollars', () => {
    const t = computeTies({ ...tied, tb: { ...tied.tb, lines: [...tied.tb.lines, { label: '4020 Revenue · Service', sourceCents: -18642000, meritCents: -18485000 }] } })[0];
    expect(t.status).toBe('difference');
    expect(t.summary).toBe('1 account differ by $1,570.00 between the old books and MeritBooks.');
    expect(t.lines).toEqual([{ label: '4020 Revenue · Service', sourceCents: -18642000, meritCents: -18485000, differenceCents: -157000 }]);
  });

  it('receivables: an unapplied gap is a difference — unless carried as one reconciling item, matched to the cent', () => {
    const gap = { ...tied.ar, sourceAgingCents: 18640210, meritSubledgerCents: 18640210, sourceControlCents: 19061460, meritControlCents: 19061460 };
    expect(computeTies({ ...tied, ar: gap })[1].status).toBe('difference');
    const carried = computeTies({ ...tied, ar: { ...gap, carriedCents: 421250 } })[1];
    expect(carried.status).toBe('tied');
    expect(carried.summary).toMatch(/\$4,212\.50 carried as one reconciling item/);
    expect(carried.lines.find((l) => l.label.includes('carried'))!.differenceCents).toBe(0);
    // Carrying the wrong amount doesn't hide anything.
    expect(computeTies({ ...tied, ar: { ...gap, carriedCents: 400000 } })[1].status).toBe('difference');
  });

  it('a control balance with no open items loaded is "waiting", with what to do', () => {
    const t = computeTies({ ...tied, ar: { ...tied.ar, meritSubledgerCents: 0, sourceAgingCents: null } })[1];
    expect(t.status).toBe('waiting');
    expect(t.summary).toMatch(/load the aging/);
  });

  it('nothing on either side is not applicable, never a false green', () => {
    const t = computeTies({ ...tied, ap: { sourceAgingCents: null, sourceControlCents: 0, meritSubledgerCents: 0, meritControlCents: 0, carriedCents: 0, evidenced: false } })[2];
    expect(t.status).toBe('not_applicable');
  });

  it('bank: a statement that disagrees with MeritBooks is a difference; no statement is internal only', () => {
    const off = computeTies({ ...tied, bank: [{ label: 'Op', evidenceCents: 4977685, sourceGlCents: 5000000, meritGlCents: 5000000 }] })[3];
    expect(off.status).toBe('difference');
    const noStatement = computeTies({ ...tied, bank: [{ label: 'Op', evidenceCents: null, sourceGlCents: 5000000, meritGlCents: 5000000 }] })[3];
    expect(noStatement).toMatchObject({ status: 'tied', evidence: 'internal_only' });
  });

  it('a mid-year cutover needs the open P&L acknowledged', () => {
    const t = computeTies({ ...tied, tb: { ...tied.tb, plNetCents: 120000, identityDiffCents: 120000 } })[0];
    expect(t.status).toBe('difference');
    expect(computeTies({ ...tied, tb: { ...tied.tb, plNetCents: 120000, identityDiffCents: 120000, plAcknowledged: true } })[0].status).toBe('tied');
  });
});

describe('the gates — preparer signs, a different reviewer signs off', () => {
  const ok = { ties: computeTies(tied), openBlockers: 0, openBlockerCents: 0, undecidedWarnings: 0, unmatchedBalanceAccounts: 0, unmatchedBalanceCents: 0, typeGuardWithoutReason: 0, preparerUserId: 'prep', reviewerUserId: 'rev', actorUserId: 'prep' };
  it('ready when everything ties and is decided', () => {
    expect(proofGate(ok)).toEqual({ ready: true, blockers: [] });
  });
  it('lists every reason in dollars', () => {
    const g = proofGate({ ...ok, openBlockers: 2, openBlockerCents: 482450, undecidedWarnings: 1, unmatchedBalanceAccounts: 3, unmatchedBalanceCents: 9241000, ties: computeTies({ ...tied, tb: { ...tied.tb, posted: false } }) });
    expect(g.ready).toBe(false);
    expect(g.blockers).toContain('2 data-quality blockers still open ($4,824.50). Fix in the source or carry as a reconciling item.');
    expect(g.blockers).toContain('3 accounts with $92,410.00 of balance aren’t matched.');
    expect(g.blockers.some((b) => b.startsWith('Trial balance:'))).toBe(true);
  });
  it('needs a reviewer, and the reviewer cannot sign the proof', () => {
    expect(proofGate({ ...ok, reviewerUserId: null }).ready).toBe(false);
    expect(proofGate({ ...ok, actorUserId: 'rev' }).blockers).toContain('You are this client’s reviewer, so you can’t also sign the balance proof.');
  });
  it('sign-off is refused to the preparer, to anyone but the named reviewer, and when the books changed', () => {
    const base = { status: 'prepared' as const, preparedBy: 'prep', actorUserId: 'rev', reviewerUserId: 'rev', tiesStillTie: true };
    expect(signOffGate(base).ready).toBe(true);
    expect(signOffGate({ ...base, actorUserId: 'prep', reviewerUserId: null }).ready).toBe(false);
    expect(signOffGate({ ...base, actorUserId: 'someone' }).ready).toBe(false);
    expect(signOffGate({ ...base, tiesStillTie: false }).blockers[0]).toMatch(/changed since/);
    expect(signOffGate({ ...base, status: 'issued' }).ready).toBe(false);
  });
});

describe('numbering and hashing', () => {
  it('numbers CC-#### after the highest, ignoring junk', () => {
    expect(nextCertificateNumber([])).toBe('CC-0001');
    expect(nextCertificateNumber(['CC-0007', 'CC-0002', 'X'])).toBe('CC-0008');
    expect(nextCertificateNumber(['CC-9999'])).toBe('CC-10000');
  });
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe(canonicalJson({ a: [{ c: null, d: 2 }], b: 1 }));
  });
});

const ORG_FP = '00000000-0000-0000-0000-0000000000f1';
process.env.TIN_FINGERPRINT_KEY = process.env.TIN_FINGERPRINT_KEY ?? 'test-tin-fingerprint-key-0123456789abcdef';

describe('master data — "Already in Merit", never created twice', () => {
  const existing = [
    { id: 'v1', name: 'Johnstone Supply', displayName: null, email: 'ap@johnstone.com', phone: '515-555-0100', taxIdHash: null },
    // H2: parties carry the org-scoped fingerprint, never the id (same id → same fingerprint).
    { id: 'v2', name: 'Ferguson Enterprises', displayName: 'Ferguson', email: null, phone: null, taxIdHash: tinFingerprint(ORG_FP, '12-3456789') },
  ];
  it('auto-links on name + email or on the tax id; proposes near names; flags in-file duplicates', () => {
    const out = matchParties(
      [
        { stagedId: 's1', name: 'Johnstone Supply', email: 'AP@johnstone.com', phone: null, taxIdHash: null, address: null },
        { stagedId: 's2', name: 'Ferguson Ent.', email: null, phone: null, taxIdHash: tinFingerprint(ORG_FP, '123456789'), address: null },
        { stagedId: 's3', name: 'Johnstone Supply Co.', email: null, phone: null, taxIdHash: null, address: null },
        { stagedId: 's4', name: 'Allied Ductwork', email: null, phone: null, taxIdHash: null, address: null },
        { stagedId: 's5', name: 'Allied Ductwork LLC', email: null, phone: null, taxIdHash: null, address: null },
      ],
      existing,
    );
    const by = new Map(out.map((m) => [m.stagedId, m]));
    expect(by.get('s1')).toMatchObject({ status: 'matched', matchedId: 'v1' });
    expect(by.get('s2')).toMatchObject({ status: 'matched', matchedId: 'v2' });
    expect(by.get('s3')!.status).not.toBe('new');
    expect(by.get('s4')!.status).toBe('new');
    expect(by.get('s5')).toMatchObject({ status: 'merge_proposed', duplicateOfStagedId: 's4' });
  });
  it('items and classes match by code, then name', () => {
    const out = matchNamed([{ stagedId: 'a', name: 'Install', code: null }, { stagedId: 'b', name: 'Widget', code: 'W-1' }, { stagedId: 'c', name: 'New thing', code: null }], [{ id: 'd1', name: 'install', code: 'INS' }, { id: 'i1', name: 'Something', code: 'w-1' }]);
    expect(out.map((m) => [m.status, m.matchedId])).toEqual([['matched', 'd1'], ['matched', 'i1'], ['new', null]]);
  });
});

describe('buy-in — from the client’s own numbers', () => {
  it('estimates hours from real volumes and names the basis', () => {
    const t = estimateTimeSaved([
      { key: 'bank_txns', perMonth: 412, basis: 'bank feed, last 90 days' },
      { key: 'bills', perMonth: 60, basis: 'bills' },
      { key: 'bank_accounts', perMonth: 2, basis: 'accounts' },
    ]);
    expect(t.lines.map((l) => [l.key, l.beforeHours, l.afterHours])).toEqual([['bank_txns', 6.9, 1.4], ['bills', 4, 1], ['bank_accounts', 1.5, 0.5]]);
    expect(t.savedHours).toBe(9.5);
    expect(estimateTimeSaved([]).lines).toEqual([]);
  });
  it('workflow copy uses the tenant’s reviewer and the prior system', () => {
    const w = workflowFor('bookkeeper', priorSystemFor('quickbooks'), { reviewerName: 'Jordan Smith', billApprovalThresholdCents: 250000 });
    expect(w.newForYou[0].detail).toMatch(/Jordan Smith/);
    expect(w.moved[0].before).toBe('Banking → For review');
    expect(w.newForYou.some((x) => /\$2,500/.test(x.detail))).toBe(true);
  });
  it('the first-week checklist is computed from real rows', () => {
    const c = firstWeekChecklist({ approvedBankTxns: 12, reconciliations: 0, billsEntered: 1, invoicesSent: 0, periodsClosed: 0 }, 'AIM');
    expect(c.filter((x) => x.done).map((x) => x.key)).toEqual(['first_bank_txns', 'first_bill']);
  });
});
