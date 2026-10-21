/** Acme Test Co — field_service (HVAC) demo data. */
import { type EstLine, type Party, at, commitment, estTotal, estimate, job, q, jb, site, tasks, timeEntries, tr, usd, values } from './lib';

export const customers: Party[] = [
  { v: 'v_c_brennan', name: 'Demo — Tom & Linda Brennan', email: 'linda@brennan-home.example', phone: '515-555-0511', first: 'Linda', last: 'Brennan' },
  { v: 'v_c_sorensen', name: 'Demo — Ellen Sorensen', email: 'ellen@sorensen-home.example', phone: '515-555-0522', first: 'Ellen', last: 'Sorensen' },
  { v: 'v_c_patel', name: 'Demo — Raj & Meera Patel', email: 'meera@patel-home.example', phone: '515-555-0533', first: 'Meera', last: 'Patel' },
  { v: 'v_c_whitfield', name: 'Demo — Marcus Whitfield', email: 'marcus@whitfield-home.example', phone: '515-555-0544', first: 'Marcus', last: 'Whitfield' },
  { v: 'v_c_ortega', name: 'Demo — Luis & Karen Ortega', email: 'karen@ortega-home.example', phone: '515-555-0555', first: 'Karen', last: 'Ortega' },
  { v: 'v_c_clivedental', name: 'Demo — Clive Family Dental', email: 'office@clivefamilydental.example', phone: '515-555-0566', first: 'Beth', last: 'Moreno' },
];

export const vendors: Party[] = [
  { v: 'v_v_midwesthvac', name: 'Demo — Midwest HVAC Supply', email: 'counter@midwesthvacsupply.example', phone: '515-555-0611', kind: 'SUPPLIER' },
  { v: 'v_v_capelec', name: 'Demo — Capital City Electric', email: 'dispatch@capitalcityelectric.example', phone: '515-555-0622', kind: 'SUBCONTRACTOR' },
  { v: 'v_v_dmsheet', name: 'Demo — Des Moines Sheet Metal', email: 'shop@dmsheetmetal.example', phone: '515-555-0633', kind: 'SUBCONTRACTOR' },
];

interface AssetSpec {
  v: string; customer: string; desc: string; site: string; line1: string; city: string; zip: string; serial: string;
  ext: Record<string, unknown>;
}
const assets: AssetSpec[] = [
  { v: 'v_a_brennan', customer: 'v_c_brennan', desc: '70k BTU 80% upflow gas furnace, basement', site: 'Basement mechanical room', line1: '1214 NW Weigel Dr', city: 'Ankeny', zip: '50023',
    serial: '5911K04211', ext: { equipment_type: 'furnace', serial_number: '5911K04211', brand: 'Lennox', model_number: 'ML180UH070P36A', refrigerant_type: 'none', install_date: '2011-10-14', warranty_expires: '2021-10-14' } },
  { v: 'v_a_sorensen', customer: 'v_c_sorensen', desc: '3-ton split AC condenser, side yard', site: 'Side yard', line1: '9310 Meredith Dr', city: 'Urbandale', zip: '50322',
    serial: '19341XN7AF', ext: { equipment_type: 'air_conditioner', serial_number: '19341XN7AF', brand: 'Trane', model_number: '4TTR4036L1000A', refrigerant_type: 'R-410A', tonnage: 3, install_date: '2019-08-02', warranty_expires: '2029-08-02' } },
  { v: 'v_a_patel', customer: 'v_c_patel', desc: '3-ton heat pump with air handler', site: 'Back patio / attic AHU', line1: '305 SE Laurel St', city: 'Waukee', zip: '50263',
    serial: '4821E09133', ext: { equipment_type: 'heat_pump', serial_number: '4821E09133', brand: 'Carrier', model_number: '25HCE436A003', refrigerant_type: 'R-410A', tonnage: 3, install_date: '2021-05-20', warranty_expires: '2031-05-20' } },
  { v: 'v_a_whitfield', customer: 'v_c_whitfield', desc: '3-ton AC on R-22, 18 years old', site: 'Back yard', line1: '2207 7th Ave SW', city: 'Altoona', zip: '50009',
    serial: '0806512718', ext: { equipment_type: 'air_conditioner', serial_number: '0806512718', brand: 'Goodman', model_number: 'CKL36-1', refrigerant_type: 'R-22', tonnage: 3, install_date: '2008-06-11', warranty_expires: '2018-06-11' } },
  { v: 'v_a_ortega', customer: 'v_c_ortega', desc: '75k BTU 80% gas furnace (being replaced)', site: 'Basement', line1: '5814 NW 88th St', city: 'Johnston', zip: '50131',
    serial: 'L059904857', ext: { equipment_type: 'furnace', serial_number: 'L059904857', brand: 'Rheem', model_number: 'RGPJ-07EAMKR', refrigerant_type: 'none', install_date: '2005-09-30' } },
  { v: 'v_a_clive', customer: 'v_c_clivedental', desc: '5-ton packaged rooftop unit RTU-1 (operatories)', site: 'Roof, RTU-1', line1: '1550 NW 114th St', city: 'Clive', zip: '50325',
    serial: '612101457L', ext: { equipment_type: 'rooftop_unit', serial_number: '612101457L', brand: 'Trane', model_number: 'YSC060A3RHA', refrigerant_type: 'R-410A', tonnage: 5, install_date: '2016-04-18', warranty_expires: '2026-04-18' } },
];

