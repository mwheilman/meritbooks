/** [SANDBOX] Northwind Construction — commercial_gc demo data. */
import {
  type EstLine, type Party, R, budget, changeOrder, commitment, dailyLogs, estTotal, estimate, job, site, tasks, timeEntries, tr, usd,
} from './lib';

export const customers: Party[] = [
  { v: 'v_c_riverside', name: 'Demo — Riverside Dental Group', email: 'facilities@riverside-dental.example', phone: '515-555-0141', first: 'Dana', last: 'Whitcomb' },
  { v: 'v_c_amesccu', name: 'Demo — Ames Community Credit Union', email: 'facilities@ames-ccu.example', phone: '515-555-0152', first: 'Greg', last: 'Halvorsen' },
  { v: 'v_c_prairievet', name: 'Demo — Prairie Ridge Veterinary Clinic', email: 'office@prairieridgevet.example', phone: '515-555-0163', first: 'Jenna', last: 'Ostrander' },
  { v: 'v_c_library', name: 'Demo — Story County Library Board', email: 'director@storycountylibrary.example', phone: '515-555-0174', first: 'Paul', last: 'Lindquist' },
  { v: 'v_c_ankenymed', name: 'Demo — Ankeny Medical Partners', email: 'realestate@ankenymed.example', phone: '515-555-0185', first: 'Priya', last: 'Raman' },
];

export const vendors: Party[] = [
  { v: 'v_v_hawkeye', name: 'Demo — Hawkeye Drywall & Acoustics', email: 'estimating@hawkeyedrywall.example', phone: '515-555-0211', kind: 'SUBCONTRACTOR' },
  { v: 'v_v_raccoon', name: 'Demo — Raccoon River Electric', email: 'bids@raccoonriverelectric.example', phone: '515-555-0222', kind: 'SUBCONTRACTOR' },
  { v: 'v_v_capmech', name: 'Demo — Capitol Mechanical', email: 'service@capitolmech.example', phone: '515-555-0233', kind: 'SUBCONTRACTOR' },
  { v: 'v_v_dmdoor', name: 'Demo — Des Moines Door & Hardware', email: 'orders@dmdoor.example', phone: '515-555-0244', kind: 'SUPPLIER' },
];

export const setup = `
  if not exists (select 1 from pm.labor_settings s where s.location_id = c_loc) then
    perform pm.set_labor_settings(c_loc, 0.32, 0.18, 'Demo: payroll burden (FICA, FUTA/SUTA, workers comp, health) and estimating overhead');
  end if;
  select c.id into v_card from pm.labor_rate_cards c where c.location_id = c_loc and c.key = 'carpenter';
  if v_card is null then
    v_card := pm.save_labor_rate_card(c_loc, 'carpenter', 'Carpenter (self-perform)', 3400, null, null, 7200, null);
  end if;
  select c.id into v_card2 from pm.labor_rate_cards c where c.location_id = c_loc and c.key = 'superintendent';
  if v_card2 is null then
    v_card2 := pm.save_labor_rate_card(c_loc, 'superintendent', 'Superintendent', 4600, null, null, 9800, null);
  end if;
  if v_tech <> v_admin_emp and not exists (select 1 from pm.employee_rate_cards e where e.employee_id = v_tech and e.location_id = c_loc) then
    perform pm.set_employee_rate_card(v_tech, c_loc, v_card);
  end if;`;

// ---- TI bid: [code, description, cost $, price $, pct complete on pay app #1, stored materials $]
const tiLines: [string, string, number, number, number, number][] = [
  ['01 31 00', 'Project management and general conditions', 28_500, 34_200, 0.45, 0],
  ['01 50 00', 'Temporary facilities, protection and dust control', 6_200, 7_400, 0.6, 0],
  ['02 41 00', 'Selective demolition (former retail suite)', 18_400, 22_100, 1, 0],
  ['06 10 00', 'Rough carpentry and in-wall blocking (self-perform)', 9_800, 11_900, 0.8, 0],
  ['08 11 00', 'Hollow-metal frames, wood doors and hardware', 31_600, 37_800, 0.1, 12_400],
  ['09 21 16', 'Metal stud framing and gypsum board', 72_500, 86_900, 0.65, 0],
  ['09 51 00', 'Acoustical ceilings', 19_300, 23_200, 0, 0],
  ['09 65 00', 'Resilient flooring and rubber base', 16_900, 20_300, 0, 0],
  ['09 91 00', 'Painting and wall protection', 11_200, 13_500, 0, 0],
  ['22 00 00', 'Plumbing incl. dental vacuum and compressed air', 54_800, 65_400, 0.55, 0],
  ['23 00 00', 'HVAC: RTU tie-in, VAV boxes and ductwork', 61_900, 73_800, 0.5, 0],
  ['26 00 00', 'Electrical, lighting and low voltage', 58_700, 70_100, 0.5, 0],
  ['01 21 16', 'Contingency (owner-controlled)', 16_000, 19_900, 0, 0],
];
const tiEst: EstLine[] = tiLines.map(([code, d, cost, price]) => ({ code, d, qty: 1, uom: 'LS', cost: usd(cost), price: usd(price) }));

