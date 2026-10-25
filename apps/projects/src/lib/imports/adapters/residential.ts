/**
 * Residential sources (RES-05): Buildertrend, JobTread, CoConstruct — contacts, cost catalog, open
 * jobs, budgets, POs, selections, change orders and the files / photos list.
 */
import type { SourceAdapter } from '../types';
import { recipe } from './recipe';

export const buildertrend: SourceAdapter = {
  id: 'BUILDERTREND', name: 'Buildertrend', family: 'residential', fileHints: ['buildertrend', 'bt'],
  howToExport: [
    'In Buildertrend, open each list (Customer Contacts, Subs/Vendors, Cost Catalog, Jobs, Purchase Orders, Selections, Change Orders).',
    'Use the "Export" button (top right of the grid) and choose Excel. Keep every column.',
    'For budgets, open Job Costing Budget with "All jobs" and export.',
    'For files and photos, export the Documents list; send the folder zip later and we match it by job.',
  ],
  entities: [
    recipe('customer', 'Customer contacts', 'buildertrend-contacts.csv', {
      'Contact Name': 'name', 'First Name': 'contact_first', 'Last Name': 'contact_last', Email: 'email', Phone: 'phone',
      'Cell Phone': 'phone', 'Street Address': 'address_line1', City: 'city', State: 'state', Zip: 'zip',
    }, ['Contact Name', 'Cell Phone', 'Street Address', 'Jobs']),
    recipe('vendor', 'Subs / vendors', 'buildertrend-subs.csv', {
      'Company Name': 'name', Division: 'trade', 'Primary Contact': 'contact_first', Email: 'email', Phone: 'phone', 'Trade Type': 'kind',
    }, ['Company Name', 'Division', 'Primary Contact', 'Trade Agreement Status']),
    recipe('cost_item', 'Cost catalog', 'buildertrend-cost-catalog.csv', {
      'Cost Code': 'category', Title: 'name', Description: 'description', 'Unit Cost': 'cost_cents', Unit: 'unit', 'Builder Cost': 'cost_cents',
      'Client Price': 'price_cents', 'Cost Type': 'kind', 'Item ID': 'code',
    }, ['Cost Code', 'Title', 'Unit Cost', 'Builder Cost', 'Markup']),
    recipe('job', 'Jobs', 'buildertrend-jobs.csv', {
      'Job Name': 'name', 'Job Number': 'external_ref', 'Owner Name': 'customer_name', 'Owner Email': 'customer_email', 'Owner Phone': 'customer_phone',
      'Street Address': 'site_address', City: 'city', State: 'state', Zip: 'zip', 'Project Type': 'job_type', 'Contract Price': 'contract_cents',
      'Projected Start': 'start_date', 'Job Status': 'status', 'Project Manager': 'project_manager', 'Billed To Date': 'billed_to_date_cents',
      'Deposits Received': 'customer_deposits_cents',
    }, ['Job Name', 'Job Prefix', 'Owner Name', 'Projected Start', 'Projected Completion', 'Job Group', 'Contract Price']),
    recipe('budget', 'Job costing budget', 'buildertrend-budget.csv', {
      'Job Number': 'job_ref', 'Cost Code': 'cost_code', 'Cost Code Title': 'description', 'Cost Type': 'cost_type', 'Revised Budget': 'amount_cents',
    }, ['Job Number', 'Cost Code', 'Cost Code Title', 'Original Budget', 'Revised Budget', 'Actual Costs']),
    recipe('commitment', 'Purchase orders', 'buildertrend-pos.csv', {
      Job: 'job_ref', 'PO #': 'external_ref', Title: 'description', 'Performed By': 'vendor_name', Status: 'status', 'Total Cost': 'amount_cents', Paid: 'billed_cents',
    }, ['Job', 'PO #', 'Performed By', 'Total Cost', 'Paid']),
    recipe('selection', 'Selections', 'buildertrend-selections.csv', {
      Job: 'job_ref', Title: 'name', Category: 'category', Allowance: 'allowance_cents', 'Selected Choice': 'choice', Price: 'selected_price_cents',
      Status: 'status', Deadline: 'due_date',
    }, ['Job', 'Title', 'Category', 'Allowance', 'Selected Choice', 'Deadline']),
    recipe('change_order', 'Change orders', 'buildertrend-change-orders.csv', {
      Job: 'job_ref', 'ID #': 'external_ref', Title: 'title', 'Owner Price': 'amount_cents', 'Approval Status': 'status', 'Approved Date': 'date',
    }, ['Job', 'ID #', 'Owner Price', 'Approval Status']),
    recipe('file', 'Documents and photos list', 'buildertrend-files.csv', {
      Job: 'job_ref', Folder: 'path', 'File Name': 'file_name', 'Date Uploaded': 'taken_at', 'File Type': 'kind',
    }, ['Job', 'Folder', 'File Name', 'Date Uploaded']),
  ],
};