export const declare = assets.map((a) => `${a.v} uuid;`);

export const setup = `
  if not exists (select 1 from pm.labor_settings s where s.location_id = c_loc) then
    perform pm.set_labor_settings(c_loc, 0.28, 0.20, 'Demo: tech burden incl. truck, tools and WC class 5183');
  end if;
  select c.id into v_card from pm.labor_rate_cards c where c.location_id = c_loc and c.key = 'service_tech';
  if v_card is null then
    v_card := pm.save_labor_rate_card(c_loc, 'service_tech', 'Service technician', 3200, null, null, 14500, null);
  end if;
  select c.id into v_card2 from pm.labor_rate_cards c where c.location_id = c_loc and c.key = 'install_lead';
  if v_card2 is null then
    v_card2 := pm.save_labor_rate_card(c_loc, 'install_lead', 'Install lead', 3000, null, null, 12500, null);
  end if;
  if v_tech <> v_admin_emp and not exists (select 1 from pm.employee_rate_cards e where e.employee_id = v_tech and e.location_id = c_loc) then
    perform pm.set_employee_rate_card(v_tech, c_loc, v_card);
  end if;
  -- one piece of equipment per customer (assets outlive jobs; keyed by make + serial)
${assets.map((a) => `  select x.id into ${a.v} from pm.assets x where x.location_id = c_loc and x.serial_number = ${q(a.serial)};
  if ${a.v} is null then
    insert into pm.assets (location_id, kind, customer_id, description, site_label, site_address_line1, site_city, site_state, site_zip, ext)
    values (c_loc, 'CUSTOMER_EQUIPMENT', ${a.customer}, ${q(a.desc)}, ${q(a.site)}, ${q(a.line1)}, ${q(a.city)}, 'IA', ${q(a.zip)}, ${jb(a.ext)})
    returning id into ${a.v};
  end if;`).join('\n')}`;

/** price-book usage lines on v_wo: [code, kind, qty, status, option group] */
function woLines(rows: [string, string, number, 'APPROVED' | 'PROPOSED', string | null][]): string {
  return `    insert into pm.work_order_lines (work_order_id, sort, kind, price_book_item_id, qty, status, option_group)
    select v_wo, x.n, x.kind, pb.id, x.qty::numeric, x.st, x.grp
      from (values
      ${values(rows.map((r, i) => [i + 1, ...r]))}) x(n, code, kind, qty, st, grp)
      join pm.price_book_items pb on pb.location_id = c_loc and pb.code = x.code;
    get diagnostics v_n = row_count;
    if v_n <> ${rows.length} then raise exception 'DEMO %: work order lines matched % of ${rows.length} price book codes', v_key, v_n; end if;`;
}

