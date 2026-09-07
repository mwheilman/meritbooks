import { describe, it, expect } from 'vitest';
import {
  normalizeClassification,
  mapDocType,
  INTAKE_ROUTES,
  type IntakeDocType,
} from './classify';

describe('INTAKE_ROUTES', () => {
  it('has a self-consistent entry for every doc type', () => {
    for (const key of Object.keys(INTAKE_ROUTES) as IntakeDocType[]) {
      const entry = INTAKE_ROUTES[key];
      expect(entry.docType).toBe(key);
      expect(entry.route.startsWith('/')).toBe(true);
      expect(entry.label.length).toBeGreaterThan(0);
      if (entry.parseEndpoint !== null) {
        expect(entry.parseEndpoint.startsWith('/api/')).toBe(true);
      }
    }
  });

  it('routes FORMATION_DOC and UNKNOWN with no parser (parseEndpoint null)', () => {
    expect(INTAKE_ROUTES.FORMATION_DOC.parseEndpoint).toBeNull();
    expect(INTAKE_ROUTES.FORMATION_DOC.route).toBe('/onboarding');
    expect(INTAKE_ROUTES.UNKNOWN.parseEndpoint).toBeNull();
    expect(INTAKE_ROUTES.UNKNOWN.route).toBe('/onboarding');
  });

  it('routes each specific type to its documented destination + parser', () => {
    expect(INTAKE_ROUTES.LOAN).toMatchObject({ route: '/debt', parseEndpoint: '/api/debt/parse' });
    expect(INTAKE_ROUTES.LEASE).toMatchObject({ route: '/leases', parseEndpoint: '/api/leases/parse' });
    expect(INTAKE_ROUTES.BILL).toMatchObject({ route: '/bills', parseEndpoint: '/api/bills/parse' });
    expect(INTAKE_ROUTES.BANK_STATEMENT).toMatchObject({
      route: '/bank-feed',
      parseEndpoint: '/api/bank-feed/import-statement',
    });
    expect(INTAKE_ROUTES.TRIAL_BALANCE).toMatchObject({
      route: '/onboarding',
      parseEndpoint: '/api/onboarding/import/tb',
    });
    expect(INTAKE_ROUTES.W9).toMatchObject({ route: '/vendors', parseEndpoint: '/api/vendors/w9-parse' });
    expect(INTAKE_ROUTES.COI).toMatchObject({ route: '/vendor-compliance', parseEndpoint: '/api/vendors/coi-parse' });
    expect(INTAKE_ROUTES.CUSTOMER_CONTRACT).toMatchObject({
      route: '/invoices',
      parseEndpoint: '/api/invoices/parse-contract',
    });
    expect(INTAKE_ROUTES.OPERATING_AGREEMENT).toMatchObject({
      route: '/onboarding',
      parseEndpoint: '/api/onboarding/import/equity',
    });
    expect(INTAKE_ROUTES.INSURANCE_POLICY).toMatchObject({ route: '/insurance', parseEndpoint: '/api/insurance/parse' });
    expect(INTAKE_ROUTES.PREPAID).toMatchObject({ route: '/prepaids', parseEndpoint: '/api/prepaid/parse' });
    expect(INTAKE_ROUTES.SUBSCRIPTION).toMatchObject({
      route: '/subscriptions',
      parseEndpoint: '/api/subscriptions/parse-agreement',
    });
    expect(INTAKE_ROUTES.PAYROLL_REGISTER).toMatchObject({
      route: '/payroll',
      parseEndpoint: '/api/payroll/import-register',
    });
    expect(INTAKE_ROUTES.WIP_SCHEDULE).toMatchObject({ route: '/jobs', parseEndpoint: '/api/onboarding/import/wip' });
  });
});

