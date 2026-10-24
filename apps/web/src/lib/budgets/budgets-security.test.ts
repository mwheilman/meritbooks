/**
 * Department budgets — security-review fixes, pure parts:
 *   H6      decideReadDepartments (legacy read routes' department scope)
 *   MEDIUM  approval SoD is never skipped; approve only from SUBMITTED / IN_REVIEW
 *   H5      BUDGET_PERIOD_CLOSED maps to a 409 PERIOD_CLOSED
 *   LOW     safe template patterns (no RegExp, capped); the .xlsx zip-bomb guard
 */
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { decideBudgetAccess, decideReadDepartments } from './scope';
import { BudgetError, budgetErrorFromDb, checkPlanAction, checkVersionAction, type VersionActionInput } from './lifecycle';
import { compilePattern, patternError, PATTERN_MAX_LENGTH } from './templates/pattern';
import { matchScore } from './templates/resolve';
import { SYSTEM_TEMPLATES } from './templates/system';
import { xlsxBombReason, XLSX_LIMITS } from './xlsx-guard';
import type { AccountLite, TemplateLine } from './types';

const finance = decideBudgetAccess({ userId: 'u_fin', viewAllowed: true, editAllowed: true, approveAllowed: false, financeStaff: true, ownedDepartmentIds: [] });
const head = decideBudgetAccess({ userId: 'u_head', viewAllowed: true, editAllowed: true, approveAllowed: false, financeStaff: false, ownedDepartmentIds: ['d_sales'] });
const nobody = decideBudgetAccess({ userId: 'u_x', viewAllowed: true, editAllowed: true, approveAllowed: false, financeStaff: false, ownedDepartmentIds: [] });

describe('H6: legacy budget reads are department-scoped', () => {
  it('finance sees everything; a head only their departments, never company-level; others nothing', () => {
    expect(decideReadDepartments([finance], null)).toEqual({ departmentIds: null });
    expect(decideReadDepartments([finance], 'd_ops')).toEqual({ departmentIds: ['d_ops'] });
    expect(decideReadDepartments([head], null)).toEqual({ departmentIds: ['d_sales'] });
    expect(decideReadDepartments([head], 'd_sales')).toEqual({ departmentIds: ['d_sales'] });
    expect(decideReadDepartments([head], 'd_ops')).toBe('SCOPE');
    expect(decideReadDepartments([nobody], null)).toBe('FORBIDDEN');
    expect(decideReadDepartments([], null)).toBe('FORBIDDEN');
  });

  it('mixed access across companies resolves to the narrower scope (fail closed)', () => {
    expect(decideReadDepartments([finance, head], null)).toEqual({ departmentIds: ['d_sales'] });
    expect(decideReadDepartments([finance, head], 'd_ops')).toBe('SCOPE');
    expect(decideReadDepartments([finance, { ...finance, canView: false }], null)).toBe('FORBIDDEN');
  });
});

describe('MEDIUM: approval segregation of duties is never skipped', () => {
  const base: VersionActionInput = { action: 'approve', status: 'IN_REVIEW', kind: 'BUDGET', actor: 'u_cfo', submittedBy: 'u_ctl', createdBy: 'u_ctl', openPlans: 0, currentIsLockedOther: false, isCurrent: false };
  const codeOf = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof BudgetError ? e.code : 'other'; } };

  it('version: the maker is the submitter, else the creator; no maker on record → refused', () => {
    expect(checkVersionAction(base)).toBe('APPROVED');
    expect(codeOf(() => checkVersionAction({ ...base, actor: 'u_ctl' }))).toBe('SOD');
    expect(codeOf(() => checkVersionAction({ ...base, submittedBy: null, createdBy: 'u_cfo' }))).toBe('SOD');
    expect(codeOf(() => checkVersionAction({ ...base, submittedBy: null, createdBy: null }))).toBe('SOD');
    expect(checkVersionAction({ ...base, submittedBy: null, createdBy: 'u_ctl' })).toBe('APPROVED');
    expect(codeOf(() => checkVersionAction({ ...base, status: 'DRAFT' }))).toBe('LOCKED');
  });

  it('department plan: approve only from SUBMITTED, never by the submitter, never with no submitter', () => {
    const p = { action: 'approve' as const, versionStatus: 'DRAFT' as const, actor: 'u_ctl', submittedBy: 'u_head', note: null };
    expect(checkPlanAction({ ...p, status: 'SUBMITTED' })).toBe('APPROVED');
    for (const status of ['NOT_STARTED', 'DRAFT', 'RETURNED', 'APPROVED'] as const) {
      expect(codeOf(() => checkPlanAction({ ...p, status }))).toBe('LOCKED');
    }
    expect(codeOf(() => checkPlanAction({ ...p, status: 'SUBMITTED', actor: 'u_head' }))).toBe('SOD');
    expect(codeOf(() => checkPlanAction({ ...p, status: 'SUBMITTED', submittedBy: null }))).toBe('SOD');
  });
});

describe('H5: a closed month maps to a 409', () => {
  it('BUDGET_PERIOD_CLOSED → PERIOD_CLOSED with the trigger’s detail', () => {
    const e = budgetErrorFromDb('ERROR: BUDGET_PERIOD_CLOSED: 2026-01 is closed — its budget can\'t change');
    expect(e?.code).toBe('PERIOD_CLOSED');
    expect(e?.status).toBe(409);
    expect(e?.message).toMatch(/^2026-01 is closed/);
    expect(budgetErrorFromDb('BUDGET_PERIOD_CLOSED')?.message).toMatch(/closed month/);
  });
});