function agreement(o: { plan: string; tier: string; customer: string; asset: string; startOffset: number; firstVisitOffset: number; cadence: string;
  visits: number; minutes: number; price: number; billing: string; discount: number }): string {
  return `    insert into pm.service_agreements (job_id, customer_id, plan_name, tier, starts_on, ends_on, cadence, first_visit_on, visits_per_term,
                                       visit_window_days, visit_minutes, price_cents, billing_frequency, member_discount_pct, auto_renew)
      values (v_job, ${o.customer}, ${q(o.plan)}, ${q(o.tier)}, current_date + ${o.startOffset}, (current_date + ${o.startOffset} + interval '1 year')::date,
              ${q(o.cadence)}, current_date + ${o.firstVisitOffset}, ${o.visits}, 30, ${o.minutes}, ${o.price}, ${q(o.billing)}, ${o.discount}, true)
      returning id into v_agr;
    insert into pm.agreement_assets (agreement_id, asset_id) values (v_agr, ${o.asset});
    perform pm.activate_agreement(v_agr);
    perform pm.generate_agreement_visits(v_agr, 365);`;
}

const ortegaEst: EstLine[] = [
  { code: 'INS-EQP', d: '96% AFUE two-stage furnace, 80k BTU, variable-speed ECM blower', qty: 1, uom: 'EA', cost: usd(2_140), price: usd(4_380) },
  { code: 'INS-EQP', d: '3-ton 16 SEER2 AC condenser and cased coil (R-454B)', qty: 1, uom: 'EA', cost: usd(2_860), price: usd(5_620) },
  { code: 'INS-MAT', d: 'Line set, pad, disconnect, whip, condensate pump and flue kit', qty: 1, uom: 'LS', cost: usd(640), price: usd(1_180) },
  { code: 'INS-LAB', d: 'Install labor — 2-tech crew, 1 day', qty: 1, uom: 'LS', cost: usd(1_280), price: usd(1_650) },
  { code: 'INS-ELE', d: 'New 30A condenser circuit (Capital City Electric)', qty: 1, uom: 'LS', cost: usd(380), price: usd(520) },
  { code: 'INS-PRM', d: 'City of Johnston mechanical permit', qty: 1, uom: 'EA', cost: usd(185), price: usd(185) },
  { code: 'INS-DSP', d: 'Recover refrigerant, haul away and recycle old equipment', qty: 1, uom: 'EA', cost: usd(65), price: usd(145) },
  { code: 'INS-COM', d: 'Comfort advisor commission', qty: 1, uom: 'EA', cost: usd(610), price: 0 },
];
const whitfieldBetter: EstLine[] = [
  { code: 'INS-EQP', d: '96% AFUE single-stage furnace, 60k BTU', qty: 1, uom: 'EA', cost: usd(1_780), price: usd(3_690) },
  { code: 'INS-EQP', d: '3-ton 15.2 SEER2 AC condenser and cased coil (R-454B)', qty: 1, uom: 'EA', cost: usd(2_640), price: usd(5_180) },
  { code: 'INS-MAT', d: 'New line set (R-22 lines cannot be reused), pad, disconnect, flue kit', qty: 1, uom: 'LS', cost: usd(590), price: usd(1_060) },
  { code: 'INS-LAB', d: 'Install labor — 2-tech crew, 1 day', qty: 1, uom: 'LS', cost: usd(1_180), price: usd(1_520) },
  { code: 'INS-PRM', d: 'City of Altoona mechanical permit', qty: 1, uom: 'EA', cost: usd(165), price: usd(165) },
  { code: 'INS-DSP', d: 'Recover R-22, haul away old equipment', qty: 1, uom: 'EA', cost: usd(65), price: usd(145) },
];
const whitfieldBest: EstLine[] = [
  { code: 'INS-EQP', d: '97% AFUE modulating furnace, 60k BTU (dual fuel)', qty: 1, uom: 'EA', cost: usd(2_650), price: usd(5_240) },
  { code: 'INS-EQP', d: '3-ton variable-speed heat pump and coil (R-454B), cold-climate rated', qty: 1, uom: 'EA', cost: usd(3_960), price: usd(7_480) },
  { code: 'INS-MAT', d: 'Line set, pad, disconnect, communicating thermostat', qty: 1, uom: 'LS', cost: usd(690), price: usd(1_240) },
  { code: 'INS-LAB', d: 'Install labor — 2-tech crew, 1.5 days', qty: 1, uom: 'LS', cost: usd(1_420), price: usd(1_860) },
  { code: 'INS-ELE', d: 'New 40A heat pump circuit (Capital City Electric)', qty: 1, uom: 'LS', cost: usd(380), price: usd(520) },
  { code: 'INS-PRM', d: 'City of Altoona mechanical permit', qty: 1, uom: 'EA', cost: usd(165), price: usd(165) },
  { code: 'INS-DSP', d: 'Recover R-22, haul away old equipment', qty: 1, uom: 'EA', cost: usd(65), price: usd(145) },
];
const cliveTicket = usd(89) + usd(289) + usd(279) + 2 * usd(95) + usd(169);

