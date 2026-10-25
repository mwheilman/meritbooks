/**
 * Field-service sources (FS-65, FS-116): ServiceTitan, FieldEdge, simPRO, Housecall Pro, Jobber —
 * customers, locations, equipment, history, open AR, agreements with remaining visits and the
 * deferred balance, price book and employees.
 */
import type { SourceAdapter } from '../types';
import { recipe } from './recipe';

export const servicetitan: SourceAdapter = {
  id: 'SERVICETITAN', name: 'ServiceTitan', family: 'field_service', fileHints: ['servicetitan', 'titan'],
  howToExport: [
    'In ServiceTitan, open Reports and run Customers, Locations, Installed Equipment, Jobs (completed), Open Invoices (AR) and Memberships.',
    'Export each to Excel. For memberships, include "Recurring Services Remaining" and "Deferred Revenue".',
    'Pricebook: Settings → Pricebook → Export. Technicians: Settings → People → Technicians → Export.',
  ],
  entities: [
    recipe('customer', 'Customers', 'servicetitan-customers.csv', {
      'Customer ID': 'external_ref', 'Customer Name': 'name', 'Customer Type': 'customer_type', Email: 'email', Phone: 'phone',
      Street: 'address_line1', City: 'city', State: 'state', Zip: 'zip', Balance: 'balance_cents',
    }, ['Customer ID', 'Customer Name', 'Customer Type', 'Balance']),
    recipe('site', 'Locations', 'servicetitan-locations.csv', {
      'Location ID': 'external_ref', 'Customer ID': 'customer_ref', 'Location Name': 'name', Street: 'address_line1', City: 'city', State: 'state', Zip: 'zip',
    }, ['Location ID', 'Customer ID', 'Location Name', 'Zone']),
    recipe('equipment', 'Installed equipment', 'servicetitan-equipment.csv', {
      'Equipment ID': 'external_ref', 'Customer ID': 'customer_ref', 'Customer Name': 'customer_name', 'Location Address': 'site_address', Type: 'equipment_type',
      Manufacturer: 'make', Model: 'model', 'Serial Number': 'serial_number', 'Install Date': 'installed_on', 'Warranty Expiration': 'warranty_expires_on',
    }, ['Equipment ID', 'Manufacturer', 'Serial Number', 'Install Date', 'Warranty Expiration']),
    recipe('service_history', 'Completed jobs', 'servicetitan-job-history.csv', {
      'Job #': 'external_ref', 'Customer ID': 'customer_ref', 'Customer Name': 'customer_name', 'Completed On': 'date', 'Job Type': 'summary',
      Technician: 'technician', 'Invoice Total': 'total_cents',
    }, ['Job #', 'Completed On', 'Job Type', 'Business Unit', 'Technician']),
    recipe('open_ar', 'Open invoices', 'servicetitan-open-ar.csv', {
      'Invoice #': 'external_ref', 'Customer ID': 'customer_ref', 'Customer Name': 'customer_name', 'Invoice Date': 'invoice_date', 'Due Date': 'due_date',
      Total: 'total_cents', Balance: 'balance_cents', 'Job #': 'job_ref',
    }, ['Invoice #', 'Customer Name', 'Invoice Date', 'Balance']),
    recipe('agreement', 'Memberships', 'servicetitan-memberships.csv', {
      'Membership ID': 'external_ref', 'Customer Name': 'customer_name', 'Membership Type': 'plan_name', From: 'starts_on', To: 'ends_on',
      'Billing Frequency': 'billing_frequency', Price: 'price_cents', 'Recurring Services Remaining': 'visits_remaining', 'Total Services': 'visits_per_term',
      'Deferred Revenue': 'deferred_cents',
    }, ['Membership ID', 'Membership Type', 'From', 'To', 'Recurring Services Remaining']),
    recipe('cost_item', 'Pricebook', 'servicetitan-pricebook.csv', {
      Code: 'code', Name: 'name', Description: 'description', Type: 'kind', Price: 'price_cents', Cost: 'cost_cents', Hours: 'task_hours', Category: 'category',
    }, ['Code', 'Name', 'Member Price', 'Hours', 'Category']),
    recipe('employee', 'Technicians', 'servicetitan-technicians.csv', {
      'Technician ID': 'external_ref', Name: 'name', Email: 'email', 'Mobile Phone': 'phone', 'Business Unit': 'role_hint', Position: 'title',
    }, ['Technician ID', 'Name', 'Mobile Phone', 'Business Unit']),
  ],
};

