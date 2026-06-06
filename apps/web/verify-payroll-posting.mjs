#!/usr/bin/env node
/**
 * verify-payroll-posting.mjs — proves the GATE 12.3 payroll-run entry builder
 * produces a balanced multi-liability entry, and that the per-line reconciliation
 * guard (net + employee withholdings == gross) holds. Pure logic, no DB.
 *
 * Mirrors apps/web/src/lib/money/posting/payroll-posting.ts (TS is source of truth).
 * Run: node apps/web/verify-payroll-posting.mjs
 */

let pass = 0, fail = 0;
const A = { wages: 'acct-6000', empTax: 'acct-6010', clearing: 'acct-1096', fed: 'acct-2200', state: 'acct-2210', fica: 'acct-2220', garn: 'acct-2270', health: 'acct-2230', retire: 'acct-2240', wc: 'acct-2250' };

function classifyTax(agency) {
  const a = agency.toLowerCase();
  if (/(fica|social security|ss|medicare)/.test(a)) return A.fica;
  if (/(federal|irs|fed|941|940|944)/.test(a)) return A.fed;
  return A.state;
}
function classifyDeduction(kind) {
  const k = kind.toLowerCase();
  if (/(child support|garnish|levy|withholding order)/.test(k)) return A.garn;
  if (/(health|medical|dental|vision|hsa|fsa)/.test(k)) return A.health;
  if (/(401|retire|pension|roth)/.test(k)) return A.retire;
  throw new Error(`unmapped deduction ${kind}`);
}
const EXP = { health: 'acct-6020', retire: 'acct-6030', wc: 'acct-6040' };
function classifyBenefit(kind) {
  const k = kind.toLowerCase();
  if (/(health|medical|dental|vision|hsa|fsa)/.test(k)) return { expense: EXP.health, payable: A.health };
  if (/(401|retire|pension|roth|match)/.test(k)) return { expense: EXP.retire, payable: A.retire };
  if (/(workers? comp|workman|wc)/.test(k)) return { expense: EXP.wc, payable: A.wc };
  throw new Error(`unmapped benefit ${kind}`);
}

function mapReceipt(receipt) {
  const liab = new Map();
  const add = (id, c) => liab.set(id, (liab.get(id) || 0) + c);
  const wageByDept = new Map();
  let empTaxTotal = 0, net = 0;
  const empExpense = [];
  for (const ln of receipt.lines) {
    const et = ln.employeeTaxes.reduce((s, t) => s + t.cents, 0);
    const dd = ln.postTaxDeductions.reduce((s, d) => s + d.cents, 0);
    if (ln.netCents + et + dd !== ln.grossCents) throw new Error(`reconcile fail ${ln.employeeHandle}`);
    net += ln.netCents;
    wageByDept.set(ln.departmentId, (wageByDept.get(ln.departmentId) || 0) + ln.grossCents);
    for (const t of ln.employeeTaxes) add(classifyTax(t.agency), t.cents);
    for (const d of ln.postTaxDeductions) add(classifyDeduction(d.kind), d.cents);
    for (const t of ln.employerTaxes) { add(classifyTax(t.agency), t.cents); empTaxTotal += t.cents; }
    for (const b of (ln.benefits || [])) { const { expense, payable } = classifyBenefit(b.kind); empExpense.push(b.cents); add(payable, b.cents); }
  }
  const lines = [];
  for (const [departmentId, gross] of wageByDept) lines.push({ debit_cents: gross, credit_cents: 0, departmentId });
  if (empTaxTotal > 0) lines.push({ debit_cents: empTaxTotal, credit_cents: 0 });
  for (const c of empExpense) lines.push({ debit_cents: c, credit_cents: 0 });
  for (const [, cents] of liab) lines.push({ debit_cents: 0, credit_cents: cents });
  if (net > 0) lines.push({ debit_cents: 0, credit_cents: net });
  return lines;
}

function check(name, lines) {
  const d = lines.reduce((s, l) => s + l.debit_cents, 0);
  const c = lines.reduce((s, l) => s + l.credit_cents, 0);
  const ok = d === c && d > 0 && lines.length >= 2;
  if (ok) { pass++; console.log(`  \u2713 ${name} (D=${d} C=${c}, ${lines.length} lines)`); }
  else { fail++; console.log(`  \u2717 ${name} UNBALANCED D=${d} C=${c}`); }
}

console.log('\nGATE 12.3 payroll-run posting — balance verification\n');

// Single employee: gross 500000, fed 80000, fica 38250, state 20000 -> net 361750
check('single employee', mapReceipt({
  lines: [{
    employeeHandle: 'e1', grossCents: 500000, netCents: 361750,
    employeeTaxes: [{ agency: 'IRS Federal', cents: 80000 }, { agency: 'FICA', cents: 38250 }, { agency: 'CA State', cents: 20000 }],
    employerTaxes: [{ agency: 'FICA', cents: 38250 }, { agency: 'Federal FUTA', cents: 4200 }],
    postTaxDeductions: [], benefits: [], departmentId: 'dept-A', jobId: null,
  }],
}));

// Two employees, two departments, one with child-support garnishment
check('two employees + garnishment, two depts', mapReceipt({
  lines: [
    { employeeHandle: 'e1', grossCents: 400000, netCents: 250000,
      employeeTaxes: [{ agency: 'Federal', cents: 60000 }, { agency: 'Medicare', cents: 30000 }],
      employerTaxes: [{ agency: 'FICA', cents: 30000 }],
      postTaxDeductions: [{ kind: 'Child Support', agency: 'IA CSRU', cents: 60000 }], benefits: [], departmentId: 'dept-A', jobId: null },
    { employeeHandle: 'e2', grossCents: 300000, netCents: 222000,
      employeeTaxes: [{ agency: 'Federal', cents: 48000 }, { agency: 'SS', cents: 18600 }],
      employerTaxes: [{ agency: 'SS', cents: 18600 }],
      postTaxDeductions: [{ kind: '401k loan', agency: null, cents: 11400 }], benefits: [], departmentId: 'dept-B', jobId: null },
  ],
}));

// Employer benefit contributions (health + 401k match): expense + payable, stays balanced
check('employer benefits (health + 401k match)', mapReceipt({
  lines: [{
    employeeHandle: 'e1', grossCents: 600000, netCents: 432000,
    employeeTaxes: [{ agency: 'Federal', cents: 96000 }, { agency: 'FICA', cents: 45000 }, { agency: 'State', cents: 27000 }],
    employerTaxes: [{ agency: 'FICA', cents: 45000 }],
    postTaxDeductions: [],
    benefits: [{ kind: 'Employer Health', cents: 40000 }, { kind: '401k Match', cents: 18000 }],
    departmentId: 'dept-A', jobId: null,
  }],
}));

// Reconciliation guard catches a bad line
console.log('Reconciliation guard:');
try {
  mapReceipt({ lines: [{ employeeHandle: 'bad', grossCents: 100000, netCents: 90000, employeeTaxes: [{ agency: 'Federal', cents: 5000 }], employerTaxes: [], postTaxDeductions: [], benefits: [], departmentId: null, jobId: null }] });
  fail++; console.log('  \u2717 guard did NOT catch unbalanced receipt');
} catch { pass++; console.log('  \u2713 guard caught net+withholdings != gross'); }

// Unmapped deduction throws
try {
  classifyDeduction('union dues');
  fail++; console.log('  \u2717 unmapped deduction did NOT throw');
} catch { pass++; console.log('  \u2713 unmapped deduction throws (refuses to guess)'); }

console.log(`\n${pass} pass / ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);
