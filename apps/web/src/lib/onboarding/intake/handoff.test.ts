import { describe, it, expect } from 'vitest';
import { buildHandoff, handoffForFile, formatProblem, openingStepHref } from './handoff';
import { INTAKE_DOC_TYPES } from './types';

const PATH = 'intake/org-1/0b8f3c3e-1111-4222-8333-944445555666-Trial_Balance.xlsx';

describe('openingStepHref', () => {
  it('carries the storage path to the wizard Opening step', () => {
    const href = openingStepHref(PATH);
    const url = new URL(href, 'https://x.test');
    expect(url.pathname).toBe('/onboarding');
    expect(url.searchParams.get('step')).toBe('opening');
    expect(url.searchParams.get('intake')).toBe(PATH);
  });
});

describe('buildHandoff', () => {
  it('trial balance and general ledger go to the Opening step by URL', () => {
    for (const t of ['TRIAL_BALANCE', 'GENERAL_LEDGER'] as const) {
      const h = buildHandoff(t, PATH);
      expect(h.kind).toBe('opening');
      expect(h.href).toBe(openingStepHref(PATH));
    }
  });

  it('formation docs are reviewed in-page (no URL)', () => {
    for (const t of ['FORMATION_DOC', 'EIN_LETTER', 'OPERATING_AGREEMENT'] as const) {
      const h = buildHandoff(t, PATH);
      expect(h.kind).toBe('formation');
      expect(h.href).toBeNull();
    }
  });

  it('loans and budgets carry ?intake= to their pages', () => {
    const loan = buildHandoff('LOAN', PATH);
    expect(loan.kind).toBe('debt');
    expect(new URL(loan.href!, 'https://x.test').searchParams.get('intake')).toBe(PATH);
    expect(loan.documentType).toBe('LOAN');
    const budget = buildHandoff('BUDGET', PATH);
    expect(budget.kind).toBe('budget');
    expect(new URL(budget.href!, 'https://x.test').pathname).toBe('/budgets');
  });

  it('customer / vendor lists and agings fill the right A/R / A/P slot', () => {
    expect(buildHandoff('CUSTOMER_LIST', PATH)).toMatchObject({ kind: 'ar', subledgerKind: 'customers' });
    expect(buildHandoff('AR_AGING', PATH)).toMatchObject({ kind: 'ar', subledgerKind: 'open_ar' });
    expect(buildHandoff('VENDOR_LIST', PATH)).toMatchObject({ kind: 'ap', subledgerKind: 'vendors' });
    expect(buildHandoff('AP_AGING', PATH)).toMatchObject({ kind: 'ap', subledgerKind: 'open_ap' });
    const href = new URL(buildHandoff('AR_AGING', PATH).href!, 'https://x.test');
    expect(href.pathname).toBe('/onboarding/sections/customers-ar');
    expect(href.searchParams.get('kind')).toBe('open_ar');
    expect(href.searchParams.get('intake')).toBe(PATH);
  });

  it('org chart and expense policy are saved to documents with the "later" note', () => {
    const org = buildHandoff('ORG_CHART', PATH);
    expect(org.kind).toBe('file');
    expect(org.fileNote).toMatch(/approval chains later/);
    expect(org.href).toBeNull();
    const pol = buildHandoff('EXPENSE_POLICY', PATH);
    expect(pol.kind).toBe('file');
    expect(pol.fileNote).toMatch(/approvals later/);
  });

  it('every doc type yields a handoff with a label and a valid documents doc_type', () => {
    const allowed = new Set(['BILL', 'RECEIPT', 'CONTRACT', 'LEASE', 'LOAN', 'POLICY', 'W9', 'COI', 'STATEMENT', 'OTHER']);
    for (const t of INTAKE_DOC_TYPES) {
      const h = buildHandoff(t, PATH);
      expect(h.actionLabel.length).toBeGreaterThan(0);
      expect(allowed.has(h.documentType)).toBe(true);
      if (h.href) expect(h.href.startsWith('/')).toBe(true);
    }
  });
});

describe('formatProblem / handoffForFile', () => {
  it('spreadsheet receivers need CSV/XLSX', () => {
    expect(formatProblem('opening', 'tb.xlsx')).toBeNull();
    expect(formatProblem('budget', 'budget.csv')).toBeNull();
    expect(formatProblem('ar', 'aging.xls')).toMatch(/Save As/);
    expect(formatProblem('ap', 'aging.pdf')).toMatch(/spreadsheet/);
  });

  it('document readers need a PDF or image', () => {
    expect(formatProblem('debt', 'note.pdf')).toBeNull();
    expect(formatProblem('formation', 'articles.png')).toBeNull();
    expect(formatProblem('formation', 'operating agreement.docx')).toMatch(/PDF/);
  });

  it('an unreadable format downgrades to "keep it on file" with the fix', () => {
    const h = handoffForFile('TRIAL_BALANCE', PATH.replace('.xlsx', '.xls'), 'Trial Balance.xls');
    expect(h.kind).toBe('file');
    expect(h.formatProblem).toMatch(/xlsx/);
    expect(h.href).toBeNull();
    const ok = handoffForFile('TRIAL_BALANCE', PATH, 'Trial Balance.xlsx');
    expect(ok.kind).toBe('opening');
    expect(ok.formatProblem).toBeNull();
  });
});