export const jobs = [
  job('atc-brennan-no-heat', 'REAL — no-heat call today, tech dispatched, repair options waiting on the homeowner', `
    v_job := pm.create_project(c_loc, 'service_call', 'Brennan — no heat, furnace locking out', v_c_brennan, null, false,
      jsonb_build_object('_demo', v_key, 'business_unit', 'hvac_service', 'campaign', 'Google local services'));
${site({ line1: '1214 NW Weigel Dr', city: 'Ankeny', zip: '50023', start: 0, finish: 0 })}
${tr('scheduled')}
    v_wo := pm.create_work_order(p_job => v_job, p_kind => 'SERVICE', p_summary => 'No heat — furnace locks out after 3 ignition tries', p_priority => 1,
      p_asset => v_a_brennan, p_requested_start => ${at('current_date', '08:00')}, p_requested_end => ${at('current_date', '12:00')},
      p_estimated_minutes => 90, p_complaint => 'Furnace runs a few minutes, then shuts off. Thermostat reads 61°F. Two kids at home.',
      p_ext => jsonb_build_object('arrival_window', '8-12'));
    v_res := pm.schedule_work_order(v_wo, ${at('current_date', '09:00')}, ${at('current_date', '11:00')}, array[v_tech]);
    perform pm.set_assignment_status((v_res -> 'assignment_ids' ->> 0)::uuid, 'DISPATCHED');
${woLines([
    ['DIAG', 'SERVICE', 1, 'APPROVED', null],
    ['FLAME-SNS', 'SERVICE', 1, 'PROPOSED', 'Ignition repair options'],
    ['IGN-HSI', 'SERVICE', 1, 'PROPOSED', 'Ignition repair options'],
    ['INDUCER', 'SERVICE', 1, 'PROPOSED', 'If the pressure switch fault persists'],
  ])}`),

  job('atc-sorensen-comfort-club', 'REAL — Comfort Club Gold membership, fall tune-up due in 4 days (queue)', `
    v_job := pm.create_project(c_loc, 'maintenance_visit', 'Sorensen — Comfort Club Gold membership', v_c_sorensen, null, false,
      jsonb_build_object('_demo', v_key, 'business_unit', 'hvac_service', 'campaign', 'Converted from a repair visit'));
${site({ line1: '9310 Meredith Dr', city: 'Urbandale', zip: '50322', start: -10, finish: 355 })}
    perform pm.set_contract(v_job, ${usd(239)}, 'SERVICE_AGREEMENT');
${tr('scheduled')}
${agreement({ plan: 'Comfort Club', tier: 'Gold', customer: 'v_c_sorensen', asset: 'v_a_sorensen', startOffset: -10, firstVisitOffset: 4, cadence: 'SEMIANNUAL',
    visits: 2, minutes: 75, price: usd(239), billing: 'ANNUAL', discount: 0.15 })}`),

  job('atc-patel-comfort-club', 'SAMPLE — Comfort Club Silver (monthly); first visit scheduled today', `
    v_job := pm.create_project(c_loc, 'maintenance_visit', 'Patel — Comfort Club Silver membership', v_c_patel, null, true,
      jsonb_build_object('_demo', v_key, 'business_unit', 'hvac_service', 'campaign', 'Website sign-up'));
${site({ line1: '305 SE Laurel St', city: 'Waukee', zip: '50263', start: -3, finish: 362 })}
    perform pm.set_contract(v_job, ${12 * 1495}, 'SERVICE_AGREEMENT');
${tr('scheduled')}
${agreement({ plan: 'Comfort Club', tier: 'Silver', customer: 'v_c_patel', asset: 'v_a_patel', startOffset: -3, firstVisitOffset: 0, cadence: 'SEMIANNUAL',
    visits: 2, minutes: 90, price: 1495, billing: 'MONTHLY', discount: 0.1 })}
    select w.id into v_wo from pm.work_orders w where w.agreement_id = v_agr and w.visit_seq = 1;
    perform pm.schedule_work_order(v_wo, ${at('current_date', '13:00')}, ${at('current_date', '14:30')}, array[v_tech]);`),

  job('atc-whitfield-replacement-proposal', 'SAMPLE — replacement proposal: good/better options sent', `
    v_job := pm.create_project(c_loc, 'replacement_install', 'Whitfield — AC and furnace replacement proposal (R-22 system)', v_c_whitfield, null, true,
      jsonb_build_object('_demo', v_key, 'business_unit', 'hvac_install', 'campaign', 'Repair-to-replace (tech lead)'));
${site({ line1: '2207 7th Ave SW', city: 'Altoona', zip: '50009' })}
${tr('options_presented')}
${estimate({ title: 'Option 1 — Better: 96% furnace + 15.2 SEER2 AC', valid: 'current_date + 28', notes: '10-year parts warranty when registered; financing available.', lines: whitfieldBetter })}
    perform pm.send_estimate(v_est);
${estimate({ v: 'v_est2', title: 'Option 2 — Best: dual-fuel heat pump + modulating furnace', valid: 'current_date + 28', notes: 'Qualifies for the utility heat pump rebate (customer to apply).', lines: whitfieldBest })}
    perform pm.send_estimate(v_est2);
${tasks([
    { t: 'Follow up on the proposal (sent 2 days ago)', s: 1, d: 1, st: 'TODO', who: 'admin' },
    { t: 'Confirm utility rebate eligibility for the heat pump option', s: 0, d: 3, st: 'TODO' },
  ])}`),

  job('atc-ortega-replacement', 'REAL — replacement sold, deposit sent to Books, install next Tuesday', `
    v_job := pm.create_project(c_loc, 'replacement_install', 'Ortega — furnace and AC replacement', v_c_ortega, null, false,
      jsonb_build_object('_demo', v_key, 'business_unit', 'hvac_install', 'campaign', 'Repair-to-replace (tech lead)', 'permit_number', 'MECH-26-1187'));
${site({ line1: '5814 NW 88th St', city: 'Johnston', zip: '50131', start: 6, finish: 9 })}
${tr('options_presented')}
${estimate({ title: 'Accepted — 96% two-stage furnace + 16 SEER2 AC', valid: 'current_date + 21', notes: 'Signed in the home; 40% deposit, balance at completion.', lines: ortegaEst })}
    perform pm.send_estimate(v_est);
    v_j := pm.accept_estimate(v_est);
    perform pm.request_deposit(v_job, ${Math.round(estTotal(ortegaEst) * 0.4)}, 'Deposit — 40% at signing');
${tr('sold', 'equipment_permit')}
${commitment({ type: 'PO', vendor: 'v_v_midwesthvac', title: 'Equipment for Ortega replacement', retainage: 0,
    lines: [['INS-EQP', '80k two-stage furnace', 2_140], ['INS-EQP', '3-ton AC condenser + cased coil, R-454B', 2_860], ['INS-MAT', 'Line set, pad, disconnect, whip, flue kit', 640]] })}
    v_wo := pm.create_work_order(p_job => v_job, p_kind => 'INSTALL', p_summary => 'Install furnace, AC, coil and line set', p_priority => 2,
      p_asset => v_a_ortega, p_requested_start => ${at('v_tue', '07:30')}, p_requested_end => ${at('v_tue', '16:30')}, p_estimated_minutes => 540,
      p_promised_on => v_tue);
    perform pm.schedule_work_order(v_wo, ${at('v_tue', '07:30')}, ${at('v_tue', '16:30')}, array[v_tech]);
${tasks([
    { t: 'Load calculation (Manual J)', s: -4, d: -4, st: 'DONE', who: 'tech' },
    { t: 'Order equipment from Midwest HVAC Supply', s: -1, d: 1, st: 'IN_PROGRESS', pct: 0.5, who: 'admin' },
    { t: 'Pull mechanical permit (City of Johnston)', s: -1, d: -1, st: 'DONE' },
    { t: 'Install day', s: 6, d: 6, st: 'TODO', who: 'tech' },
    { t: 'City inspection', s: 9, d: 9, st: 'TODO', ms: true },
    { t: 'Register warranty and offer Comfort Club', s: 10, d: 10, st: 'TODO' },
  ])}`),

  job('atc-clive-dental-rtu', 'SAMPLE — RTU repair completed yesterday, price-book ticket ready to invoice', `
    v_job := pm.create_project(c_loc, 'service_call', 'Clive Family Dental — RTU-1 not cooling', v_c_clivedental, null, true,
      jsonb_build_object('_demo', v_key, 'business_unit', 'hvac_service', 'campaign', 'Existing customer'));
${site({ line1: '1550 NW 114th St', city: 'Clive', zip: '50325', start: -1, finish: -1 })}
${tr('scheduled')}
    v_wo := pm.create_work_order(p_job => v_job, p_kind => 'SERVICE', p_summary => 'RTU-1 not cooling — operatories at 79°F', p_priority => 2,
      p_asset => v_a_clive, p_requested_start => ${at('current_date - 1', '13:00')}, p_requested_end => ${at('current_date - 1', '17:00')},
      p_estimated_minutes => 120, p_complaint => 'Front office says the patient rooms are warm since lunch.', p_ext => jsonb_build_object('arrival_window', '12-4'));
    perform pm.schedule_work_order(v_wo, ${at('current_date - 1', '14:00')}, ${at('current_date - 1', '16:00')}, array[v_tech]);
${tr('working')}
${woLines([
    ['DIAG', 'SERVICE', 1, 'APPROVED', null],
    ['CAP-DUAL', 'SERVICE', 1, 'APPROVED', null],
    ['CONT-1P', 'SERVICE', 1, 'APPROVED', null],
    ['REF-410A', 'PART', 2, 'APPROVED', null],
    ['COND-DRAIN', 'SERVICE', 1, 'APPROVED', null],
  ])}
    perform pm.complete_work_order(v_wo, 'FIXED', 'Replaced failed 45/5 dual run capacitor and pitted contactor; added 2 lb R-410A; cleared condensate line. Supply air 56°F, delta-T 19°F.');
${tr('completed')}
${timeEntries([{ day: -1, hours: 1.75, code: 'SVC-LAB', notes: 'RTU-1 diagnosis and repair', wo: 'v_wo' }])}
    perform pm.set_contract(v_job, ${cliveTicket});
    insert into pm.billing_requests (job_id, billing_type, billing_subtype, occurred_on, memo)
      values (v_job, 'MILESTONE', 'FIXED', current_date, 'Service ticket — RTU-1 repair (flat rate)') returning id into v_bill;
    insert into pm.billing_request_lines (billing_request_id, line_no, sort, description, amount_cents)
    select v_bill, l.sort, l.sort, l.description, l.amount_cents from pm.work_order_lines l where l.work_order_id = v_wo and l.status = 'APPROVED';`),
].join('');