describe('mapDocType', () => {
  it('accepts exact canonical types', () => {
    expect(mapDocType('LOAN')).toBe('LOAN');
    expect(mapDocType('BANK_STATEMENT')).toBe('BANK_STATEMENT');
    expect(mapDocType('UNKNOWN')).toBe('UNKNOWN');
  });

  it('normalizes casing, spaces, and hyphens', () => {
    expect(mapDocType('bank statement')).toBe('BANK_STATEMENT');
    expect(mapDocType('bank-statement')).toBe('BANK_STATEMENT');
    expect(mapDocType('  Trial_Balance  ')).toBe('TRIAL_BALANCE');
    expect(mapDocType('customer contract')).toBe('CUSTOMER_CONTRACT');
  });

  it('falls back to UNKNOWN for garbled, empty, hallucinated, or non-string input', () => {
    expect(mapDocType('')).toBe('UNKNOWN');
    expect(mapDocType('receipt')).toBe('UNKNOWN');
    expect(mapDocType('a legal document of some kind')).toBe('UNKNOWN');
    expect(mapDocType(null)).toBe('UNKNOWN');
    expect(mapDocType(42)).toBe('UNKNOWN');
    expect(mapDocType(undefined)).toBe('UNKNOWN');
  });
});

describe('normalizeClassification', () => {
  it('maps a well-formed classification and resolves route + parseEndpoint', () => {
    const c = normalizeClassification({
      doc_type: 'LOAN',
      confidence: 0.95,
      note: 'Promissory note between Borrower and Northwest Bank.',
    });
    expect(c.ok).toBe(true);
    expect(c.docType).toBe('LOAN');
    expect(c.label).toBe('Loan / Credit Agreement');
    expect(c.confidence).toBe(0.95);
    expect(c.route).toBe('/debt');
    expect(c.parseEndpoint).toBe('/api/debt/parse');
    expect(c.note).toBe('Promissory note between Borrower and Northwest Bank.');
  });

  it('accepts alternate field names (docType / type, reasoning)', () => {
    expect(normalizeClassification({ docType: 'W9', confidence: 0.9 }).docType).toBe('W9');
    expect(normalizeClassification({ type: 'COI', confidence: 0.8 }).docType).toBe('COI');
    const withReasoning = normalizeClassification({ doc_type: 'BILL', confidence: 0.7, reasoning: 'Invoice from vendor' });
    expect(withReasoning.note).toBe('Invoice from vendor');
  });

  it('clamps confidence into 0-1 and coerces numeric strings', () => {
    expect(normalizeClassification({ doc_type: 'LEASE', confidence: 1.7 }).confidence).toBe(1);
    expect(normalizeClassification({ doc_type: 'LEASE', confidence: -0.5 }).confidence).toBe(0);
    expect(normalizeClassification({ doc_type: 'BILL', confidence: '0.82' }).confidence).toBeCloseTo(0.82);
    expect(normalizeClassification({ doc_type: 'BILL', confidence: 'nonsense' }).confidence).toBe(0);
  });

  it('downgrades a recognized type with weak confidence to UNKNOWN (unsure -> onboarding)', () => {
    const c = normalizeClassification({ doc_type: 'LOAN', confidence: 0.2 });
    expect(c.docType).toBe('UNKNOWN');
    expect(c.route).toBe('/onboarding');
    expect(c.parseEndpoint).toBeNull();
    // The raw confidence is preserved so the UI can show how weak the signal was.
    expect(c.confidence).toBe(0.2);
  });

  it('routes a garbled / hallucinated docType to UNKNOWN', () => {
    const c = normalizeClassification({ doc_type: 'MYSTERY_DOC', confidence: 0.99 });
    expect(c.docType).toBe('UNKNOWN');
    expect(c.route).toBe('/onboarding');
    expect(c.parseEndpoint).toBeNull();
  });

  it('routes FORMATION_DOC to onboarding with no parser', () => {
    const c = normalizeClassification({ doc_type: 'FORMATION_DOC', confidence: 0.9 });
    expect(c.docType).toBe('FORMATION_DOC');
    expect(c.route).toBe('/onboarding');
    expect(c.parseEndpoint).toBeNull();
  });

  it('never throws on empty / garbage input and defaults to UNKNOWN', () => {
    expect(normalizeClassification(undefined).docType).toBe('UNKNOWN');
    expect(normalizeClassification(null).docType).toBe('UNKNOWN');
    expect(normalizeClassification({}).docType).toBe('UNKNOWN');
    expect(normalizeClassification('not an object').docType).toBe('UNKNOWN');
    expect(normalizeClassification({}).note).toBe('');
  });
});