export const fieldedge: SourceAdapter = {
  id: 'FIELDEDGE', name: 'FieldEdge', family: 'field_service', fileHints: ['fieldedge'],
  howToExport: [
    'In FieldEdge, open Reports → Customer List, Equipment List, Service Agreements, Accounts Receivable, Price Book and Employees.',
    'Export each report to Excel. Service Agreements must include "Visits Remaining" and "Unearned Revenue".',
  ],
  entities: [
    recipe('customer', 'Customer list', 'fieldedge-customers.csv', {
      'Customer Number': 'external_ref', 'Customer Name': 'name', Address: 'address_line1', City: 'city', State: 'state', Zip: 'zip', Phone: 'phone', Email: 'email',
    }, ['Customer Number', 'Customer Name', 'Address']),
    recipe('equipment', 'Equipment list', 'fieldedge-equipment.csv', {
      'Customer Number': 'customer_ref', 'Customer Name': 'customer_name', 'Equipment Type': 'equipment_type', Brand: 'make', 'Model #': 'model',
      'Serial #': 'serial_number', 'Install Date': 'installed_on', 'Warranty Exp': 'warranty_expires_on',
    }, ['Customer Number', 'Equipment Type', 'Brand', 'Serial #']),
    recipe('agreement', 'Service agreements', 'fieldedge-agreements.csv', {
      'Agreement #': 'external_ref', 'Customer Name': 'customer_name', 'Agreement Type': 'plan_name', 'Start Date': 'starts_on', 'Expiration Date': 'ends_on',
      Billing: 'billing_frequency', Price: 'price_cents', 'Visits Included': 'visits_per_term', 'Visits Remaining': 'visits_remaining', 'Unearned Revenue': 'deferred_cents',
    }, ['Agreement #', 'Agreement Type', 'Expiration Date', 'Visits Remaining']),
    recipe('open_ar', 'Accounts receivable', 'fieldedge-ar.csv', {
      'Invoice #': 'external_ref', 'Customer Number': 'customer_ref', 'Customer Name': 'customer_name', 'Invoice Date': 'invoice_date', 'Balance Due': 'balance_cents', 'Invoice Total': 'total_cents',
    }, ['Invoice #', 'Customer Name', 'Balance Due']),
    recipe('cost_item', 'Price book', 'fieldedge-pricebook.csv', {
      'Item Code': 'code', Description: 'name', 'Flat Rate': 'price_cents', Cost: 'cost_cents', Type: 'kind', 'Labor Hours': 'task_hours',
    }, ['Item Code', 'Flat Rate', 'Cost']),
    recipe('employee', 'Employees', 'fieldedge-employees.csv', {
      'Employee Name': 'name', Email: 'email', Mobile: 'phone', Title: 'title', Department: 'role_hint',
    }, ['Employee Name', 'Mobile', 'Title']),
  ],
};

export const simpro: SourceAdapter = {
  id: 'SIMPRO', name: 'simPRO', family: 'field_service', fileHints: ['simpro'],
  howToExport: [
    'In simPRO, open People → Customers, People → Sites, Jobs, Contracts, Catalogue and Employees; use "Export" on each list.',
    'For open AR run Reports → Debtors and export to CSV.',
  ],
  entities: [
    recipe('customer', 'Customers', 'simpro-customers.csv', {
      'Customer ID': 'external_ref', 'Company Name': 'name', Email: 'email', Phone: 'phone', Address: 'address_line1', Suburb: 'city', State: 'state', Postcode: 'zip',
    }, ['Customer ID', 'Company Name', 'Suburb', 'Postcode']),
    recipe('site', 'Sites', 'simpro-sites.csv', {
      'Site ID': 'external_ref', Customer: 'customer_name', 'Site Name': 'name', Address: 'address_line1', Suburb: 'city', State: 'state', Postcode: 'zip',
    }, ['Site ID', 'Site Name', 'Suburb', 'Postcode']),
    recipe('job', 'Jobs', 'simpro-jobs.csv', {
      'Job No': 'external_ref', Customer: 'customer_name', Name: 'name', Stage: 'status', 'Date Issued': 'start_date', 'Total Ex Tax': 'contract_cents', Site: 'site_address',
      'Invoiced Amount': 'billed_to_date_cents',
    }, ['Job No', 'Date Issued', 'Total Ex Tax', 'Stage']),
    recipe('agreement', 'Service contracts', 'simpro-contracts.csv', {
      'Contract No': 'external_ref', Customer: 'customer_name', 'Contract Name': 'plan_name', 'Start Date': 'starts_on', 'End Date': 'ends_on', Price: 'price_cents',
      'Billing Frequency': 'billing_frequency', 'Total Services': 'visits_per_term', 'Remaining Services': 'visits_remaining', 'Deferred Amount': 'deferred_cents',
    }, ['Contract No', 'Contract Name', 'Remaining Services']),
    recipe('cost_item', 'Catalogue', 'simpro-catalogue.csv', {
      'Part Number': 'code', Description: 'name', 'Cost Price': 'cost_cents', 'Sell Price': 'price_cents', Unit: 'unit', Group: 'category',
    }, ['Part Number', 'Cost Price', 'Sell Price']),
    recipe('open_ar', 'Debtors', 'simpro-debtors.csv', {
      'Invoice No': 'external_ref', Customer: 'customer_name', 'Date Issued': 'invoice_date', 'Due Date': 'due_date', 'Amount Owing': 'balance_cents', 'Invoice Total': 'total_cents',
    }, ['Invoice No', 'Amount Owing']),
    recipe('employee', 'Employees', 'simpro-employees.csv', { 'Employee ID': 'external_ref', Name: 'name', Email: 'email', Mobile: 'phone', Position: 'title' }, ['Employee ID', 'Position', 'Mobile']),
  ],
};

