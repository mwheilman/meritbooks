import { describe, it, expect } from 'vitest';
import {
  classifyByFileName,
  classifyByContent,
  classifyByRules,
  countMonthColumns,
  mergeAiAndRules,
  normalizeName,
} from './rules';

describe('normalizeName', () => {
  it('folds separators, drops the extension, splits letter-digit runs', () => {
    expect(normalizeName('Acme_EIN-Letter.pdf')).toBe('acme ein letter');
    expect(normalizeName('CP575.pdf')).toBe('cp 575');
    expect(normalizeName('W9 (signed).PDF')).toBe('w 9 signed');
  });
});

describe('classifyByFileName — PDFs and anything without readable content', () => {
  const cases: Array<[string, string]> = [
    ['Heritage Interiors - Articles of Organization.pdf', 'FORMATION_DOC'],
    ['certificate_of_formation.pdf', 'FORMATION_DOC'],
    ['Operating Agreement (executed).pdf', 'OPERATING_AGREEMENT'],
    ['EIN confirmation letter.pdf', 'EIN_LETTER'],
    ['SS-4.pdf', 'EIN_LETTER'],
    ['CP575.pdf', 'EIN_LETTER'],
    ['Promissory Note - First Bank.pdf', 'LOAN'],
    ['Term Loan Agreement 2024.pdf', 'LOAN'],
    ['SBA 7a docs.pdf', 'LOAN'],
    ['FY2027 Budget.xlsx', 'BUDGET'],
    ['Org Chart.pptx', 'ORG_CHART'],
    ['Travel & Expense Policy.docx', 'EXPENSE_POLICY'],
    ['expense-reimbursement-policy.pdf', 'EXPENSE_POLICY'],
    ['Trial Balance 9-30.xlsx', 'TRIAL_BALANCE'],
    ['General Ledger detail.csv', 'GENERAL_LEDGER'],
    ['AR Aging Summary.csv', 'AR_AGING'],
    ['AP Aging.xlsx', 'AP_AGING'],
    ['customer list.csv', 'CUSTOMER_LIST'],
    ['hubspot-export.csv', 'CUSTOMER_LIST'],
    ['Vendors.csv', 'VENDOR_LIST'],
    ['WIP schedule Q3.xlsx', 'WIP_SCHEDULE'],
    ['Office Lease.pdf', 'LEASE'],
    ['W9.pdf', 'W9'],
  ];
  for (const [name, type] of cases) {
    it(`${name} → ${type}`, () => {
      expect(classifyByFileName(name).docType).toBe(type);
    });
  }

  it('does not match substrings inside other words', () => {
    expect(classifyByFileName('information packet.pdf').docType).toBe('UNKNOWN'); // not "formation"
    expect(classifyByFileName('Steinberg photo.png').docType).toBe('UNKNOWN'); // not "ein"
    expect(classifyByFileName('locations.csv').docType).toBe('UNKNOWN'); // not "loc"
  });

  it('expense policy wins over insurance policy; loan agreement wins over generic agreement', () => {
    expect(classifyByFileName('Expense Policy.pdf').docType).toBe('EXPENSE_POLICY');
    expect(classifyByFileName('GL Insurance Policy.pdf').docType).not.toBe('EXPENSE_POLICY');
    expect(classifyByFileName('Loan Agreement.pdf').docType).toBe('LOAN');
    expect(classifyByFileName('Master Services Agreement.pdf').docType).toBe('CUSTOMER_CONTRACT');
  });

  it('returns UNKNOWN with zero confidence for a meaningless name', () => {
    expect(classifyByFileName('scan0001.pdf')).toEqual({ docType: 'UNKNOWN', confidence: 0, reason: '' });
  });
});