describe('LOW: template patterns are safe (no RegExp)', () => {
  const acct = (name: string, groupName: string | null = null, type = 'OPEX'): AccountLite => ({ id: name, number: '6000', name, type, subType: 'OPEX', groupName });
  const line = (selector: TemplateLine['selector']): TemplateLine => ({ key: 'k', label: 'L', selector, method: 'PY_GROWTH', params: {} });

  it('alternatives, wildcard, literal, case-insensitive', () => {
    const m = compilePattern('salar|wage')!;
    expect(m('Officer Salaries')).toBe(true);
    expect(m('Hourly Wages')).toBe(true);
    expect(m('Rent')).toBe(false);
    expect(compilePattern('workers*comp')!('Workers’ Compensation')).toBe(true);
    expect(compilePattern('workers*comp')!('Comp for workers')).toBe(false);
    expect(compilePattern('401(k)')!('401(k) match')).toBe(true); // literal, not a group
    expect(compilePattern('a.c')!('abc')).toBe(false); // "." is literal
  });

  it('caps length and alternatives; a disallowed pattern matches nothing', () => {
    expect(patternError('a'.repeat(PATTERN_MAX_LENGTH))).toBeNull();
    expect(patternError('a'.repeat(PATTERN_MAX_LENGTH + 1))).toMatch(/100 characters/);
    expect(patternError(Array(21).fill('x').join('|'))).toMatch(/20 alternatives/);
    expect(patternError('*|*')).toMatch(/at least one word/);
    expect(matchScore(line({ types: ['OPEX'], name: 'a'.repeat(101) }), acct('aaaa'))).toBe(0);
    expect(matchScore(line({ types: ['OPEX'], notName: 'b'.repeat(101) }), acct('aaaa'))).toBe(0);
  });

  it('a classic ReDoS shape is just text — and returns at once on a long input', () => {
    const m = compilePattern('(a+)+$')!;
    const started = Date.now();
    expect(m('a'.repeat(50_000) + '!')).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('every system template pattern is allowed, and matching still works', () => {
    for (const t of SYSTEM_TEMPLATES) for (const l of t.lines) for (const src of [l.selector.name, l.selector.group, l.selector.notName]) {
      if (src) expect(patternError(src)).toBeNull();
    }
    const payroll = SYSTEM_TEMPLATES.flatMap((t) => t.lines).find((l) => l.key === 'payroll_taxes')!;
    expect(matchScore(payroll, acct('Workers Comp Insurance'))).toBe(2);
    const salaries = SYSTEM_TEMPLATES.flatMap((t) => t.lines).find((l) => l.key === 'salaries')!;
    expect(matchScore(salaries, acct('Salaries & Wages'))).toBe(2);
    expect(matchScore(salaries, acct('Accrued Salaries Payable'))).toBe(0); // notName
  });
});

// ── a tiny ZIP writer for the guard tests ────────────────────────────────────
interface Part { name: string; data: Buffer; method?: 0 | 8; declaredSize?: number }

function zip(parts: Part[], opts: { zip64Count?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const method = p.method ?? 8;
    const body = method === 8 ? deflateRawSync(p.data) : p.data;
    const name = Buffer.from(p.name, 'utf8');
    const uncompressed = p.declaredSize ?? p.data.length;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(uncompressed, 22);
    lfh.writeUInt16LE(name.length, 26);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(uncompressed, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    locals.push(lfh, name, body);
    centrals.push(cdh, name);
    offset += lfh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.zip64Count ? 0xffff : parts.length, 8);
  eocd.writeUInt16LE(opts.zip64Count ? 0xffff : parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('LOW: the .xlsx zip-bomb guard', () => {
  const sheet = Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Account</t></is></c></row></sheetData></worksheet>');

  it('a normal workbook passes', () => {
    expect(xlsxBombReason(zip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'xl/worksheets/sheet1.xml', data: sheet }, { name: 'xl/styles.xml', data: Buffer.from('<s/>'), method: 0 }]))).toBeNull();
  });

  it('refuses a highly compressible bomb before the reader inflates it', () => {
    const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(30 * 1024 * 1024, 0x41) }]);
    expect(bomb.length).toBeLessThan(200_000);
    expect(xlsxBombReason(bomb)).toMatch(/more than 20 MB|100:1/);
  });

  it('a lying header (declares a tiny size) is caught by the capped inflate', () => {
    const liar = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(25 * 1024 * 1024, 0x42), declaredSize: 100 }]);
    expect(xlsxBombReason(liar)).toMatch(/more than 20 MB/);
  });

  it('refuses a > 100:1 entry past 1 MB, too many entries, ZIP64 and unknown methods', () => {
    const small = { ...XLSX_LIMITS, maxUncompressedBytes: 50 * 1024 * 1024 };
    expect(xlsxBombReason(zip([{ name: 'a.xml', data: Buffer.alloc(5 * 1024 * 1024, 0x43) }]), small)).toMatch(/100:1/);
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.xml`, data: Buffer.from('x'), method: 0 as const }));
    expect(xlsxBombReason(zip(many), { ...XLSX_LIMITS, maxEntries: 4 })).toMatch(/too many parts/);
    expect(xlsxBombReason(zip([{ name: 'a.xml', data: Buffer.from('x') }], { zip64Count: true }))).toMatch(/ZIP64/);
    const odd = zip([{ name: 'a.xml', data: Buffer.from('x'), method: 0 }]);
    odd.writeUInt16LE(12, odd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10); // bzip2 in the central directory
    expect(xlsxBombReason(odd)).toMatch(/unsupported compression/);
    expect(xlsxBombReason(Buffer.from('not a zip at all, just text'))).toMatch(/not a valid/);
    expect(xlsxBombReason(Buffer.alloc(XLSX_LIMITS.maxCompressedBytes + 1))).toMatch(/larger than 10 MB/);
  });
});
