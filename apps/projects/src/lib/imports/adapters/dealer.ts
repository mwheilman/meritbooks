/**
 * c-Systems Infinity (DLR-81). No documented API (research 09): the dealer runs these report
 * extracts — customers, units with cost and floor-plan lender, parts with bins and on hand, open
 * ROs, special orders with deposits, open warranty claims, rental fleet and open contracts, service
 * history — and the unit-by-unit tie-out runs against Books' units and floor-plan notes.
 */
import type { SourceAdapter } from '../types';
import { recipe } from './recipe';

export const csystems: SourceAdapter = {
  id: 'CSYSTEMS', name: 'c-Systems Infinity', family: 'dealer', fileHints: ['csystems', 'csys', 'infinity'],
  howToExport: [
    'In c-Systems Infinity, run each report from Reports → Export to Excel: Customer Master, Whole Goods Inventory (with floor plan), Parts Inventory (with bins), Open Repair Orders, Special Orders, Warranty Claims (open), Rental Fleet, Open Rental Contracts and Service History.',
    'Run them on the cut-over date, after the day is closed, so units and parts tie to the lender statement and Books.',
    'If a report has a title block above the columns, leave it; we find the header row.',
  ],
  entities: [
    recipe('customer', 'Customer master', 'csystems-customers.csv', {
      'Cust #': 'external_ref', 'Customer Name': 'name', 'Address 1': 'address_line1', City: 'city', State: 'state', Zip: 'zip', Phone: 'phone', Email: 'email',
    }, ['Cust #', 'Customer Name', 'Address 1']),
    recipe('unit', 'Whole goods inventory', 'csystems-units.csv', {
      'Stock #': 'stock_number', 'Serial #': 'serial_number', Make: 'make', Model: 'model', Year: 'model_year', 'N/U': 'condition', Status: 'unit_status',
      'Date Recv': 'received_on', Cost: 'cost_cents', List: 'list_price_cents', 'Flr Plan Co': 'floor_lender', 'Flr Plan #': 'floor_note_ref',
      'Flr Date': 'floored_on', 'Flr Bal': 'floor_balance_cents', Hours: 'hours', Desc: 'description', Category: 'category',
    }, ['Stock #', 'Serial #', 'N/U', 'Flr Plan Co', 'Flr Bal']),
    recipe('part', 'Parts inventory', 'csystems-parts.csv', {
      Line: 'manufacturer', 'Part #': 'part_number', Desc: 'description', Bin: 'bin', OH: 'on_hand', 'Avg Cost': 'cost_cents', Sell: 'price_cents', List: 'list_price_cents', UM: 'uom', Class: 'category',
    }, ['Line', 'Part #', 'Bin', 'OH', 'Avg Cost']),
    recipe('repair_order', 'Open repair orders', 'csystems-open-ros.csv', {
      'RO #': 'external_ref', 'Cust #': 'customer_ref', 'Customer Name': 'customer_name', 'Serial #': 'unit_serial', 'Date In': 'opened_on', 'RO Status': 'status',
      Complaint: 'complaint', Labor: 'labor_cents', Parts: 'parts_cents', Total: 'total_cents',
    }, ['RO #', 'Date In', 'RO Status', 'Complaint']),
    recipe('special_order', 'Special orders', 'csystems-special-orders.csv', {
      'SO #': 'external_ref', 'Cust #': 'customer_ref', 'Customer Name': 'customer_name', 'Part #': 'part_number', Qty: 'qty', Deposit: 'deposit_cents', 'Ord Date': 'ordered_on', Status: 'status',
    }, ['SO #', 'Part #', 'Deposit', 'Ord Date']),
    recipe('warranty_claim', 'Open warranty claims', 'csystems-warranty.csv', {
      'Claim #': 'external_ref', 'Serial #': 'unit_serial', 'Customer Name': 'customer_name', Mfg: 'manufacturer', 'Claim Date': 'submitted_on', 'Claim Status': 'status', 'Claim Amt': 'amount_cents',
    }, ['Claim #', 'Mfg', 'Claim Status', 'Claim Amt']),
    recipe('rental_unit', 'Rental fleet', 'csystems-rental-fleet.csv', {
      'Stock #': 'stock_number', 'Serial #': 'serial_number', Make: 'make', Model: 'model', Year: 'model_year', 'Fleet Cost': 'cost_cents', Hours: 'hours', 'Fleet Status': 'unit_status', 'Date Recv': 'received_on',
    }, ['Stock #', 'Serial #', 'Fleet Cost', 'Fleet Status']),
    recipe('rental_contract', 'Open rental contracts', 'csystems-rental-contracts.csv', {
      'Contract #': 'external_ref', 'Cust #': 'customer_ref', 'Customer Name': 'customer_name', 'Serial #': 'unit_serial', 'Date Out': 'starts_on', 'Due In': 'due_on',
      Rate: 'rate_cents', Deposit: 'deposit_cents', Status: 'status',
    }, ['Contract #', 'Date Out', 'Due In', 'Rate']),
    recipe('service_history', 'Service history', 'csystems-service-history.csv', {
      'RO #': 'external_ref', 'Cust #': 'customer_ref', 'Customer Name': 'customer_name', 'Serial #': 'unit_serial', 'Date Closed': 'date',
      'Work Performed': 'summary', Tech: 'technician', Total: 'total_cents',
    }, ['RO #', 'Date Closed', 'Work Performed', 'Tech']),
  ],
};