describe('classifyByContent — spreadsheet header sniffing', () => {
  it('Account + Debit + Credit → trial balance', () => {
    const r = classifyByContent(['Account', 'Debit', 'Credit', '1000 Cash', '125,000.00', '']);
    expect(r.docType).toBe('TRIAL_BALANCE');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('QuickBooks title rows are honored ("Trial Balance" above the header)', () => {
    const r = classifyByContent(['Heritage Interiors LLC', 'Trial Balance', 'As of September 30, 2026', '', 'Debit', 'Credit']);
    expect(r.docType).toBe('TRIAL_BALANCE');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('dated debit/credit lines with memos → general ledger detail, not a TB', () => {
    expect(classifyByContent(['Date', 'Transaction Type', 'Num', 'Name', 'Memo', 'Split', 'Debit', 'Credit']).docType).toBe('GENERAL_LEDGER');
  });

  it('Customer + Balance / Due → open A/R', () => {
    expect(classifyByContent(['Customer', 'Invoice #', 'Due Date', 'Open Balance']).docType).toBe('AR_AGING');
    expect(classifyByContent(['Customer', 'Current', '1 - 30', '31 - 60', 'Total']).docType).toBe('AR_AGING');
  });

  it('Customer + contact details (no balances) → customer list', () => {
    const r = classifyByContent(['Customer Name', 'Email', 'Phone', 'Address', 'City']);
    expect(r.docType).toBe('CUSTOMER_LIST');
  });

  it('Vendor + Balance / Due → open A/P; Vendor + contacts → vendor list', () => {
    expect(classifyByContent(['Vendor', 'Bill No', 'Due Date', 'Amount Due']).docType).toBe('AP_AGING');
    expect(classifyByContent(['Vendor', 'Email', 'Phone', '1099']).docType).toBe('VENDOR_LIST');
  });

  it('"Budget" or ≥6 month columns → budget', () => {
    expect(classifyByContent(['Account', 'FY2027 Budget']).docType).toBe('BUDGET');
    const months = ['Account', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Total'];
    expect(classifyByContent(months).docType).toBe('BUDGET');
    expect(classifyByContent(['Account', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06']).docType).toBe('BUDGET');
  });

  it('payroll, WIP, org chart, bank, CRM signatures', () => {
    expect(classifyByContent(['Employee', 'Gross Pay', 'Net Pay', 'FICA']).docType).toBe('PAYROLL_REGISTER');
    expect(classifyByContent(['Job', 'Contract Amount', 'Cost to Date', '% Complete', 'Billed to Date']).docType).toBe('WIP_SCHEDULE');
    expect(classifyByContent(['Employee', 'Title', 'Reports To']).docType).toBe('ORG_CHART');
    expect(classifyByContent(['Date', 'Description', 'Withdrawals', 'Deposits', 'Balance']).docType).toBe('BANK_STATEMENT');
    expect(classifyByContent(['Company Name', 'Contact', 'Email', 'Lifecycle Stage']).docType).toBe('CUSTOMER_LIST');
  });

  it('Account + Balance (no Dr/Cr) still reads as a trial balance, at lower confidence', () => {
    const r = classifyByContent(['Account', 'Balance']);
    expect(r.docType).toBe('TRIAL_BALANCE');
    expect(r.confidence).toBeLessThan(0.75);
  });

  it('returns UNKNOWN for content with no signal', () => {
    expect(classifyByContent(['foo', 'bar', 'baz']).docType).toBe('UNKNOWN');
    expect(classifyByContent([]).docType).toBe('UNKNOWN');
  });
});

describe('countMonthColumns', () => {
  it('counts distinct month labels in several spellings', () => {
    expect(countMonthColumns(['January', 'February', 'March'])).toBe(3);
    expect(countMonthColumns(['Jan 2027', 'Feb 2027'])).toBe(2);
    expect(countMonthColumns(['Account', 'Total'])).toBe(0);
  });
});

describe('classifyByRules — merge of content + file name', () => {
  it('agreement boosts confidence', () => {
    const r = classifyByRules({ fileName: 'Trial Balance.csv', cells: ['Account', 'Debit', 'Credit'] });
    expect(r.docType).toBe('TRIAL_BALANCE');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('content beats a weaker, conflicting file name', () => {
    // A generically-named export whose headers clearly say A/R.
    const r = classifyByRules({ fileName: 'export (3).csv', cells: ['Customer', 'Open Balance', 'Due Date'] });
    expect(r.docType).toBe('AR_AGING');
  });

  it('falls back to the file name when there is no content (PDF)', () => {
    expect(classifyByRules({ fileName: 'Articles of Incorporation.pdf' }).docType).toBe('FORMATION_DOC');
    expect(classifyByRules({ fileName: 'Articles of Incorporation.pdf', cells: [] }).docType).toBe('FORMATION_DOC');
  });
});

describe('mergeAiAndRules', () => {
  const rulesTb = { docType: 'TRIAL_BALANCE' as const, confidence: 0.9, reason: 'Has Account, Debit and Credit columns' };
  const rulesNone = { docType: 'UNKNOWN' as const, confidence: 0, reason: '' };

  it('AI off → rules', () => {
    expect(mergeAiAndRules(null, rulesTb)).toMatchObject({ docType: 'TRIAL_BALANCE', source: 'rules' });
  });

  it('AI unsure → rules when rules found something', () => {
    expect(mergeAiAndRules({ docType: 'UNKNOWN', confidence: 0.2, note: '' }, rulesTb)).toMatchObject({ source: 'rules', docType: 'TRIAL_BALANCE' });
    expect(mergeAiAndRules({ docType: 'UNKNOWN', confidence: 0.2, note: 'unclear' }, rulesNone)).toMatchObject({ source: 'ai', docType: 'UNKNOWN' });
  });

  it('agreement keeps the AI source with the higher confidence', () => {
    expect(mergeAiAndRules({ docType: 'TRIAL_BALANCE', confidence: 0.7, note: 'TB' }, rulesTb)).toMatchObject({ source: 'ai', confidence: 0.9 });
  });

  it('disagreement: AI wins unless rules are near-certain and AI is weak', () => {
    expect(mergeAiAndRules({ docType: 'BUDGET', confidence: 0.8, note: '' }, rulesTb).docType).toBe('BUDGET');
    expect(mergeAiAndRules({ docType: 'BUDGET', confidence: 0.5, note: '' }, rulesTb).docType).toBe('TRIAL_BALANCE');
  });
});
