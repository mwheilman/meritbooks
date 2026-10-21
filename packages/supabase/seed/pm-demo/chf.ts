/** [SANDBOX] Coho Flooring — flooring demo data. */
import { type EstLine, type Party, R, at, budget, estTotal, estimate, job, q, site, tasks, timeEntries, tr, usd, values } from './lib';

export const customers: Party[] = [
  { v: 'v_c_kowalski', name: 'Demo — Sara & Jake Kowalski', email: 'sara@kowalski-family.example', phone: '515-555-0311', first: 'Sara', last: 'Kowalski' },
  { v: 'v_c_nguyen', name: 'Demo — Minh & Lan Nguyen', email: 'minh@nguyen-home.example', phone: '515-555-0322', first: 'Minh', last: 'Nguyen' },
  { v: 'v_c_prairietrail', name: 'Demo — Prairie Trail Homes', email: 'purchasing@prairietrailhomes.example', phone: '515-555-0333', first: 'Cody', last: 'Brandt' },
  { v: 'v_c_thompson', name: 'Demo — Rachel Thompson', email: 'rachel@thompson-home.example', phone: '515-555-0344', first: 'Rachel', last: 'Thompson' },
  { v: 'v_c_schmidt', name: 'Demo — Dale & Karen Schmidt', email: 'karen@schmidt-home.example', phone: '515-555-0355', first: 'Karen', last: 'Schmidt' },
  { v: 'v_c_waukee', name: 'Demo — Waukee Community School District', email: 'facilities@waukee-csd.example', phone: '515-555-0366', first: 'Terry', last: 'Albrecht' },
];

export const vendors: Party[] = [
  { v: 'v_v_heartland', name: 'Demo — Heartland Floor Distributors', email: 'orders@heartlandfloor.example', phone: '515-555-0411', kind: 'SUPPLIER' },
  { v: 'v_v_midlands', name: 'Demo — Midlands Carpet Mills', email: 'customerservice@midlandscarpet.example', phone: '706-555-0422', kind: 'SUPPLIER' },
  { v: 'v_v_jensen', name: 'Demo — Jensen Install Co.', email: 'schedule@jenseninstall.example', phone: '515-555-0433', kind: 'SUBCONTRACTOR' },
];

export const setup = `
  if not exists (select 1 from pm.labor_settings s where s.location_id = c_loc) then
    perform pm.set_labor_settings(c_loc, 0.22, 0.12, 'Demo: in-house installer burden; overhead for quoting');
  end if;
  select c.id into v_card from pm.labor_rate_cards c where c.location_id = c_loc and c.key = 'installer';
  if v_card is null then
    v_card := pm.save_labor_rate_card(c_loc, 'installer', 'Installer (W-2)', 2800, null, null, 6000, null);
  end if;
  if v_tech <> v_admin_emp and not exists (select 1 from pm.employee_rate_cards e where e.employee_id = v_tech and e.location_id = c_loc) then
    perform pm.set_employee_rate_card(v_tech, c_loc, v_card);
  end if;
  -- warehouse (operational stock location; Books owns inventory value)
  select s.id into v_stock from pm.stock_locations s where s.location_id = c_loc and s.code = 'WH-GRIMES';
  if v_stock is null then
    insert into pm.stock_locations (location_id, code, name, kind, address_line1, city, state, zip)
    values (c_loc, 'WH-GRIMES', 'Coho warehouse — Grimes', 'WAREHOUSE', '1450 SE Gateway Dr', 'Grimes', 'IA', '50111')
    returning id into v_stock;
  end if;`;

