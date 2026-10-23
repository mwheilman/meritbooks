/**
 * Pure requirement evaluation (FPB-vendor-compliance-chase §19.3 criteria 1–4).
 */
import { describe, it, expect } from 'vitest';
import {
  checkProposedCoi,
  dollars,
  evaluateRequirements,
  holderMatches,
  holdReasons,
  mergeRequirementSets,
  selectRequirementSet,
  summarise,
  type CoverageFact,
  type RequirementSet,
  type VendorFacts,
} from './requirements';
import { buildFacts } from './store';
import { needsFromRules } from '@/lib/requests/vendor-compliance';
import { validateCallBack, phoneDigits, clampCalledAt } from './bank-change';
import { normaliseTin, tinLooksValid, encryptTin, decryptTin } from '@/lib/vendors/tin-crypto';
import { validateCoverages } from './review';
import { portalItem } from './portal';

const TODAY = '2026-10-23';

function set(over: Partial<RequirementSet> = {}): RequirementSet {
  return {
    id: 's1',
    name: 'Subcontractors',
    locationId: null,
    vendorType: 'subcontractor',
    tax1099: 'any',
    workType: null,
    w9Required: true,
    coiRequired: true,
    minGlEachOccurrenceCents: 100_000_000,
    minGlAggregateCents: 200_000_000,
    minAutoCents: null,
    wcRequired: false,
    minWcEachAccidentCents: null,
    minUmbrellaCents: null,
    requireAdditionalInsured: false,
    requireWaiverOfSubrogation: false,
    certificateHolderNames: [],
    expiryLeadDays: 30,
    blockPayment: true,
    graceDays: 0,
    isActive: true,
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function gl(over: Partial<CoverageFact> = {}): CoverageFact {
  return {
    coverageType: 'GENERAL_LIABILITY',
    eachOccurrenceCents: 100_000_000,
    aggregateCents: 200_000_000,
    expirationDate: '2027-06-30',
    additionalInsured: true,
    waiverOfSubrogation: true,
    certificateHolder: 'Artistry Homes, LLC',
    ...over,
  };
}

function facts(lines: CoverageFact[], over: Partial<VendorFacts> = {}): VendorFacts {
  return { w9: { status: 'valid' }, coverages: lines, wcExemptionValid: false, pendingW9: false, pendingCoi: false, ...over };
}

const byRule = (rs: ReturnType<typeof evaluateRequirements>, id: string) => rs.find((r) => r.rule === id);

describe('limits (criterion 1)', () => {
  it('GL 500,000 against a 1,000,000 minimum is a named, blocking failure', () => {
    const rs = evaluateRequirements(set(), facts([gl({ eachOccurrenceCents: 50_000_000 })]), TODAY);
    const r = byRule(rs, 'COI_GL_OCCURRENCE')!;
    expect(r.outcome).toBe('short');
    expect(r.reason).toBe('General liability each occurrence $500,000.00 on file; $1,000,000.00 required.');
    const sum = summarise(set(), rs);
    expect(sum.holds).toBe(true);
    expect(holdReasons(rs)).toContain('$500,000.00 on file; $1,000,000.00 required');
  });

  it('aggregate, auto, WC each accident and umbrella minimums; an absent line is missing', () => {
    const s = set({ minAutoCents: 100_000_000, wcRequired: true, minWcEachAccidentCents: 50_000_000, minUmbrellaCents: 500_000_000 });
    const rs = evaluateRequirements(
      s,
      facts([
        gl({ aggregateCents: 100_000_000 }),
        { ...gl(), coverageType: 'AUTO', eachOccurrenceCents: 100_000_000, aggregateCents: null },
        { ...gl(), coverageType: 'WORKERS_COMP', eachOccurrenceCents: 10_000_000, aggregateCents: null },
      ]),
      TODAY,
    );
    expect(byRule(rs, 'COI_GL_AGGREGATE')!.outcome).toBe('short');
    expect(byRule(rs, 'COI_AUTO')!.outcome).toBe('met');
    expect(byRule(rs, 'COI_WC')!.outcome).toBe('short');
    expect(byRule(rs, 'COI_UMBRELLA')!.outcome).toBe('missing');
    expect(byRule(rs, 'COI_UMBRELLA')!.reason).toContain('$5,000,000.00 required');
  });

  it('a WC exemption satisfies the WC rule', () => {
    const rs = evaluateRequirements(set({ wcRequired: true }), facts([gl()], { wcExemptionValid: true }), TODAY);
    expect(byRule(rs, 'COI_WC')!.outcome).toBe('met');
  });

  it('an unstated limit is not met (never assumed)', () => {
    const rs = evaluateRequirements(set(), facts([gl({ eachOccurrenceCents: null })]), TODAY);
    expect(byRule(rs, 'COI_GL_OCCURRENCE')!.outcome).toBe('not_met');
  });

  it('dollars() formats cents without floats', () => {
    expect(dollars(100_000_000)).toBe('$1,000,000.00');
    expect(dollars(123_456)).toBe('$1,234.56');
    expect(dollars(-500)).toBe('($5.00)');
  });
});

describe('endorsements and holder (criterion 2)', () => {
  const s = set({ requireAdditionalInsured: true, requireWaiverOfSubrogation: true, certificateHolderNames: ['ARTISTRY HOMES LLC'] });
  it('pass when shown; holder matches on a normalised name', () => {
    const rs = evaluateRequirements(s, facts([gl()]), TODAY);
    expect(byRule(rs, 'END_ADDITIONAL_INSURED')!.outcome).toBe('met');
    expect(byRule(rs, 'END_WAIVER_SUBROGATION')!.outcome).toBe('met');
    expect(byRule(rs, 'CERT_HOLDER')!.outcome).toBe('met');
    expect(holderMatches('Artistry Homes, L.L.C.', 'artistry homes')).toBe(true);
  });
  it('fail when false / unknown / wrong holder, with the reason', () => {
    const rs = evaluateRequirements(s, facts([gl({ additionalInsured: false, waiverOfSubrogation: null, certificateHolder: 'Heritage Interiors Inc' })]), TODAY);
    expect(byRule(rs, 'END_ADDITIONAL_INSURED')!.outcome).toBe('not_met');
    expect(byRule(rs, 'END_ADDITIONAL_INSURED')!.reason).toMatch(/does not show/);
    expect(byRule(rs, 'END_WAIVER_SUBROGATION')!.reason).toMatch(/could not confirm/);
    expect(byRule(rs, 'CERT_HOLDER')!.outcome).toBe('not_met');
    expect(byRule(rs, 'CERT_HOLDER')!.reason).toContain('“Heritage Interiors Inc”');
    expect(holderMatches('Heritage Interiors Inc', 'Artistry Homes LLC')).toBe(false);
  });
});

describe('expiry, grace and warn-only (criterion 3)', () => {
  it('within the lead time = expiring (not blocking)', () => {
    const rs = evaluateRequirements(set(), facts([gl({ expirationDate: '2026-11-10' })]), TODAY);
    expect(byRule(rs, 'COI_GL_OCCURRENCE')!.outcome).toBe('expiring');
    expect(summarise(set(), rs).holds).toBe(false);
    expect(summarise(set(), rs).state).toBe('expiring');
  });
  it('past expiry blocks; inside grace it does not', () => {
    const past = facts([gl({ expirationDate: '2026-10-20' })]);
    expect(byRule(evaluateRequirements(set(), past, TODAY), 'COI_GL_OCCURRENCE')!.outcome).toBe('expired');
    const g = set({ graceDays: 5 });
    const rs = evaluateRequirements(g, past, TODAY);
    expect(byRule(rs, 'COI_GL_OCCURRENCE')!.outcome).toBe('grace');
    expect(summarise(g, rs).holds).toBe(false);
  });
  it('block_payment = false reports issues but never holds', () => {
    const w = set({ blockPayment: false });
    const rs = evaluateRequirements(w, facts([], { w9: { status: 'missing' } }), TODAY);
    const sum = summarise(w, rs);
    expect(sum.blocking.length).toBeGreaterThan(0);
    expect(sum.holds).toBe(false);
  });
  it('a submission waiting for review turns failures into "pending" (still blocking)', () => {
    const rs = evaluateRequirements(set(), facts([], { w9: { status: 'missing' }, pendingW9: true, pendingCoi: true }), TODAY);
    expect(rs.every((r) => r.outcome === 'pending')).toBe(true);
    expect(summarise(set(), rs).state).toBe('pending');
    expect(summarise(set(), rs).holds).toBe(true);
  });
});

describe('selection + merge (criterion 4)', () => {
  const firm = set({ id: 'firm', vendorType: null, coiRequired: false, minGlEachOccurrenceCents: null, minGlAggregateCents: null });
  const subs = set({ id: 'subs' });
  const artistry = set({ id: 'art', locationId: 'loc-art', certificateHolderNames: ['Artistry Homes LLC'], minGlEachOccurrenceCents: 200_000_000 });
  const sets = [firm, subs, artistry];
  it('most specific wins', () => {
    expect(selectRequirementSet(sets, { vendorType: 'subcontractor', workType: null, is1099Eligible: true }, 'loc-art')!.id).toBe('art');
    expect(selectRequirementSet(sets, { vendorType: 'subcontractor', workType: null, is1099Eligible: true }, 'loc-other')!.id).toBe('subs');
    expect(selectRequirementSet(sets, { vendorType: 'supplier', workType: null, is1099Eligible: false }, null)!.id).toBe('firm');
  });
  it('an exempt vendor is out of scope unless a set targets exempt', () => {
    expect(selectRequirementSet(sets, { vendorType: 'exempt', workType: null, is1099Eligible: null }, null)).toBeNull();
    expect(selectRequirementSet([...sets, set({ id: 'ex', vendorType: 'exempt' })], { vendorType: 'exempt', workType: null, is1099Eligible: null }, null)!.id).toBe('ex');
  });
  it('1099 scope and work type filter', () => {
    const only1099 = set({ id: 'n', vendorType: null, tax1099: 'eligible' });
    expect(selectRequirementSet([only1099], { vendorType: null, workType: null, is1099Eligible: false }, null)).toBeNull();
    expect(selectRequirementSet([only1099], { vendorType: null, workType: null, is1099Eligible: true }, null)!.id).toBe('n');
    const roof = set({ id: 'r', workType: 'roofing' });
    expect(selectRequirementSet([subs, roof], { vendorType: 'subcontractor', workType: 'roofing', is1099Eligible: null }, null)!.id).toBe('r');
  });
  it('merge is the strictest union', () => {
    const m = mergeRequirementSets([subs, artistry, set({ id: 'x', blockPayment: false, graceDays: 10, requireWaiverOfSubrogation: true, certificateHolderNames: ['Clive Power Equipment'] })])!;
    expect(m.minGlEachOccurrenceCents).toBe(200_000_000);
    expect(m.requireWaiverOfSubrogation).toBe(true);
    expect(m.blockPayment).toBe(true);
    expect(m.graceDays).toBe(0);
    expect(m.certificateHolderNames).toEqual(['Artistry Homes LLC', 'Clive Power Equipment']);
  });
});

describe('proposed COI check (vendor read-back)', () => {
  it('checks only COI rules', () => {
    const rs = checkProposedCoi(set(), [gl({ eachOccurrenceCents: 50_000_000 })], TODAY);
    expect(rs.find((r) => r.rule === 'W9')).toBeUndefined();
    expect(rs.find((r) => r.rule === 'COI_GL_OCCURRENCE')!.outcome).toBe('short');
  });
});

describe('facts + needs', () => {
  it('legacy GL/WC doc rows count as evidence when no structured lines exist', () => {
    const f = buildFacts([{ id: 'd', vendor_id: 'v', doc_type: 'GL_COI', status: 'VALID', expiration_date: '2027-01-01', coverage_amount_cents: 100_000_000 }], [], [], TODAY);
    expect(f.coverages[0]).toMatchObject({ coverageType: 'GENERAL_LIABILITY', eachOccurrenceCents: 100_000_000 });
    expect(f.w9.status).toBe('missing');
  });
  it('needs: W-9 missing, COI short → coi with reason; expiring → renewal with the set lead; pending → nothing', () => {
    const s = set({ expiryLeadDays: 45 });
    const short = evaluateRequirements(s, facts([gl({ eachOccurrenceCents: 50_000_000 })], { w9: { status: 'missing' } }), TODAY);
    const n1 = needsFromRules(short, s);
    expect(n1.map((n) => n.kind)).toEqual(['w9', 'coi']);
    expect(n1[1].reason).toContain('$500,000.00 on file');
    const soon = evaluateRequirements(s, facts([gl({ expirationDate: '2026-11-20' })]), TODAY);
    const n2 = needsFromRules(soon, s);
    expect(n2).toEqual([{ kind: 'coi', docTypes: ['GL_COI'], renewal: true, dueDate: '2026-11-20', leadDays: 45 }]);
    const pend = evaluateRequirements(s, facts([], { pendingCoi: true }), TODAY);
    expect(needsFromRules(pend, s)).toEqual([]);
  });
});

describe('bank-change call-back (criterion 10, pure)', () => {
  const row = { status: 'pending' as const, request_phone: '(515) 555-0100', opened_by: 'user_maker' };
  it('refuses the number from the request, the maker, and an unknown source', () => {
    expect(validateCallBack(row, { actor: 'user_checker', phoneUsed: '+1 515 555 0100', phoneSource: 'vendor_master', contactName: 'Pat Lee' })).toMatch(/came with the change request/);
    expect(validateCallBack(row, { actor: 'user_maker', phoneUsed: '515-555-0199', phoneSource: 'vendor_master', contactName: 'Pat Lee' })).toMatch(/someone else/);
    expect(validateCallBack(row, { actor: 'user_checker', phoneUsed: '515-555-0199', phoneSource: 'the email', contactName: 'Pat Lee' })).toMatch(/where the number/);
    expect(validateCallBack(row, { actor: 'user_checker', phoneUsed: '515-555-0199', phoneSource: 'vendor_master', contactName: 'Pat Lee' })).toBeNull();
    expect(phoneDigits('+1 (515) 555-0100')).toBe('5155550100');
  });
});

describe('TIN handling (criterion 9, pure)', () => {
  it('normalises and rejects implausible TINs', () => {
    expect(normaliseTin('12-3456780')).toBe('123456780');
    expect(normaliseTin('1234')).toBeNull();
    expect(tinLooksValid('000123456', 'SSN')).toBe(false);
    expect(tinLooksValid('900123456', 'SSN')).toBe(false);
    expect(tinLooksValid('111111111', 'EIN')).toBe(false);
    expect(tinLooksValid('071234567', 'EIN')).toBe(false);
    expect(tinLooksValid('421234567', 'EIN')).toBe(true);
    expect(tinLooksValid('521234567', 'SSN')).toBe(true);
  });
  it('round-trips with a key; returns null without one; never contains the digits', () => {
    const prev = process.env.TIN_ENCRYPTION_KEY;
    delete process.env.TIN_ENCRYPTION_KEY;
    expect(encryptTin('421234567')).toBeNull();
    process.env.TIN_ENCRYPTION_KEY = 'a'.repeat(64);
    const sealed = encryptTin('421234567')!;
    expect(sealed).not.toContain('421234567');
    expect(decryptTin(sealed)).toBe('421234567');
    expect(decryptTin(sealed.replace(/.$/, sealed.endsWith('A') ? 'B' : 'A'))).toBeNull();
    if (prev === undefined) delete process.env.TIN_ENCRYPTION_KEY;
    else process.env.TIN_ENCRYPTION_KEY = prev;
  });
});

describe('review input + portal wording', () => {
  it('validateCoverages demands type, expiry and a limit', () => {
    expect(validateCoverages([])).toMatch(/Key at least one/);
    expect(validateCoverages([{ coverage_type: 'GENERAL_LIABILITY', each_occurrence_cents: 1, aggregate_cents: null, effective_date: null, expiration_date: null }])).toMatch(/expiration/);
    expect(validateCoverages([{ coverage_type: 'WORKERS_COMP', each_occurrence_cents: null, aggregate_cents: null, effective_date: '2026-01-01', expiration_date: '2027-01-01' }])).toBeNull();
  });
  it('a rejected submission shows the reason to the vendor', () => {
    const item = portalItem('COI', {
      id: 's', org_id: 'o', vendor_id: 'v', doc_kind: 'COI', source: 'portal_upload', document_id: null, portal_token_id: null, request_id: null,
      status: 'rejected', ai_status: 'done', ai_note: null, ai_model: null, ai_decision_id: null, extracted: {}, rule_results: [], rules_passed: false,
      w9_form: null, tin_last4: null, reviewed_by: 'u', reviewed_at: '2026-10-22T00:00:00Z', decision_reason: 'Holder must read Artistry Homes LLC', accepted_doc_ids: null,
      created_by: null, created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-22T00:00:00Z',
    }, false, null, 'Artistry Homes');
    expect(item.state).toBe('rejected');
    expect(item.rejectedReason).toBe('Holder must read Artistry Homes LLC');
  });
});

describe('clampCalledAt (bank-change call-back time)', () => {
  const opened = '2026-10-20T10:00:00.000Z';
  const now = new Date('2026-10-23T12:00:00.000Z');
  it('keeps a time inside [opened, now]', () => {
    expect(clampCalledAt('2026-10-21T09:00:00Z', opened, now)).toBe('2026-10-21T09:00:00.000Z');
  });
  it('clamps before-opened up and future down; bad input → now', () => {
    expect(clampCalledAt('2026-01-01T00:00:00Z', opened, now)).toBe(opened);
    expect(clampCalledAt('2027-01-01T00:00:00Z', opened, now)).toBe(now.toISOString());
    expect(clampCalledAt('not a date', opened, now)).toBe(now.toISOString());
    expect(clampCalledAt(null, opened, now)).toBe(now.toISOString());
  });
});