const libraryEst: EstLine[] = [
  { code: '01 50 00', d: 'Temporary facilities, roof protection and hoisting', qty: 1, uom: 'LS', cost: usd(9_400), price: usd(11_800) },
  { code: '02 41 00', d: 'Tear off existing built-up roof to deck', qty: 1, uom: 'LS', cost: usd(38_600), price: usd(46_900) },
  { code: '07 21 00', d: 'Tapered polyiso insulation, R-30 average', qty: 1, uom: 'LS', cost: usd(52_300), price: usd(63_500) },
  { code: '07 50 00', d: '60-mil TPO membrane, fully adhered (24,800 SF)', qty: 1, uom: 'LS', cost: usd(148_900), price: usd(179_600) },
  { code: '23 00 00', d: 'Replace (3) RTUs with curb adapters, crane pick', qty: 1, uom: 'LS', cost: usd(186_400), price: usd(224_800) },
  { code: '26 00 00', d: 'RTU disconnects and controls wiring', qty: 1, uom: 'LS', cost: usd(21_700), price: usd(26_300) },
  { code: '01 41 00', d: 'Building permit (City of Ames)', qty: 1, uom: 'LS', cost: usd(4_200), price: usd(4_200) },
];

export const jobs = [
  job('nwc-ti-riverside-dental', 'REAL — TI mid-construction, Pay Application #1 drafted for the 25th', `
    v_job := pm.create_project(c_loc, 'tenant_improvement', 'Riverside Dental Group — Suite 140 tenant improvement', v_c_riverside, null, false,
      jsonb_build_object('_demo', v_key, 'market_sector', 'healthcare', 'building_sf', 6850, 'permit_number', 'BLD-2026-04417',
                         'architect', 'Slate Line Architecture (demo)', 'prevailing_wage', false, 'customer_reference', 'RDG PO 2026-118'));
${site({ line1: '4110 NW Urbandale Dr, Suite 140', city: 'Urbandale', zip: '50322', start: -38, finish: 41 })}
${estimate({ title: 'Base bid — Suite 140 dental TI (drawings A1.0–A6.2 rev 2)', retainage: 0.1, valid: 'current_date - 30',
    notes: 'Excludes dental equipment and casework (by owner). Retainage 10% per AIA A101.', lines: tiEst })}
    perform pm.send_estimate(v_est);
    v_j := pm.accept_estimate(v_est);      -- ORIGINAL budget by cost code + PRIME contract ${estTotal(tiEst)} cents at 10% retainage
${tr('awarded', 'preconstruction')}
    -- subcontracts + PO (DRAFT: approval needs a second person, preparer != approver)
${commitment({ type: 'SUBCONTRACT', vendor: 'v_v_hawkeye', title: 'Framing, drywall and acoustical ceilings', retainage: 0.1,
    desc: 'Per Section 09 21 16 and 09 51 00; includes in-wall blocking coordination with Northwind carpentry.',
    lines: [['09 21 16', 'Metal stud framing, gypsum board, level 4 finish', 68_900], ['09 51 00', 'ACT grid and 2x2 tile, operatory clean-room tile', 18_400]] })}
    insert into pm.compliance_docs (commitment_id, doc_type, status, required, notes)
      values (v_cmt, 'COI', 'RECEIVED', true, 'ACORD 25: GL $1M/$2M, auto $1M, umbrella $5M; Northwind and owner additional insured')
      returning id into v_doc;
    perform pm.verify_compliance_doc(v_doc, current_date + 12);          -- expiring soon
    insert into pm.compliance_docs (commitment_id, doc_type, status, required, covers_through, amount_cents, notes)
      values (v_cmt, 'LIEN_WAIVER_CONDITIONAL', 'RECEIVED', true, current_date - 25, 0, 'Conditional waiver, mobilization')
      returning id into v_doc;
    perform pm.verify_compliance_doc(v_doc, null);
${commitment({ type: 'SUBCONTRACT', vendor: 'v_v_raccoon', title: 'Electrical, lighting and low voltage', retainage: 0.1,
    lines: [['26 00 00', 'Power, lighting, fire alarm devices, data rough-in per E-series', 55_800]] })}
    v_cmt2 := v_cmt;
    insert into pm.compliance_docs (commitment_id, doc_type, status, required, notes)
      values (v_cmt2, 'COI', 'RECEIVED', true, 'ACORD 25 on file; renews in spring') returning id into v_doc;
    perform pm.verify_compliance_doc(v_doc, current_date + 214);
${commitment({ type: 'PO', vendor: 'v_v_dmdoor', title: 'Doors, frames and hardware (submittal approved)', retainage: 0,
    lines: [['08 11 00', '(14) HM frames, (14) solid-core birch doors, hardware sets HW-1 to HW-4', 27_950]] })}
${tr('construction')}
    -- a waiver still owed for Pay App #1
    insert into pm.compliance_docs (commitment_id, doc_type, status, required, notes)
      values (v_cmt2, 'LIEN_WAIVER_CONDITIONAL', 'MISSING', true, 'Needed with Pay Application #1');
    -- schedule of values (lines = the accepted bid) + Pay Application #1
    insert into pm.sov_versions (job_id, contract_id, memo)
      values (v_job, (v_j ->> 'contract_id')::uuid, 'Original schedule of values per executed AIA A101/A201') returning id into v_sov;
    insert into pm.sov_lines (sov_version_id, line_no, cost_code_id, description, scheduled_value_cents, sort)
    select v_sov, l.line_no, l.cost_code_id, l.description, l.amount_cents, l.sort from pm.estimate_lines l where l.estimate_id = v_est;
    perform pm.activate_sov_version(v_sov);
    v_bill := pm.generate_sov_billing(v_job, v_sov, v_period_end, (
      select jsonb_agg(jsonb_build_object('sov_line_id', s.id, 'pct_complete', x.pct, 'stored_materials_cents', x.stored) order by s.line_no)
        from pm.sov_lines s
        join (values ${tiLines.map(([, , , , pct, stored], i) => `(${i + 1}, ${pct}, ${usd(stored)})`).join(', ')}) x(n, pct, stored) on x.n = s.line_no
       where s.sov_version_id = v_sov));
    perform pm.set_progress(v_job, 0.42);
${changeOrder({ title: 'Add (2) sterilization-room sinks (RFI-014)', desc: 'Owner requested a second sink at sterilization and a hand sink at lab; adds 2 fixtures, waste/vent, and casework cutouts.',
    reason: 'OWNER_REQUEST', amount: 8_640, cost: 6_900, days: 2 })}
${changeOrder({ title: 'Upgrade corridor doors to 20-minute rated (plan review comment)', desc: 'City of Urbandale plan review requires 20-min rated corridor doors with closers at 6 openings.',
    reason: 'CODE', amount: 14_250, cost: 11_800, days: 0, cor: true })}
${tasks([
    { t: 'Mobilize and protect common areas', s: -38, d: -36, st: 'DONE' },
    { t: 'Selective demolition', s: -36, d: -28, st: 'DONE' },
    { t: 'Layout and in-wall blocking', s: -27, d: -18, st: 'DONE', who: 'tech' },
    { t: 'MEP rough-in (plumbing, med air/vac, HVAC, electrical)', s: -22, d: 3, st: 'IN_PROGRESS', pct: 0.8 },
    { t: 'Framing and drywall', s: -20, d: 6, st: 'IN_PROGRESS', pct: 0.65 },
    { t: 'Above-ceiling inspection (City of Urbandale)', s: 7, d: 7, st: 'TODO', ms: true },
    { t: 'Ceiling grid and tile', s: 8, d: 15, st: 'TODO' },
    { t: 'Paint, resilient flooring and base', s: 14, d: 25, st: 'TODO' },
    { t: 'Owner dental equipment set (coordinate with vendor)', s: 26, d: 30, st: 'TODO' },
    { t: 'Punch list and closeout', s: 33, d: 41, st: 'TODO' },
    { t: 'Submit Pay Application #1 with conditional waivers', s: R('(v_period_end - current_date - 4)'), d: R('(v_period_end - current_date)'), st: 'TODO', who: 'admin' },
  ])}
${dailyLogs([
    { body: 'Hawkeye hanging board in operatories 1–4; Capitol Mechanical setting VAV boxes; med-gas rough inspection passed.', wx: 'Partly cloudy', hi: 58, lo: 41, crew: 14 },
    { body: 'Electrical rough-in at front desk and sterilization; plumbing roughed dental vacuum line; framing punch at lab.', wx: 'Sunny', hi: 63, lo: 44, crew: 13 },
    { body: 'Door frames delivered and stored in Suite 140 storage (12 of 14); blocking complete at operatories.', wx: 'Light rain', hi: 52, lo: 45, crew: 11 },
    { body: 'Ductwork mains installed; RTU curb tie-in scheduled; RFI-014 (second sink) issued to architect.', wx: 'Overcast', hi: 55, lo: 39, crew: 12 },
    { body: 'Framing inspection passed; insulation in demising wall; owner walk with Dr. Whitcomb.', wx: 'Sunny, windy', hi: 61, lo: 40, crew: 10 },
  ])}
${timeEntries([
    { day: -2, hours: 8, code: '06 10 00', notes: 'In-wall blocking for operatory chairs and wall cabinets' },
    { day: -1, hours: 8, code: '06 10 00', notes: 'Blocking at lab and sterilization; door frame layout' },
    { day: -1, hours: 1.5, pay: 'OT', code: '06 10 00', notes: 'Stayed to receive door frame delivery' },
  ])}`),

  job('nwc-precon-ames-ccu', 'REAL — preconstruction (bond in, builder\'s risk missing)', `
    v_job := pm.create_project(c_loc, 'lump_sum', 'Ames Community Credit Union — South Duff branch (ground-up)', v_c_amesccu, null, false,
      jsonb_build_object('_demo', v_key, 'market_sector', 'retail', 'building_sf', 4200, 'architect', 'Prairie Forge Design (demo)', 'prevailing_wage', false));
${site({ line1: '3020 S Duff Ave', city: 'Ames', zip: '50010', start: 21, finish: 230 })}
${budget('Original budget (bid day)', [
    ['01 31 00', 'Project management', 96_000], ['01 31 13', 'Field supervision', 118_000], ['01 50 00', 'Temporary facilities', 42_000],
    ['01 41 00', 'Permits and fees', 18_500], ['03 30 00', 'Foundations and slab on grade', 214_000], ['04 20 00', 'Brick and CMU veneer', 168_000],
    ['05 12 00', 'Structural steel and canopy framing', 142_000], ['06 10 00', 'Rough carpentry', 38_000], ['07 50 00', 'Membrane roofing', 96_000],
    ['08 80 00', 'Storefront and drive-up glazing', 128_000], ['09 21 16', 'Drywall', 84_000], ['09 51 00', 'Acoustical ceilings', 31_000],
    ['09 68 00', 'Carpet tile', 22_000], ['22 00 00', 'Plumbing', 88_000], ['23 00 00', 'HVAC', 176_000],
    ['26 00 00', 'Electrical incl. security and ATM power', 192_000], ['31 00 00', 'Earthwork', 74_000], ['32 00 00', 'Paving, curbs and landscaping', 112_000],
    ['01 21 16', 'Contingency', 55_000],
  ])}
    perform pm.set_contract(v_job, ${usd(2_184_000)});
${tr('awarded', 'preconstruction')}
    insert into pm.compliance_docs (job_id, doc_type, status, required, amount_cents, notes)
      values (v_job, 'OTHER', 'RECEIVED', true, ${usd(2_184_000)}, 'Payment and performance bonds (AIA A312) — originals received'),
             (v_job, 'OTHER', 'MISSING', true, null, 'Builder''s risk certificate — required before mobilization');
${tasks([
    { t: 'Preconstruction meeting with owner and architect', s: -6, d: -6, st: 'DONE', who: 'admin' },
    { t: 'Issue subcontracts: sitework, concrete, steel', s: -4, d: 5, st: 'IN_PROGRESS', pct: 0.4, who: 'admin' },
    { t: 'Submittals: steel, storefront, RTUs', s: -2, d: 12, st: 'IN_PROGRESS', pct: 0.2 },
    { t: 'Building permit (City of Ames)', s: -10, d: 9, st: 'IN_PROGRESS', pct: 0.7 },
    { t: 'Builder\'s risk certificate from owner', s: -3, d: 4, st: 'BLOCKED' },
    { t: 'Notice to proceed', s: 18, d: 18, st: 'TODO', ms: true },
    { t: 'Mobilize, erosion control, mass grading', s: 21, d: 35, st: 'TODO' },
  ])}`),

  job('nwc-closeout-prairie-ridge-vet', 'REAL — closeout, final billing drafted', `
    v_job := pm.create_project(c_loc, 'tenant_improvement', 'Prairie Ridge Veterinary Clinic — exam wing remodel', v_c_prairievet, null, false,
      jsonb_build_object('_demo', v_key, 'market_sector', 'healthcare', 'building_sf', 3100, 'permit_number', 'BLD-2026-01882'));
${site({ line1: '8805 Hickman Rd', city: 'Clive', zip: '50325', start: -126, finish: -9 })}
${budget('Original budget', [
    ['01 31 00', 'Project management', 18_000], ['01 31 13', 'Field supervision', 22_000], ['02 41 00', 'Selective demolition', 14_500],
    ['06 40 00', 'Exam room casework', 31_000], ['08 11 00', 'Doors, frames and hardware', 19_800], ['09 21 16', 'Framing and drywall', 44_000],
    ['09 51 00', 'Acoustical ceilings', 12_600], ['09 65 00', 'Seamless resilient flooring', 21_400], ['09 91 00', 'Painting', 9_800],
    ['22 00 00', 'Plumbing (exam sinks, tub table)', 38_500], ['23 00 00', 'HVAC (exhaust, kennel air changes)', 29_800], ['26 00 00', 'Electrical', 34_600],
  ])}
    perform pm.set_contract(v_job, ${usd(338_600)});
    insert into pm.compliance_docs (job_id, vendor_id, doc_type, status, required, notes)
      values (v_job, v_v_capmech, 'COI', 'RECEIVED', true, 'Capitol Mechanical — ACORD 25') returning id into v_doc;
    perform pm.verify_compliance_doc(v_doc, current_date + 150);
${tr('awarded', 'preconstruction', 'construction', 'substantial_completion')}
    insert into pm.punch_items (job_id, kind, title, area, status, due_on, closed_at, responsible_vendor_id)
    values (v_job, 'PUNCH', 'Touch-up paint at exam 3 door frame', 'Exam 3', 'CLOSED', current_date - 16, now() - interval '14 days', null),
           (v_job, 'PUNCH', 'Adjust closer at treatment room door', 'Treatment', 'CLOSED', current_date - 16, now() - interval '13 days', null),
           (v_job, 'PUNCH', 'Re-caulk tub table backsplash', 'Treatment', 'CLOSED', current_date - 15, now() - interval '12 days', v_v_capmech),
           (v_job, 'PUNCH', 'Replace cracked ceiling tile at corridor', 'Corridor', 'CLOSED', current_date - 15, now() - interval '12 days', null),
           (v_job, 'PUNCH', 'Label exhaust fan EF-2 and balance report', 'Kennel', 'CLOSED', current_date - 14, now() - interval '11 days', v_v_capmech),
           (v_job, 'PUNCH', 'Clean flooring and remove protection', 'All', 'CLOSED', current_date - 12, now() - interval '10 days', null),
           (v_job, 'PUNCH', 'Install missing outlet cover at exam 1', 'Exam 1', 'CLOSED', current_date - 12, now() - interval '10 days', null);
    insert into pm.punch_items (job_id, kind, title, area, status, due_on, description)
    values (v_job, 'WARRANTY', 'Kennel exhaust noisy at high speed', 'Kennel', 'OPEN', current_date + 7, 'Owner called after occupancy; Capitol Mechanical to check fan bearing (warranty).');
${tr('closeout')}
    perform pm.set_progress(v_job, 1.0);
    v_bill := pm.generate_progress_billing(v_job, current_date, 1.0);   -- final billing, retainage withheld until release
${tasks([
    { t: 'Substantial completion walk with owner', s: -12, d: -12, st: 'DONE', ms: true, who: 'admin' },
    { t: 'Punch list', s: -16, d: -10, st: 'DONE' },
    { t: 'Certificate of occupancy', s: -9, d: -9, st: 'DONE', ms: true },
    { t: 'O&M manuals, warranties and as-builts to owner', s: -8, d: 3, st: 'IN_PROGRESS', pct: 0.6, who: 'admin' },
    { t: 'Final pay application and unconditional final waivers', s: -2, d: 5, st: 'IN_PROGRESS', pct: 0.3, who: 'admin' },
    { t: 'Retainage release request', s: 10, d: 20, st: 'TODO' },
  ])}
${dailyLogs([
    { body: 'Final clean; owner moved in exam furniture; CO inspection passed.', wx: 'Sunny', hi: 66, lo: 47, crew: 4 },
    { body: 'Punch walk with Dr. Ostrander: 7 items; Capitol Mechanical balancing kennel exhaust.', wx: 'Cloudy', hi: 62, lo: 45, crew: 6 },
    { body: 'Seamless flooring cured; casework tops set; plumbing trim complete.', wx: 'Light rain', hi: 57, lo: 46, crew: 8 },
  ], 9)}`),

  job('nwc-bid-library-roof', 'SAMPLE — bidding, bid sent (labor line priced from a rate card)', `
    v_job := pm.create_project(c_loc, 'lump_sum', 'Story County Library — roof replacement and RTU upgrades', v_c_library, null, true,
      jsonb_build_object('_demo', v_key, 'market_sector', 'public', 'building_sf', 24800, 'prevailing_wage', true));
${site({ line1: '515 Douglas Ave', city: 'Ames', zip: '50010', start: 45, finish: 120 })}
${estimate({ title: 'Lump-sum bid — roof replacement and RTU upgrades', retainage: 0.05, valid: 'current_date + 60',
    notes: 'Alternate 1 (add walk pads) priced separately. Prevailing wage per owner requirements.', lines: libraryEst })}
    insert into pm.estimate_lines (estimate_id, line_no, sort, cost_code_id, description, labor_rate_card_id, labor_hours)
    select v_est, ${libraryEst.length + 1}, ${libraryEst.length + 1}, c.id, 'Superintendent, 12 weeks part-time', v_card2, 160
      from pm.cost_codes c where c.location_id = c_loc and c.job_id is null and c.code = '01 31 13';
    perform pm.send_estimate(v_est);
${tasks([
    { t: 'Pre-bid walkthrough with library facilities', s: -6, d: -6, st: 'DONE', who: 'admin' },
    { t: 'RTU pricing from Capitol Mechanical', s: -5, d: 2, st: 'IN_PROGRESS', pct: 0.5 },
    { t: 'Sealed bid due 2:00 pm', s: 6, d: 6, st: 'TODO', ms: true, who: 'admin' },
  ])}`),

  job('nwc-gmp-ankeny-mob', 'SAMPLE — awarded GMP, design development', `
    v_job := pm.create_project(c_loc, 'gmp_cost_plus', 'Ankeny Medical Partners — medical office building (GMP)', v_c_ankenymed, null, true,
      jsonb_build_object('_demo', v_key, 'market_sector', 'healthcare', 'building_sf', 38000, 'architect', 'Prairie Forge Design (demo)'));
${site({ line1: '2400 SW State St', city: 'Ankeny', zip: '50023', start: 60, finish: 420 })}
    perform pm.set_contract(v_job, ${usd(4_850_000)}, 'PRIME', 0.05);
${tr('awarded')}
${tasks([
    { t: 'Execute AIA A133 and GMP amendment', s: -14, d: -7, st: 'DONE', ms: true, who: 'admin' },
    { t: 'Design development pricing update', s: -5, d: 9, st: 'IN_PROGRESS', pct: 0.35, who: 'admin' },
    { t: 'Early release: sitework and foundations package', s: 10, d: 24, st: 'TODO' },
  ])}`),

  job('nwc-small-door-closer', 'SAMPLE — small T&M work in progress, time submitted', `
    v_job := pm.create_project(c_loc, 'small_work', 'Riverside Dental Group — after-hours door closer and panic bar repair', v_c_riverside, null, true,
      jsonb_build_object('_demo', v_key, 'customer_reference', 'Work request #77'));
${site({ line1: '4110 NW Urbandale Dr', city: 'Urbandale', zip: '50322', start: -1, finish: 1 })}
${tr('scheduled', 'in_progress')}
${timeEntries([
    { day: -1, hours: 3, code: '08 11 00', notes: 'Replace failed closer at rear exit; adjust strike' },
    { day: -1, hours: 1.5, pay: 'OT', code: '08 11 00', notes: 'After hours: re-key panic bar trim (clinic closed at 6)' },
  ])}`),
].join('');