/** measure + areas, finalized: [room, kind, category, L, W, sqft|null, linear_ft|null, waste, uom, coverage|null] */
function measure(note: string, rows: [string, string, string, number | null, number | null, number | null, number | null, number, string, number | null][], daysAgo: number, finalize = true): string {
  return `    insert into pm.measures (job_id, measured_on, measured_by_employee_id, source, notes)
      values (v_job, current_date - ${daysAgo}, v_admin_emp, 'MEASURESQUARE', ${q(note)}) returning id into v_meas;
    insert into pm.measure_areas (measure_id, room_name, area_kind, product_category, length_ft, width_ft, sqft, linear_ft, waste_pct, material_uom, coverage_sf_per_unit, sort)
    select v_meas, x.room, x.kind, x.cat, x.l::numeric, x.w::numeric, x.sf::numeric, x.lf::numeric, x.waste::numeric, x.uom, x.cov::numeric, x.n
      from (values
      ${values(rows.map((r, i) => [...r, i + 1]))}) x(room, kind, cat, l, w, sf, lf, waste, uom, cov, n);${finalize ? `
    perform pm.finalize_measure(v_meas);` : ''}`;
}

const kowalskiEst: EstLine[] = [
  { code: 'MAT-LVP', d: 'Rigid-core LVP, Prairie Oak 7x48, 20 mil wear (29 boxes / 686 SF)', qty: 686, uom: 'SF', cost: 261, price: 429 },
  { code: 'MAT-SUN', d: 'Underlayment, adhesive and sundries', qty: 1, uom: 'EA', cost: 9_800, price: 16_500 },
  { code: 'MAT-TRN', d: 'Quarter round, T-molds and stair nose', qty: 180, uom: 'LF', cost: 95, price: 189 },
  { code: 'LAB-HS', d: 'Install LVP, floating (L-LVP-FLT)', qty: 612, uom: 'SF', cost: 160, price: 250 },
  { code: 'LAB-REM', d: 'Remove and dispose carpet and pad', qty: 48, uom: 'SY', cost: 125, price: 200 },
  { code: 'LAB-MOV', d: 'Furniture moving', qty: 4, uom: 'ROOM', cost: 2_000, price: 3_500 },
  { code: 'OTH-DEL', d: 'Delivery to site', qty: 1, uom: 'EA', cost: 4_500, price: 7_500 },
];
const nguyenEst: EstLine[] = [
  { code: 'MAT-CPT', d: 'Carpet, bedrooms 1–3 and closets (62 SY), style per selection', qty: 62, uom: 'SY', cost: 2_350, price: 3_890 },
  { code: 'MAT-PAD', d: '8 lb rebond pad, 7/16 in', qty: 62, uom: 'SY', cost: 420, price: 700 },
  { code: 'LAB-CPT', d: 'Carpet install', qty: 62, uom: 'SY', cost: 550, price: 850 },
  { code: 'LAB-REM', d: 'Remove and dispose carpet and pad', qty: 62, uom: 'SY', cost: 125, price: 200 },
  { code: 'MAT-TIL', d: 'Hall bath porcelain tile 12x24 (allowance 6.50/SF)', qty: 95, uom: 'SF', cost: 390, price: 650, allowance: true },
  { code: 'MAT-SUN', d: 'Thinset, grout and uncoupling membrane', qty: 1, uom: 'EA', cost: 14_500, price: 23_900 },
  { code: 'LAB-TIL', d: 'Floor tile install', qty: 85, uom: 'SF', cost: 600, price: 900 },
  { code: 'LAB-MOV', d: 'Furniture moving', qty: 3, uom: 'ROOM', cost: 2_000, price: 3_500 },
];
const schmidtEst: EstLine[] = [
  { code: 'MAT-TIL', d: 'Porcelain 24x24, Ash (210 SF incl. waste)', qty: 210, uom: 'SF', cost: 340, price: 580 },
  { code: 'MAT-SUN', d: 'Thinset, grout and uncoupling membrane', qty: 1, uom: 'EA', cost: 18_600, price: 29_800 },
  { code: 'MAT-TRN', d: 'Schluter edge trim', qty: 6, uom: 'EA', cost: 1_800, price: 3_200 },
  { code: 'LAB-TIL', d: 'Floor tile install', qty: 190, uom: 'SF', cost: 600, price: 900 },
  { code: 'LAB-REM', d: 'Remove sheet vinyl and underlayment', qty: 190, uom: 'SF', cost: 100, price: 150 },
];
const thompsonEst: EstLine[] = [
  { code: 'MAT-CPT', d: 'Basement carpet, solution-dyed nylon (48 SY)', qty: 48, uom: 'SY', cost: 1_950, price: 3_290 },
  { code: 'MAT-PAD', d: '8 lb rebond pad with moisture barrier', qty: 48, uom: 'SY', cost: 480, price: 790 },
  { code: 'LAB-CPT', d: 'Carpet install', qty: 48, uom: 'SY', cost: 550, price: 850 },
  { code: 'LAB-STR', d: 'Stairs (13 steps)', qty: 13, uom: 'STEP', cost: 1_000, price: 1_500 },
];
const waukeeEst: EstLine[] = [
  { code: 'MAT-LVP', d: 'Commercial LVT 18x18, 28 mil wear', qty: 8_400, uom: 'SF', cost: 310, price: 495 },
  { code: 'LAB-REM', d: 'Remove VCT and scrape', qty: 8_400, uom: 'SF', cost: 100, price: 150 },
  { code: 'LAB-PREP', d: 'Floor prep and leveling', qty: 40, uom: 'HR', cost: 4_500, price: 7_500 },
  { code: 'LAB-HS', d: 'LVT glue-down install', qty: 8_400, uom: 'SF', cost: 210, price: 325 },
  { code: 'MAT-TRN', d: 'Rubber base, 4 in', qty: 1_900, uom: 'LF', cost: 120, price: 240 },
];

