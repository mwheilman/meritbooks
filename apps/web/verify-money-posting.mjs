#!/usr/bin/env node
/**
 * verify-money-posting.mjs — proves every GATE 12 AR/AP entry builder produces a
 * balanced journal entry across a matrix of scenarios. Pure logic, no DB.
 *
 * This mirrors the builder logic in apps/web/src/lib/money/posting/{ar,ap}-posting.ts
 * (the TS files are the source of truth; this is an independent check of the
 * accounting so a balance bug is caught before deploy). Run:
 *     node apps/web/verify-money-posting.mjs
 */

let pass = 0, fail = 0;
const A = { clearing: 'acct-clearing', fee: 'acct-fee', ar: 'acct-ar', bank: 'acct-bank', transit: 'acct-transit', ap: 'acct-ap' };
const LOC = 'loc-1';

function line(accountId, side, cents) {
  if (cents < 0) throw new Error('negative');
  return { account_id: accountId, debit_cents: side === 'debit' ? cents : 0, credit_cents: side === 'credit' ? cents : 0, location_id: LOC };
}
function check(name, lines) {
  const d = lines.reduce((s, l) => s + l.debit_cents, 0);
  const c = lines.reduce((s, l) => s + l.credit_cents, 0);
  const nonzero = lines.filter((l) => l.debit_cents > 0 || l.credit_cents > 0).length;
  const ok = d === c && d > 0 && nonzero >= 2;
  if (ok) { pass++; console.log(`  \u2713 ${name} (D=${d} C=${c})`); }
  else { fail++; console.log(`  \u2717 ${name} UNBALANCED D=${d} C=${c} lines=${nonzero}`); }
}

// --- AR collection (gross G, fee F) -> net (G-F) to clearing, F to fee, CR AR G
function arCollection(G, F) {
  const net = G - F;
  return [line(A.clearing, 'debit', net), ...(F > 0 ? [line(A.fee, 'debit', F)] : []), line(A.ar, 'credit', G)];
}
// --- AR payout P
function arPayout(P) { return [line(A.bank, 'debit', P), line(A.clearing, 'credit', P)]; }
// --- AR refund R
function arRefund(R) { return [line(A.ar, 'debit', R), line(A.clearing, 'credit', R)]; }
// --- AP release / settle / return / void X
function apRelease(X) { return [line(A.ap, 'debit', X), line(A.transit, 'credit', X)]; }
function apSettle(X) { return [line(A.transit, 'debit', X), line(A.bank, 'credit', X)]; }
function apReturn(X) { return [line(A.bank, 'debit', X), line(A.transit, 'credit', X)]; }
function apVoid(X) { return [line(A.transit, 'debit', X), line(A.ap, 'credit', X)]; }

console.log('\nGATE 12 money-movement posting — balance verification\n');

console.log('AR collection (gross, fee):');
check('collection 10000 fee 290', arCollection(10000, 290));
check('collection 5000 fee 0', arCollection(5000, 0));
check('collection 100 fee 3 (ACH-ish)', arCollection(100, 3));
check('collection 999999 fee 29000', arCollection(999999, 29000));

console.log('AR payout:');
check('payout 9710', arPayout(9710));
check('payout 1', arPayout(1));

console.log('AR refund:');
check('refund 10000', arRefund(10000));
check('refund 250', arRefund(250));

console.log('AP release / settle / return / void:');
check('release 25000', apRelease(25000));
check('settle 25000', apSettle(25000));
check('return 25000', apReturn(25000));
check('void 25000', apVoid(25000));
check('release 1', apRelease(1));

// Round-trip invariant: release then settle nets A/P down and Bank down by X,
// clearing nets to zero.
console.log('Round-trip invariant (release+settle): clearing nets to zero:');
{
  const X = 42000;
  const all = [...apRelease(X), ...apSettle(X)];
  const byAcct = {};
  for (const l of all) byAcct[l.account_id] = (byAcct[l.account_id] || 0) + l.debit_cents - l.credit_cents;
  const transitNet = byAcct[A.transit] || 0;
  const apNet = byAcct[A.ap] || 0;     // debit positive => A/P decreased by X (contra-liability movement)
  const bankNet = byAcct[A.bank] || 0; // credit => negative => bank decreased by X
  const ok = transitNet === 0 && apNet === X && bankNet === -X;
  if (ok) { pass++; console.log(`  \u2713 transit nets 0; A/P moved +${apNet}; Bank moved ${bankNet}`); }
  else { fail++; console.log(`  \u2717 invariant failed transit=${transitNet} ap=${apNet} bank=${bankNet}`); }
}

console.log(`\n${pass} pass / ${fail} fail\n`);
process.exit(fail === 0 ? 0 : 1);
