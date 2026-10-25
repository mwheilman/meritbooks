/**
 * QuickBooks (PLT-69). Projects never connects to QuickBooks: Books' QuickBooks Online import is the
 * only path for the books themselves (opening TB, open AR / AP). These recipes read the QuickBooks
 * list exports (customers, vendors, products & services, projects / open jobs) for the operational
 * masters, matched against what Books already brought in.
 */
import type { SourceAdapter } from '../types';
import { recipe } from './recipe';

export const quickbooks: SourceAdapter = {
  id: 'QUICKBOOKS', name: 'QuickBooks', family: 'accounting', fileHints: ['quickbooks', 'qbo', 'qb'], viaBooks: true,
  howToExport: [
    'If Merit Books already imported QuickBooks, your customers, vendors and items are here; skip this.',
    'Otherwise, in QuickBooks Online open Sales → Customers, Expenses → Vendors and Sales → Products and Services, and use the export icon above each list.',
    'Projects: open Projects → Export (each project becomes an open job).',
  ],
  entities: [
    recipe('customer', 'Customers', 'quickbooks-customers.csv', {
      Customer: 'name', 'Company': 'customer_type', Email: 'email', Phone: 'phone', 'Billing Street': 'address_line1', 'Billing City': 'city',
      'Billing State': 'state', 'Billing ZIP': 'zip', 'Open Balance': 'balance_cents',
    }, ['Customer', 'Billing Street', 'Open Balance']),
    recipe('vendor', 'Vendors', 'quickbooks-vendors.csv', {
      Vendor: 'name', Company: 'trade', Email: 'email', Phone: 'phone', 'Billing Street': 'address_line1', 'Billing City': 'city', 'Billing State': 'state', 'Billing ZIP': 'zip',
    }, ['Vendor', 'Billing Street', '1099 Tracking']),
    recipe('cost_item', 'Products and services', 'quickbooks-items.csv', {
      'Product/Service': 'name', SKU: 'code', Type: 'kind', Description: 'description', 'Sales Price/Rate': 'price_cents', Cost: 'cost_cents', Category: 'category',
    }, ['Product/Service', 'Sales Price/Rate', 'Type']),
    recipe('job', 'Projects (open jobs)', 'quickbooks-projects.csv', {
      Project: 'name', Customer: 'customer_name', Status: 'status', 'Start Date': 'start_date', 'Estimated Income': 'contract_cents', 'Project Number': 'external_ref',
    }, ['Project', 'Customer', 'Estimated Income']),
  ],
};