const half = (lines: EstLine[]): number => Math.round(estTotal(lines) / 2);

export const jobs = [
  job('chf-kowalski-lvp', 'REAL — material received, LVP install scheduled Thursday', `
    v_job := pm.create_project(c_loc, 'retail_install', 'Kowalski — main floor LVP', v_c_kowalski, null, false,
      jsonb_build_object('_demo', v_key, 'measured_sf', 612, 'salesperson', 'Showroom (Mike H.)', 'tax_mode', 'retail_sale', 'subfloor', 'plywood'));
${site({ line1: '7708 Wilden Dr', city: 'Urbandale', zip: '50322', start: -12, finish: 7 })}
${estimate({ title: 'Quote — main floor LVP and trim', valid: 'current_date + 18', notes: 'Price includes furniture moving (4 rooms); appliances by others.', lines: kowalskiEst })}
    perform pm.send_estimate(v_est);
    v_j := pm.accept_estimate(v_est);
    perform pm.request_deposit(v_job, ${half(kowalskiEst)}, 'Deposit — 50% at signing');
${measure('Main floor, MeasureSquare export v1', [
    ['Living room', 'FLOOR', 'LVP', 18, 16, null, null, 0.1, 'BOX', 23.64],
    ['Kitchen and dining', 'FLOOR', 'LVP', 14, 12.5, null, null, 0.1, 'BOX', 23.64],
    ['Hallway', 'FLOOR', 'LVP', 3.5, 22, null, null, 0.1, 'BOX', 23.64],
    ['Entry', 'FLOOR', 'LVP', 6, 12, null, null, 0.1, 'BOX', 23.64],
    ['Quarter round, main floor', 'BASE', 'LVP', null, null, null, 180, 0.05, 'LF', null],
  ], 12)}
    insert into pm.selections (job_id, category, title, description, due_on, ext)
      values (v_job, 'LVP', 'Main floor plank — style, color and dye lot', 'Same dye lot across all connected rooms.', current_date - 14,
              jsonb_build_object('style_color', 'Prairie Oak 7x48', 'dye_lot', 'PO-2409-17', 'room', 'Main floor', 'quantity_sf', 686, 'waste_pct', 0.1))
      returning id into v_sel;
    insert into pm.selection_options (selection_id, sort, label, description, vendor_id, vendor_sku, qty, uom, unit_cost_cents, unit_price_cents, lead_time_days, is_recommended)
      values (v_sel, 1, 'Prairie Oak 7x48 (in stock)', 'Rigid core, 20 mil, attached pad; dye lot PO-2409-17 on hand', v_v_heartland, 'HFD-RC7-PRAOAK', 686, 'SF', 261, 429, 7, true)
      returning id into v_opt;
    insert into pm.selection_options (selection_id, sort, label, description, vendor_id, vendor_sku, qty, uom, unit_cost_cents, unit_price_cents, lead_time_days)
      values (v_sel, 2, 'Driftwood Gray 7x48 (special order)', 'Same construction; 3-week lead time', v_v_heartland, 'HFD-RC7-DRFGRY', 686, 'SF', 279, 459, 21);
    perform pm.approve_selection(v_sel, v_opt, 'Demo Client', 'IN_PERSON', null, 'Chose Prairie Oak in the showroom; confirmed the dye lot on the sample board');
    v_item := pm.create_procurement_from_selection(v_sel, v_v_heartland);
    perform pm.advance_procurement_item(v_item, 'ORDERED', current_date - 9, jsonb_build_object('po_number', 'HFD-55812', 'expected_on', current_date - 2));
    perform pm.advance_procurement_item(v_item, 'RECEIVED', current_date - 2,
      jsonb_build_object('received_qty', 686, 'received_condition', 'GOOD', 'storage_location_id', v_stock, 'note', 'Checked dye lot PO-2409-17 on every box'));
    update pm.procurement_items set install_on = v_thu, sidemark = 'KOWALSKI / MAIN FLR' where id = v_item;
${tr('sold', 'ordered', 'received')}
    v_wo := pm.create_work_order(p_job => v_job, p_kind => 'INSTALL', p_summary => 'Install LVP, main floor (612 SF) and quarter round', p_priority => 2,
      p_requested_start => ${at('v_thu', '08:00')}, p_requested_end => ${at('v_thu', '16:00')}, p_estimated_minutes => 480,
      p_ext => jsonb_build_object('installer_pay_cents', ${612 * 160}), p_promised_on => v_thu);
    perform pm.schedule_work_order(v_wo, ${at('v_thu', '08:00')}, ${at('v_thu', '16:00')}, array[v_tech]);
${tasks([
    { t: 'Measure appointment', s: -12, d: -12, st: 'DONE', who: 'admin' },
    { t: 'Order material and confirm dye lot', s: -9, d: -9, st: 'DONE' },
    { t: 'Receive and inspect material', s: -2, d: -2, st: 'DONE' },
    { t: 'Call Sara to confirm Thursday 8 am arrival', s: 0, d: 0, st: 'TODO', who: 'admin' },
    { t: 'Remove carpet and install LVP, main floor', s: R('(v_thu - current_date)'), d: R('(v_thu - current_date)'), st: 'TODO', who: 'tech' },
    { t: 'Final walkthrough and balance invoice', s: R('(v_thu - current_date + 1)'), d: R('(v_thu - current_date + 1)'), st: 'TODO', who: 'admin' },
  ])}`),

  job('chf-nguyen-carpet-tile', 'REAL — sold, waiting on the client\'s carpet and tile selections', `
    v_job := pm.create_project(c_loc, 'retail_install', 'Nguyen — bedroom carpet and hall bath tile', v_c_nguyen, null, false,
      jsonb_build_object('_demo', v_key, 'measured_sf', 546, 'salesperson', 'Showroom (Mike H.)', 'tax_mode', 'retail_sale', 'subfloor', 'osb'));
${site({ line1: '1823 Bridgewood Blvd', city: 'West Des Moines', zip: '50265', start: 7, finish: 16 })}
${estimate({ title: 'Quote — bedroom carpet and hall bath tile', valid: 'current_date + 21', notes: 'Bath tile carried as an allowance until the client picks the tile.', lines: nguyenEst })}
    perform pm.send_estimate(v_est);
    v_j := pm.accept_estimate(v_est);
    perform pm.request_deposit(v_job, ${half(nguyenEst)}, 'Deposit — 50% at signing');
${tr('sold')}
${measure('Upstairs bedrooms and hall bath', [
    ['Primary bedroom', 'FLOOR', 'CARPET', 14, 13, null, null, 0.2, 'SY', null],
    ['Bedroom 2', 'FLOOR', 'CARPET', 11, 11, null, null, 0.2, 'SY', null],
    ['Bedroom 3', 'FLOOR', 'CARPET', 10, 11, null, null, 0.2, 'SY', null],
    ['Closets (3)', 'FLOOR', 'CARPET', null, null, 48, null, 0.2, 'SY', null],
    ['Hall bath', 'FLOOR', 'TILE', 8.5, 10, null, null, 0.1, 'SF', null],
  ], 9)}
    insert into pm.selections (job_id, category, title, description, due_on, ext)
      values (v_job, 'Carpet', 'Bedroom carpet — style and color', 'Three samples left with the client on the measure visit.', current_date + 2,
              jsonb_build_object('room', 'Bedrooms 1–3', 'quantity_sf', 558, 'waste_pct', 0.2, 'dye_lot', 'Assigned at order'))
      returning id into v_sel;
    insert into pm.selection_options (selection_id, sort, label, description, vendor_id, vendor_sku, qty, uom, unit_cost_cents, unit_price_cents, lead_time_days, is_recommended)
    values (v_sel, 1, 'Hearthside textured saxony — Driftwood', 'Solution-dyed nylon, 50 oz', v_v_midlands, 'MCM-HRTH-DRFT', 62, 'SY', 2350, 3890, 10, true),
           (v_sel, 2, 'Summit Trail pattern — Granite', 'Cut-and-loop, hides wear', v_v_midlands, 'MCM-SMTR-GRAN', 62, 'SY', 2780, 4490, 14, false),
           (v_sel, 3, 'Easy Living PET — Linen', 'Budget option, 40 oz', v_v_midlands, 'MCM-EZLV-LINN', 62, 'SY', 1890, 3290, 7, false);
    perform pm.propose_selection(v_sel);
    insert into pm.selections (job_id, category, title, description, allowance_cents, due_on, ext)
      values (v_job, 'Tile', 'Hall bath floor tile', 'Allowance 6.50/SF on 95 SF.', ${95 * 650}, current_date - 1,
              jsonb_build_object('room', 'Hall bath', 'quantity_sf', 95, 'waste_pct', 0.1, 'dye_lot', 'Shade lot at order'))
      returning id into v_sel2;
    insert into pm.selection_options (selection_id, sort, label, description, vendor_id, vendor_sku, qty, uom, unit_cost_cents, unit_price_cents, lead_time_days)
    values (v_sel2, 1, '12x24 porcelain, Calacatta look', 'Rectified, matte', v_v_heartland, 'HFD-P1224-CALA', 95, 'SF', 410, 690, 5),
           (v_sel2, 2, '12x24 porcelain, Slate gray', 'Rectified, textured', v_v_heartland, 'HFD-P1224-SLAT', 95, 'SF', 360, 600, 5);
${tasks([
    { t: 'Measure appointment', s: -9, d: -9, st: 'DONE', who: 'admin' },
    { t: 'Client picks carpet (3 samples left)', s: -9, d: 2, st: 'IN_PROGRESS', pct: 0.5, who: 'admin' },
    { t: 'Client picks bath tile (overdue)', s: -9, d: -1, st: 'BLOCKED', who: 'admin' },
    { t: 'Order carpet, pad and tile', s: 3, d: 3, st: 'TODO' },
    { t: 'Install carpet and tile', s: 14, d: 15, st: 'TODO' },
  ])}`),

  job('chf-prairie-trail-lot14', 'REAL — builder lot, measure booked', `
    v_job := pm.create_project(c_loc, 'builder_lot', 'Prairie Trail Homes — Lot 14, Ashland plan', v_c_prairietrail, null, false,
      jsonb_build_object('_demo', v_key, 'lot_number', '14', 'measured_sf', 1480, 'tax_mode', 'contractor_improvement', 'subfloor', 'osb',
                         'customer_reference', 'PTH option sheet 14-B'));
${site({ line1: '1406 NW Prairie Trail Pkwy (Lot 14)', city: 'Ankeny', zip: '50023', start: 10, finish: 12 })}
${budget('Builder option sheet 14-B', [
    ['MAT-CPT', 'Carpet, 3 bedrooms + loft', 1_640], ['MAT-PAD', 'Pad', 310], ['MAT-LVP', 'LVP, main level', 1_520], ['MAT-SUN', 'Sundries', 140],
    ['MAT-TRN', 'Transitions and stair nose', 120], ['LAB-CPT', 'Carpet install', 520], ['LAB-HS', 'LVP install', 980], ['OTH-DEL', 'Delivery', 75],
  ])}
    perform pm.set_contract(v_job, ${usd(7_420)});
    v_wo := pm.create_work_order(p_job => v_job, p_kind => 'MEASURE', p_summary => 'Measure Lot 14 at drywall complete', p_priority => 3,
      p_requested_start => ${at('current_date + 2', '10:00')}, p_requested_end => ${at('current_date + 2', '11:00')}, p_estimated_minutes => 60);
    perform pm.schedule_work_order(v_wo, ${at('current_date + 2', '10:00')}, ${at('current_date + 2', '11:00')}, array[v_admin_emp]);
${tasks([
    { t: 'Builder option sheet received', s: -5, d: -5, st: 'DONE' },
    { t: 'Field measure at drywall complete', s: 2, d: 2, st: 'TODO', who: 'admin' },
    { t: 'Install (per builder schedule)', s: 10, d: 12, st: 'TODO' },
  ])}`),

  job('chf-thompson-basement', 'SAMPLE — measure and quote, measure in the dispatch queue (unassigned)', `
    v_job := pm.create_project(c_loc, 'retail_install', 'Thompson — basement carpet and stairs', v_c_thompson, null, true,
      jsonb_build_object('_demo', v_key, 'salesperson', 'Showroom (Mike H.)', 'tax_mode', 'retail_sale', 'subfloor', 'concrete'));
${site({ line1: '412 8th St SW', city: 'Altoona', zip: '50009' })}
${estimate({ title: 'Draft quote — basement carpet (pending measure)', valid: 'current_date + 30', lines: thompsonEst })}
    v_wo := pm.create_work_order(p_job => v_job, p_kind => 'MEASURE', p_summary => 'Measure basement family room and stairs', p_priority => 3,
      p_requested_start => ${at('current_date + 1', '13:00')}, p_requested_end => ${at('current_date + 1', '15:00')}, p_estimated_minutes => 45);
${tasks([{ t: 'Measure appointment (needs an estimator)', s: 1, d: 1, st: 'TODO' }])}`),

  job('chf-schmidt-kitchen-tile', 'SAMPLE — installed, balance invoice drafted', `
    v_job := pm.create_project(c_loc, 'retail_install', 'Schmidt — kitchen and laundry tile', v_c_schmidt, null, true,
      jsonb_build_object('_demo', v_key, 'measured_sf', 190, 'salesperson', 'Showroom (Mike H.)', 'tax_mode', 'retail_sale', 'subfloor', 'plywood'));
${site({ line1: '6120 NW 62nd Ave', city: 'Johnston', zip: '50131', start: -6, finish: -6 })}
${estimate({ title: 'Quote — kitchen and laundry tile', valid: 'current_date - 10', lines: schmidtEst })}
    perform pm.send_estimate(v_est);
    v_j := pm.accept_estimate(v_est);
    perform pm.request_deposit(v_job, ${half(schmidtEst)}, 'Deposit — 50% at signing');
    insert into pm.selections (job_id, category, title, due_on, ext)
      values (v_job, 'Tile', 'Kitchen and laundry floor tile', current_date - 25,
              jsonb_build_object('style_color', 'Ash 24x24', 'dye_lot', 'ASH-0826-3', 'room', 'Kitchen and laundry', 'quantity_sf', 210, 'waste_pct', 0.1))
      returning id into v_sel;
    insert into pm.selection_options (selection_id, sort, label, vendor_id, vendor_sku, qty, uom, unit_cost_cents, unit_price_cents, lead_time_days, is_recommended)
      values (v_sel, 1, 'Porcelain 24x24, Ash', v_v_heartland, 'HFD-P2424-ASH', 210, 'SF', 340, 580, 5, true) returning id into v_opt;
    perform pm.approve_selection(v_sel, v_opt, 'Demo Client', 'IN_PERSON');
${tr('sold', 'ordered', 'received', 'installing')}
    v_wo := pm.create_work_order(p_job => v_job, p_kind => 'INSTALL', p_summary => 'Install kitchen and laundry tile (190 SF)', p_priority => 3,
      p_requested_start => ${at('current_date - 6', '08:00')}, p_requested_end => ${at('current_date - 6', '16:00')}, p_estimated_minutes => 480,
      p_ext => jsonb_build_object('installer_pay_cents', ${190 * 600}));
    perform pm.schedule_work_order(v_wo, ${at('current_date - 6', '08:00')}, ${at('current_date - 6', '16:00')}, array[v_tech]);
    perform pm.complete_work_order(v_wo, 'COMPLETED', 'Installed 190 SF on uncoupling membrane; grouted, sealed, laundry threshold trimmed.');
${tr('installed')}
${timeEntries([{ day: -6, hours: 7, code: 'LAB-W2', notes: 'Helper: demo sheet vinyl, set membrane, grout', wo: 'v_wo' }])}
    insert into pm.billing_requests (job_id, billing_type, billing_subtype, occurred_on, memo)
      values (v_job, 'MILESTONE', 'FIXED', current_date, 'Balance on completion (the deposit is applied in Books)') returning id into v_bill;
    insert into pm.billing_request_lines (billing_request_id, line_no, sort, description, amount_cents)
      values (v_bill, 1, 1, 'Tile, setting materials and trim', ${121_800 + 29_800 + 19_200}),
             (v_bill, 2, 2, 'Installation and removal of existing floor', ${171_000 + 28_500});`),

  job('chf-waukee-csd-corridor', 'SAMPLE — commercial bid sent (pay-app job type)', `
    v_job := pm.create_project(c_loc, 'commercial_flooring', 'Waukee CSD — Prairieview corridor LVT replacement', v_c_waukee, null, true,
      jsonb_build_object('_demo', v_key, 'measured_sf', 8400, 'tax_mode', 'exempt_resale', 'subfloor', 'concrete', 'customer_reference', 'Bid 2027-04'));
${site({ line1: '755 SE Alice Nelson Dr', city: 'Waukee', zip: '50263', start: 240, finish: 255 })}
${estimate({ title: 'Bid — corridor LVT replacement (summer 2027)', retainage: 0.05, valid: 'current_date + 45',
    notes: 'Work during summer break only. Moisture testing by others.', lines: waukeeEst })}
    perform pm.send_estimate(v_est);
${tasks([{ t: 'Bid due to district facilities', s: 9, d: 9, st: 'TODO', ms: true, who: 'admin' }])}`),
].join('');