export const jobtread: SourceAdapter = {
  id: 'JOBTREAD', name: 'JobTread', family: 'residential', fileHints: ['jobtread'],
  howToExport: [
    'In JobTread, open Customers, Vendors, Jobs and the Cost Catalog; use the column menu → "Download CSV".',
    'For budgets, open Reports → Budget vs Actual for all jobs and download the CSV.',
  ],
  entities: [
    recipe('customer', 'Customers', 'jobtread-customers.csv', {
      'Account Name': 'name', 'Primary Contact': 'contact_first', Email: 'email', Phone: 'phone', Address: 'address_line1', City: 'city', State: 'state', Zip: 'zip', 'Account Type': 'customer_type',
    }, ['Account Name', 'Account Type', 'Primary Contact']),
    recipe('vendor', 'Vendors', 'jobtread-vendors.csv', { 'Vendor Name': 'name', Email: 'email', Phone: 'phone', Type: 'kind' }, ['Vendor Name', 'Type']),
    recipe('job', 'Jobs', 'jobtread-jobs.csv', {
      'Job Number': 'external_ref', 'Job Name': 'name', 'Customer Name': 'customer_name', 'Location Address': 'site_address', 'Job Stage': 'status',
      Price: 'contract_cents', Cost: 'estimated_cost_cents', Billed: 'billed_to_date_cents', 'Created Date': 'start_date',
    }, ['Job Number', 'Job Name', 'Customer Name', 'Location Name', 'Location Address', 'Job Stage', 'Price']),
    recipe('cost_item', 'Cost catalog', 'jobtread-catalog.csv', {
      'Cost Item': 'name', 'Cost Code': 'category', 'Cost Type': 'kind', Unit: 'unit', 'Unit Cost': 'cost_cents', 'Unit Price': 'price_cents', Description: 'description', 'Item ID': 'code',
    }, ['Cost Item', 'Cost Code', 'Cost Type', 'Unit Cost', 'Unit Price']),
    recipe('budget', 'Budget', 'jobtread-budget.csv', {
      'Job Number': 'job_ref', 'Cost Code': 'cost_code', 'Cost Item': 'description', 'Cost Type': 'cost_type', 'Extended Cost': 'amount_cents',
    }, ['Job Number', 'Cost Group', 'Cost Code', 'Cost Item', 'Extended Cost']),
  ],
};

export const coconstruct: SourceAdapter = {
  id: 'COCONSTRUCT', name: 'CoConstruct', family: 'residential', fileHints: ['coconstruct'],
  howToExport: [
    'In CoConstruct, open Contacts, Projects, Selections and Change Orders; use "Export to Excel" on each list.',
    'For budgets, open the project’s Specs & Selections → Bids and export the cost breakdown.',
  ],
  entities: [
    recipe('customer', 'Clients', 'coconstruct-clients.csv', {
      'Client Name': 'name', 'Primary Email': 'email', 'Primary Phone': 'phone', Address: 'address_line1', City: 'city', State: 'state', Zip: 'zip',
    }, ['Client Name', 'Primary Email', 'Primary Phone']),
    recipe('job', 'Projects', 'coconstruct-projects.csv', {
      'Project ID': 'external_ref', 'Project Name': 'name', Client: 'customer_name', Status: 'status', 'Contract Amount': 'contract_cents',
      'Start Date': 'start_date', Address: 'site_address', 'Billed To Date': 'billed_to_date_cents',
    }, ['Project ID', 'Project Name', 'Client', 'Contract Amount']),
    recipe('selection', 'Selections', 'coconstruct-selections.csv', {
      Project: 'job_ref', Category: 'category', Selection: 'name', Allowance: 'allowance_cents', Choice: 'choice', Price: 'selected_price_cents', Status: 'status', 'Due Date': 'due_date',
    }, ['Project', 'Category', 'Selection', 'Allowance', 'Choice']),
    recipe('change_order', 'Change orders', 'coconstruct-change-orders.csv', {
      Project: 'job_ref', 'Change Order #': 'external_ref', Title: 'title', 'Client Price': 'amount_cents', Status: 'status', 'Approved On': 'date',
    }, ['Project', 'Change Order #', 'Client Price']),
    recipe('budget', 'Cost breakdown', 'coconstruct-budget.csv', {
      Project: 'job_ref', 'Cost Code': 'cost_code', Description: 'description', 'Estimated Cost': 'amount_cents',
    }, ['Project', 'Cost Code', 'Description', 'Estimated Cost']),
  ],
};