export const housecallPro: SourceAdapter = {
  id: 'HOUSECALL_PRO', name: 'Housecall Pro', family: 'field_service', fileHints: ['housecall', 'hcp'],
  howToExport: [
    'In Housecall Pro, open Customers and use "Export customers".',
    'Price book: Settings → Price book → Export. Jobs: Jobs → filter Completed → Export. Service plans: Service plans → Export.',
    'Employees: My employees → Export.',
  ],
  entities: [
    recipe('customer', 'Customers', 'housecallpro-customers.csv', {
      'Display Name': 'name', 'First Name': 'contact_first', 'Last Name': 'contact_last', Company: 'customer_type', Email: 'email', 'Mobile Number': 'phone',
      Street: 'address_line1', City: 'city', State: 'state', Zip: 'zip',
    }, ['Display Name', 'Mobile Number', 'Tags']),
    recipe('cost_item', 'Price book', 'housecallpro-pricebook.csv', {
      Name: 'name', Description: 'description', Price: 'price_cents', Cost: 'cost_cents', 'Unit Of Measure': 'unit', Category: 'category', 'Item Code': 'code',
    }, ['Name', 'Price', 'Unit Of Measure', 'Taxable']),
    recipe('service_history', 'Completed jobs', 'housecallpro-jobs.csv', {
      'Job #': 'external_ref', Customer: 'customer_name', 'Completed Date': 'date', Description: 'summary', 'Assigned Employees': 'technician', 'Total Amount': 'total_cents',
    }, ['Job #', 'Completed Date', 'Assigned Employees']),
    recipe('agreement', 'Service plans', 'housecallpro-service-plans.csv', {
      Customer: 'customer_name', 'Service Plan': 'plan_name', 'Start Date': 'starts_on', 'End Date': 'ends_on', Price: 'price_cents',
      'Billing Frequency': 'billing_frequency', 'Total Visits': 'visits_per_term', 'Visits Remaining': 'visits_remaining', 'Plan ID': 'external_ref',
    }, ['Service Plan', 'Visits Remaining', 'Total Visits']),
    recipe('employee', 'Employees', 'housecallpro-employees.csv', { 'First Name': 'first_name', 'Last Name': 'last_name', Email: 'email', 'Mobile Phone': 'phone', Role: 'title' }, ['First Name', 'Last Name', 'Mobile Phone', 'Role']),
  ],
};

export const jobber: SourceAdapter = {
  id: 'JOBBER', name: 'Jobber', family: 'field_service', fileHints: ['jobber'],
  howToExport: [
    'In Jobber, open Clients → More actions → Export clients (and Export properties).',
    'Products & services: Settings → Products & services → Export. Invoices: Invoices → filter Awaiting payment → Export.',
    'Recurring jobs (agreements): Jobs → filter Recurring → Export. Team: Settings → Manage team → Export.',
  ],
  entities: [
    recipe('customer', 'Clients', 'jobber-clients.csv', {
      'Display Name': 'name', 'First Name': 'contact_first', 'Last Name': 'contact_last', 'Company Name': 'customer_type', 'E-mails': 'email', 'Main Phone #s': 'phone',
      'Billing Street 1': 'address_line1', 'Billing City': 'city', 'Billing Province/State': 'state', 'Billing ZIP/Postal Code': 'zip', Balance: 'balance_cents',
    }, ['Display Name', 'E-mails', 'Main Phone #s', 'Billing Street 1']),
    recipe('site', 'Properties', 'jobber-properties.csv', {
      'Client Name': 'customer_name', 'Street 1': 'address_line1', 'Street 2': 'address_line2', City: 'city', 'Province/State': 'state', 'ZIP/Postal Code': 'zip',
    }, ['Client Name', 'Street 1', 'Province/State']),
    recipe('cost_item', 'Products & services', 'jobber-products.csv', { Name: 'name', Description: 'description', 'Unit Price': 'price_cents', 'Unit Cost': 'cost_cents', Type: 'kind' }, ['Name', 'Unit Price', 'Unit Cost', 'Type']),
    recipe('open_ar', 'Invoices awaiting payment', 'jobber-invoices.csv', {
      'Invoice #': 'external_ref', 'Client Name': 'customer_name', 'Issued Date': 'invoice_date', 'Due Date': 'due_date', Total: 'total_cents', Balance: 'balance_cents',
    }, ['Invoice #', 'Client Name', 'Issued Date', 'Balance']),
    recipe('agreement', 'Recurring jobs', 'jobber-recurring.csv', {
      'Job #': 'external_ref', 'Client Name': 'customer_name', Title: 'plan_name', 'Start Date': 'starts_on', 'End Date': 'ends_on', Total: 'price_cents',
      'Total Visits': 'visits_per_term', 'Visits Remaining': 'visits_remaining', 'Billing Frequency': 'billing_frequency',
    }, ['Job #', 'Client Name', 'Visits Remaining', 'Total Visits']),
    recipe('employee', 'Team', 'jobber-team.csv', { Name: 'name', Email: 'email', Phone: 'phone', Role: 'title' }, ['Name', 'Email', 'Phone', 'Role']),
  ],
};
