/**
 * Seed 25 realistic bank transactions for Swan Creek Construction.
 *
 * Run with: npx tsx seed/seed-bank-transactions.ts
 *
 * Prerequisites: Run seed/index.ts first to create org, locations, and accounts.
 *
 * Distribution: 10 PENDING, 8 CATEGORIZED, 4 FLAGGED, 3 APPROVED
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

interface TxnDef {
  date: string;
  desc: string;
  cents: number;
  status: string;
  vendor: string | null;
  acct: string | null;
  conf: number;
  match: string | null;
  reasoning: string;
}

async function main() {
  console.log('🏦 Seeding bank transactions for Swan Creek Construction...\n');

  // Look up org
  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('slug', 'merit-mgmt')
    .single();

  if (!org) throw new Error('Organization not found. Run seed/index.ts first.');
  const orgId = org.id;

  // Look up Swan Creek Construction location
  const { data: scc } = await supabase
    .from('locations')
    .select('id')
    .eq('org_id', orgId)
    .eq('short_code', 'SCC')
    .single();

  if (!scc) throw new Error('Swan Creek Construction not found.');
  const locationId = scc.id;

  // Look up GL accounts by number
  const accountNumbers = [
    '1000', // Operating Checking (cash)
    '1100', // Accounts Receivable
    '5100', // Materials
    '5110', // Equipment Costs
    '5120', // Supplies
    '5130', // Freight & Delivery
    '5200', // Permits & Licenses
    '6000', // Salaries & Wages
    '6110', // Utilities
    '6200', // Fuel
    '6210', // Vehicle Maintenance
    '6300', // Software Subscriptions
    '6520', // Meals & Entertainment
    '6600', // Office Supplies
    '6630', // Bank Fees
    '6700', // General Liability Insurance
  ];

  const { data: accounts } = await supabase
    .from('accounts')
    .select('id, account_number')
    .eq('org_id', orgId)
    .in('account_number', accountNumbers);

  if (!accounts || accounts.length === 0) throw new Error('Accounts not found.');

  const acctMap: Record<string, string> = {};
  for (const a of accounts) {
    acctMap[a.account_number] = a.id;
  }

  // Create or find bank account for SCC
  console.log('  Creating bank account...');
  let bankAccountId: string;

  const { data: existingBank } = await supabase
    .from('bank_accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .eq('account_id', acctMap['1000'])
    .maybeSingle();

  if (existingBank) {
    bankAccountId = existingBank.id;
    console.log(`    ✓ Using existing bank account ${bankAccountId}`);
  } else {
    const { data: bankAcct, error: bankErr } = await supabase
      .from('bank_accounts')
      .insert({
        org_id: orgId,
        location_id: locationId,
        account_id: acctMap['1000'],
        institution_name: 'Hills Bank & Trust',
        account_name: 'Swan Creek Operating',
        account_mask: '4892',
        account_type: 'CHECKING',
        current_balance_cents: 28743216, // $287,432.16
        available_balance_cents: 28543216,
        balance_updated_at: new Date().toISOString(),
        is_active: true,
      })
      .select()
      .single();

    if (bankErr || !bankAcct) throw new Error(`Failed to create bank account: ${bankErr?.message}`);
    bankAccountId = bankAcct.id;
    console.log(`    ✓ Created bank account ${bankAccountId}`);
  }

  // Create vendors
  console.log('  Creating vendors...');
  const vendorDefs = [
    { name: 'Menards', display_name: 'Menards - Ames', default_account: '5100', auto_approve: true, ai_confidence: 0.94 },
    { name: 'Ferguson Enterprises', display_name: 'Ferguson', default_account: '5100', auto_approve: true, ai_confidence: 0.96 },
    { name: 'Carrier Corporation', display_name: 'Carrier', default_account: '5110', auto_approve: false, ai_confidence: 0.92 },
    { name: 'Lennox International', display_name: 'Lennox', default_account: '5100', auto_approve: false, ai_confidence: 0.90 },
    { name: 'Home Depot Pro', display_name: 'Home Depot #2847', default_account: '5120', auto_approve: true, ai_confidence: 0.95 },
    { name: 'Grainger', display_name: 'W.W. Grainger', default_account: '5120', auto_approve: true, ai_confidence: 0.97 },
    { name: 'Casey\'s General Store', display_name: 'Casey\'s', default_account: '6200', auto_approve: true, ai_confidence: 0.93 },
    { name: 'ADP', display_name: 'ADP Payroll', default_account: '6000', auto_approve: true, ai_confidence: 0.99 },
    { name: 'MidAmerican Energy', display_name: 'MidAmerican', default_account: '6110', auto_approve: true, ai_confidence: 0.98 },
    { name: 'O\'Reilly Auto Parts', display_name: 'O\'Reilly', default_account: '6210', auto_approve: true, ai_confidence: 0.91 },
    { name: 'Johnstone Supply', display_name: 'Johnstone', default_account: '5100', auto_approve: false, ai_confidence: 0.88 },
    { name: 'Microsoft', display_name: 'Microsoft 365', default_account: '6300', auto_approve: true, ai_confidence: 0.99 },
    { name: 'Ames Rental Center', display_name: 'Ames Rental', default_account: '5110', auto_approve: false, ai_confidence: 0.78 },
    { name: 'Iowa Ready Mix', display_name: 'Iowa Ready Mix', default_account: '5100', auto_approve: false, ai_confidence: 0.85 },
  ];

  const vendorMap: Record<string, string> = {};
  for (const v of vendorDefs) {
    // Check if vendor already exists
    const { data: existing } = await supabase
      .from('vendors')
      .select('id')
      .eq('org_id', orgId)
      .eq('name', v.name)
      .maybeSingle();

    if (existing) {
      vendorMap[v.name] = existing.id;
      continue;
    }

    const { data: vendor, error } = await supabase
      .from('vendors')
      .insert({
        org_id: orgId,
        name: v.name,
        display_name: v.display_name,
        default_account_id: acctMap[v.default_account],
        auto_approve: v.auto_approve,
        ai_confidence: v.ai_confidence,
        transaction_count: Math.floor(Math.random() * 40) + 5,
        ytd_spend_cents: Math.floor(Math.random() * 5000000) + 100000,
        payment_terms_days: 30,
      })
      .select()
      .single();

    if (error) throw error;
    if (vendor) vendorMap[v.name] = vendor.id;
  }
  console.log(`    ✓ ${Object.keys(vendorMap).length} vendors`);

  // Delete any existing bank transactions for this location to avoid duplicates
  console.log('  Clearing existing transactions...');
  const { error: delErr } = await supabase
    .from('bank_transactions')
    .delete()
    .eq('org_id', orgId)
    .eq('location_id', locationId);

  if (delErr) console.warn(`    ⚠ Could not clear: ${delErr.message}`);

  // 25 transactions: 10 PENDING, 8 CATEGORIZED, 4 FLAGGED, 3 APPROVED
  console.log('  Creating 25 bank transactions...');
  const transactions: TxnDef[] = [
    // ─── PENDING (10) — AI has suggested but human hasn't reviewed ───
    { date: '2026-04-04', desc: 'POS Purchase - Menards #3284 Ames IA', cents: -34218, status: 'PENDING', vendor: 'Menards', acct: '5100', conf: 0.94, match: 'VENDOR_PATTERN',
      reasoning: 'Matched vendor "Menards" from prior transactions. Description pattern "POS Purchase - Menards" seen 14 times. Suggested 5100 Materials based on 92% historical usage for this vendor.' },
    { date: '2026-04-04', desc: 'ACH Payment - Ferguson Supply Inv 84721', cents: -287500, status: 'PENDING', vendor: 'Ferguson Enterprises', acct: '5100', conf: 0.96, match: 'BILL_PAYMENT',
      reasoning: 'Matched to open bill INV-84721 from Ferguson Enterprises ($2,875.00). Amount matches exactly. Bill dated 2026-03-20, due 2026-04-19.' },
    { date: '2026-04-03', desc: 'CARRIER GLOBAL PMT 20260403 EQUIP', cents: -824000, status: 'PENDING', vendor: 'Carrier Corporation', acct: '5110', conf: 0.87, match: 'VENDOR_PATTERN',
      reasoning: 'Matched vendor "Carrier" with 87% confidence. Large equipment purchase. Suggested 5110 Equipment Costs. Amount $8,240 exceeds auto-approve threshold ($10,000 limit).' },
    { date: '2026-04-03', desc: 'JOHNSTONE SUPPLY DM 44127 PARTS', cents: -15620, status: 'PENDING', vendor: 'Johnstone Supply', acct: '5100', conf: 0.82, match: 'VENDOR_PATTERN',
      reasoning: 'Vendor pattern match for Johnstone Supply. HVAC parts purchase. Suggested 5100 Materials. Confidence slightly below threshold due to new store location (DM vs Ames).' },
    { date: '2026-04-03', desc: 'ACH Payment - Iowa Ready Mix Inv 3381', cents: -156200, status: 'PENDING', vendor: 'Iowa Ready Mix', acct: '5100', conf: 0.78, match: 'BILL_PAYMENT',
      reasoning: 'Possible bill match to Iowa Ready Mix invoice 3381 ($1,562.00). Vendor seen 3 times previously. Lower confidence due to limited transaction history.' },
    { date: '2026-04-02', desc: 'HOME DEPOT PRO 2847 ANKENY IA', cents: -4712, status: 'PENDING', vendor: 'Home Depot Pro', acct: '5120', conf: 0.95, match: 'VENDOR_PATTERN',
      reasoning: 'Strong vendor match for Home Depot Pro #2847. Small supplies purchase. Suggested 5120 Supplies based on 95% of prior Home Depot transactions under $500.' },
    { date: '2026-04-02', desc: 'CASEYS 2217 JOHNSTON IA FUEL', cents: -6518, status: 'PENDING', vendor: 'Casey\'s General Store', acct: '6200', conf: 0.93, match: 'VENDOR_PATTERN',
      reasoning: 'Casey\'s General Store fuel purchase. All prior Casey\'s transactions coded to 6200 Fuel. High confidence pattern match.' },
    { date: '2026-04-01', desc: 'MENARDS ANKENY IA #2190 LUMBER', cents: -127843, status: 'PENDING', vendor: 'Menards', acct: '5100', conf: 0.88, match: 'VENDOR_PATTERN',
      reasoning: 'Menards vendor match. $1,278.43 lumber purchase. Suggested 5100 Materials. Slightly lower confidence — different store (#2190 vs usual #3284).' },
    { date: '2026-04-01', desc: 'GRAINGER 892341 SAFETY EQUIP', cents: -34150, status: 'PENDING', vendor: 'Grainger', acct: '5120', conf: 0.84, match: 'RECEIPT',
      reasoning: 'Matched to uploaded receipt from Grainger dated 2026-03-31 for $341.50. Safety equipment purchase. Receipt shows hard hats and safety vests.' },
    { date: '2026-03-31', desc: 'AMES RENTAL CTR MINI EXCAVATOR 3DAY', cents: -185000, status: 'PENDING', vendor: 'Ames Rental Center', acct: '5110', conf: 0.72, match: 'VENDOR_PATTERN',
      reasoning: 'Possible match to Ames Rental Center. Equipment rental ($1,850). Limited history — only 2 prior transactions. Suggested 5110 Equipment Costs.' },

    // ─── CATEGORIZED (8) — AI categorized with high confidence ───
    { date: '2026-04-02', desc: 'ADP PAYROLL TAXES ACH 04022026', cents: -1248700, status: 'CATEGORIZED', vendor: 'ADP', acct: '6000', conf: 0.99, match: 'VENDOR_PATTERN',
      reasoning: 'ADP payroll run. Biweekly payroll of $12,487.00 matches expected range. Auto-categorized to 6000 Salaries & Wages. 47 prior ADP transactions all coded identically.' },
    { date: '2026-04-02', desc: 'MIDAMERICAN ENERGY PYMT ACH UTIL', cents: -42315, status: 'CATEGORIZED', vendor: 'MidAmerican Energy', acct: '6110', conf: 0.98, match: 'VENDOR_PATTERN',
      reasoning: 'MidAmerican Energy utility payment. $423.15 within normal range ($380-$520). All prior utility payments coded to 6110.' },
    { date: '2026-04-02', desc: 'MICROSOFT *365 MSBILL.INFO WA', cents: -5499, status: 'CATEGORIZED', vendor: 'Microsoft', acct: '6300', conf: 0.98, match: 'VENDOR_PATTERN',
      reasoning: 'Recurring Microsoft 365 subscription. $54.99 matches prior months exactly. Auto-categorized to 6300 Software Subscriptions.' },
    { date: '2026-04-01', desc: 'LENNOX IND PMT ACH INV-LX-92847', cents: -445000, status: 'CATEGORIZED', vendor: 'Lennox International', acct: '5100', conf: 0.90, match: 'BILL_PAYMENT',
      reasoning: 'Matched to Lennox bill INV-LX-92847 ($4,450.00). HVAC equipment purchase. Amount matches bill total. Categorized to 5100 Materials.' },
    { date: '2026-04-01', desc: 'OREILLY AUTO 0812 AMES IA PARTS', cents: -23415, status: 'CATEGORIZED', vendor: 'O\'Reilly Auto Parts', acct: '6210', conf: 0.91, match: 'VENDOR_PATTERN',
      reasoning: 'O\'Reilly Auto Parts purchase. Vehicle maintenance parts $234.15. All 8 prior O\'Reilly transactions coded to 6210 Vehicle Maintenance.' },
    { date: '2026-03-31', desc: 'DEPOSIT - JOHNSON RESIDENCE DRAW #3', cents: 4200000, status: 'CATEGORIZED', vendor: null, acct: '1100', conf: 0.91, match: 'NONE',
      reasoning: 'Customer deposit. "JOHNSON RESIDENCE DRAW #3" matches active job J-2026-014. Progress billing draw $42,000. Coded to 1100 Accounts Receivable.' },
    { date: '2026-03-31', desc: 'DEPOSIT - ANKENY SCHL DIST PROG PMT', cents: 8750000, status: 'CATEGORIZED', vendor: null, acct: '1100', conf: 0.88, match: 'NONE',
      reasoning: 'Customer deposit. Ankeny School District progress payment $87,500. Matches open AR invoice INV-2026-0087. Coded to 1100 Accounts Receivable.' },
    { date: '2026-03-28', desc: 'FERGUSON ENT 0441 PIPE FITTINGS', cents: -93250, status: 'CATEGORIZED', vendor: 'Ferguson Enterprises', acct: '5100', conf: 0.96, match: 'VENDOR_PATTERN',
      reasoning: 'Ferguson Enterprises plumbing supplies. $932.50 pipe fittings order. Strong vendor match from 22 prior transactions. Coded to 5100 Materials.' },

    // ─── FLAGGED (4) — Low confidence or unknown vendor ───
    { date: '2026-04-03', desc: 'ACH DEBIT UNKNOWN VENDOR 8847123', cents: -54200, status: 'FLAGGED', vendor: null, acct: null, conf: 0.45, match: 'NONE',
      reasoning: 'Unknown vendor. ACH debit of $542.00 with no matching vendor pattern. No similar transactions in history. Flagged for manual review.' },
    { date: '2026-04-02', desc: 'CHECK #4471 PAID', cents: -350000, status: 'FLAGGED', vendor: null, acct: null, conf: 0.48, match: 'NONE',
      reasoning: 'Manual check payment. $3,500.00 with no payee information from bank feed. Check number 4471 — recommend matching to check register.' },
    { date: '2026-04-01', desc: 'WIRE OUT REF 20260401-SCC-881', cents: -1250000, status: 'FLAGGED', vendor: null, acct: null, conf: 0.52, match: 'NONE',
      reasoning: 'Outgoing wire transfer $12,500.00. Large amount with no vendor match. Wire reference SCC-881. Flagged for controller review due to amount.' },
    { date: '2026-03-31', desc: 'POS PURCHASE DES MOINES IA 0331', cents: -22340, status: 'FLAGGED', vendor: null, acct: '6520', conf: 0.58, match: 'NONE',
      reasoning: 'Generic POS purchase in Des Moines. $223.40 — possibly meals/entertainment. Tentatively suggested 6520 but low confidence. No vendor name in bank description.' },

    // ─── APPROVED (3) — Human-reviewed and approved, pending JE posting ───
    { date: '2026-03-28', desc: 'MENARDS AMES IA #3344 CONCRETE MIX', cents: -18944, status: 'APPROVED', vendor: 'Menards', acct: '5100', conf: 0.94, match: 'VENDOR_PATTERN',
      reasoning: 'Menards purchase. Concrete mix $189.44. Strong vendor pattern match. Approved by controller.' },
    { date: '2026-03-28', desc: 'HOME DEPOT PRO 2847 ANKENY IA TOOLS', cents: -44218, status: 'APPROVED', vendor: 'Home Depot Pro', acct: '5120', conf: 0.95, match: 'RECEIPT',
      reasoning: 'Home Depot Pro tools purchase $442.18. Matched to uploaded receipt showing power drill and bits. Approved by controller.' },
    { date: '2026-03-27', desc: 'ACH DEBIT INS PREM EMC INSURANCE', cents: -287500, status: 'APPROVED', vendor: null, acct: '6700', conf: 0.76, match: 'NONE',
      reasoning: 'Insurance premium payment $2,875.00 to EMC Insurance. Quarterly GL liability premium. Manually categorized to 6700 General Liability Insurance. Approved.' },
  ];

  let created = 0;
  for (const txn of transactions) {
    const { error } = await supabase
      .from('bank_transactions')
      .insert({
        org_id: orgId,
        bank_account_id: bankAccountId,
        location_id: locationId,
        transaction_date: txn.date,
        description: txn.desc,
        amount_cents: txn.cents,
        status: txn.status,
        ai_account_id: txn.acct ? acctMap[txn.acct] ?? null : null,
        ai_vendor_id: txn.vendor ? vendorMap[txn.vendor] ?? null : null,
        ai_confidence: txn.conf,
        ai_reasoning: txn.reasoning,
        ai_model_version: 'claude-sonnet-4-20250514',
        match_type: txn.match,
        match_confidence: txn.match && txn.match !== 'NONE' ? txn.conf : null,
        // Set approved fields for APPROVED status
        ...(txn.status === 'APPROVED' ? {
          final_account_id: txn.acct ? acctMap[txn.acct] ?? null : null,
          final_vendor_id: txn.vendor ? vendorMap[txn.vendor] ?? null : null,
          approved_at: new Date().toISOString(),
        } : {}),
      });

    if (error) {
      console.error(`  ✗ Failed: ${txn.desc}`, error.message);
    } else {
      created++;
    }
  }

  console.log(`    ✓ ${created}/${transactions.length} bank transactions created`);

  // Summary
  const pending = transactions.filter((t) => t.status === 'PENDING').length;
  const categorized = transactions.filter((t) => t.status === 'CATEGORIZED').length;
  const flagged = transactions.filter((t) => t.status === 'FLAGGED').length;
  const approved = transactions.filter((t) => t.status === 'APPROVED').length;
  console.log(`    Distribution: ${pending} PENDING, ${categorized} CATEGORIZED, ${flagged} FLAGGED, ${approved} APPROVED`);

  console.log('\n✅ Bank transaction seed complete!\n');
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
