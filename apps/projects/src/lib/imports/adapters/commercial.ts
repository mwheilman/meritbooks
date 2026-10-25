/**
 * Commercial mid-stream jobs (CGC-08, PLT-70, RED-44): Procore exports and the Merit Excel WIP
 * template — contract, approved COs, billed to date per SOV line, cost to date, retainage held /
 * payable, open commitments.
 */
import type { SourceAdapter } from '../types';
import { recipe } from './recipe';

export const procore: SourceAdapter = {
  id: 'PROCORE', name: 'Procore', family: 'commercial', fileHints: ['procore'],
  howToExport: [
    'In Procore (company level), open Reports → Prime Contracts and export "Project", "Original Contract Amount", "Approved Change Orders", "Revised Contract Amount", "Total Completed & Stored to Date" and "Retainage".',
    'Per project: Budget → Export (CSV) with "Job to Date Costs"; Prime Contract → Schedule of Values → Export; Commitments → Export.',
    'Add the Project Number column to each export so lines match their job.',
  ],
  entities: [
    recipe('job', 'Prime contracts (mid-stream jobs)', 'procore-prime-contracts.csv', {
      'Project Number': 'external_ref', 'Project Name': 'name', 'Owner/Client': 'customer_name', 'Original Contract Amount': 'original_contract_cents',
      'Approved Change Orders': 'approved_co_cents', 'Revised Contract Amount': 'contract_cents', 'Total Completed & Stored to Date': 'billed_to_date_cents',
      Retainage: 'retainage_receivable_cents', 'Job to Date Costs': 'cost_to_date_cents', 'Projected Cost': 'estimated_cost_cents', 'Committed Costs': 'open_commitments_cents',
      'Last Payment Application': 'last_pay_app_number', Status: 'status', 'Start Date': 'start_date', Address: 'site_address',
    }, ['Project Number', 'Owner/Client', 'Original Contract Amount', 'Revised Contract Amount', 'Total Completed & Stored to Date']),
    recipe('budget', 'Budget', 'procore-budget.csv', {
      'Project Number': 'job_ref', 'Cost Code': 'cost_code', Description: 'description', 'Revised Budget': 'amount_cents', 'Cost Type': 'cost_type',
    }, ['Project Number', 'Cost Code', 'Original Budget Amount', 'Revised Budget', 'Job to Date Costs']),
    recipe('sov_line', 'Prime contract schedule of values', 'procore-sov.csv', {
      'Project Number': 'job_ref', 'Item No': 'line_no', 'Cost Code': 'cost_code', 'Description of Work': 'description', 'Scheduled Value': 'scheduled_value_cents',
      'Materials Presently Stored': 'stored_materials_cents', 'Total Completed and Stored to Date': 'billed_to_date_cents', Retainage: 'retainage_cents',
    }, ['Item No', 'Description of Work', 'Scheduled Value', 'Total Completed and Stored to Date']),
    recipe('commitment', 'Commitments', 'procore-commitments.csv', {
      'Project Number': 'job_ref', Number: 'external_ref', Title: 'description', Vendor: 'vendor_name', Type: 'commitment_type', Status: 'status',
      'Revised Contract Amount': 'amount_cents', 'Billed to Date': 'billed_cents', Retainage: 'retainage_held_cents',
    }, ['Number', 'Vendor', 'Type', 'Revised Contract Amount', 'Billed to Date']),
    recipe('vendor', 'Company directory (vendors)', 'procore-directory.csv', {
      Company: 'name', 'Primary Contact': 'contact_first', Email: 'email', 'Business Phone': 'phone', Trade: 'trade', 'Vendor Type': 'kind',
    }, ['Company', 'Business Phone', 'Trade', 'Vendor Type']),
  ],
};

export const excel: SourceAdapter = {
  id: 'EXCEL', name: 'Excel (Merit templates)', family: 'generic', fileHints: ['merit template', 'merittemplate', 'wip'],
  howToExport: [
    'Download the Merit template for what you are bringing (Open jobs / WIP, Schedule of values, Commitments, Customers, Vendors).',
    'Fill one row per job (or line). Money in dollars; dates as you normally write them.',
    'Your own spreadsheet works too: we match the columns and ask only about the ones we are not sure of.',
  ],
  entities: [
    recipe('job', 'Open jobs / WIP template', 'excel-wip.csv', {
      'Job Number': 'external_ref', 'Job Name': 'name', Customer: 'customer_name', 'Job Type': 'job_type', Status: 'status',
      'Original Contract': 'original_contract_cents', 'Approved COs': 'approved_co_cents', 'Revised Contract': 'contract_cents',
      'Estimated Cost': 'estimated_cost_cents', 'Cost to Date': 'cost_to_date_cents', 'Billed to Date': 'billed_to_date_cents',
      'Retainage Held': 'retainage_receivable_cents', 'Retainage Payable': 'retainage_payable_cents', 'Deposits Held': 'customer_deposits_cents',
      'Open Commitments': 'open_commitments_cents', '% Complete': 'pct_complete', 'Last Pay App #': 'last_pay_app_number', 'Start Date': 'start_date',
    }, ['Job Number', 'Original Contract', 'Revised Contract', 'Cost to Date', 'Billed to Date', 'Retainage Held']),
    recipe('sov_line', 'Schedule of values template', 'excel-sov.csv', {
      'Job Number': 'job_ref', Line: 'line_no', Description: 'description', 'Cost Code': 'cost_code', 'Scheduled Value': 'scheduled_value_cents',
      'Billed to Date': 'billed_to_date_cents', 'Stored Materials': 'stored_materials_cents', Retainage: 'retainage_cents',
    }, ['Job Number', 'Line', 'Scheduled Value', 'Billed to Date']),
    recipe('deposit', 'Customer deposits template', 'excel-deposits.csv', {
      Customer: 'customer_name', 'Job Number': 'job_ref', Reference: 'external_ref', 'Amount Held': 'amount_cents', Received: 'received_on',
    }, ['Customer', 'Amount Held', 'Reference']),
  ],
};
