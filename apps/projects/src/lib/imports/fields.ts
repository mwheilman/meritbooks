/**
 * Canonical target fields per import entity (the keys the 1121 commit functions read from
 * pm.import_rows.data). Aliases are normalized headers (lib/onboarding/import/automap normHeader:
 * lowercase, "#" → "number", punctuation → space) and are ordinary words — vendor-specific
 * headers live in the adapters (./adapters). Pure.
 */
import type { Disposition, EntityDef, EnumOption, ImportEntity, TargetField } from './types';

const f = (key: string, label: string, type: TargetField['type'], aliases: string[], extra: Partial<TargetField> = {}): TargetField =>
  ({ key, label, type, aliases, ...extra });
const req = { required: true } as const;

const opts = (...pairs: Array<[string, string[]]>): EnumOption[] => pairs.map(([value, synonyms]) => ({ value, synonyms }));

// ------------------------------------------------------------------ shared building blocks
const REF = (label: string, aliases: string[]) => f('external_ref', label, 'text', aliases, { max: 200 });
const CUSTOMER_LINK: TargetField[] = [
  f('customer_ref', 'Customer ID (from the customer file)', 'text', ['customer id', 'customer number', 'customer no', 'client id', 'account number', 'customer code']),
  f('customer_name', 'Customer', 'text', ['customer name', 'customer', 'client name', 'client', 'owner name', 'homeowner', 'account name', 'bill to', 'sold to']),
];
const ADDRESS: TargetField[] = [
  f('address_line1', 'Street address', 'text', ['address line 1', 'address 1', 'street address', 'street', 'address', 'billing address', 'service address']),
  f('address_line2', 'Address line 2', 'text', ['address line 2', 'address 2', 'suite', 'unit', 'apt']),
  f('city', 'City', 'text', ['city', 'town']),
  f('state', 'State', 'text', ['state', 'province', 'st']),
  f('zip', 'ZIP', 'text', ['zip', 'zip code', 'postal code', 'postcode', 'zipcode']),
];
const JOB_LINK = f('job_ref', 'Job number', 'text', ['job number', 'job no', 'job id', 'project number', 'project id', 'job', 'project', 'job code'], req);

const STATUS_OPTIONS = opts(
  ['bid', ['bid', 'bidding', 'estimate', 'estimating', 'lead', 'quote', 'quoted', 'proposal', 'pending', 'presale', 'pre sale', 'prospect', 'opportunity', 'draft']],
  ['active', ['active', 'open', 'in progress', 'progress', 'wip', 'scheduled', 'started', 'not started', 'sold', 'approved', 'underway', 'under construction', 'course of construction', 'construction', 'substantial completion', 'punch list', 'production', 'in production', 'signed', 'contracted', 'ready']],
  ['on_hold', ['hold', 'on hold', 'paused', 'suspended', 'waiting']],
  ['complete', ['complete', 'completed', 'closed', 'finished', 'done', 'invoiced', 'paid', 'archived', 'warranty']],
  ['cancelled', ['cancelled', 'canceled', 'cancel', 'void', 'lost', 'dead', 'declined', 'rejected', 'abandoned']],
);

// ------------------------------------------------------------------ entities
const UNIT_FIELDS: readonly TargetField[] = [
      f('serial_number', 'Serial number', 'text', ['serial number', 'serial', 'sn', 'serial no'], req),
      f('stock_number', 'Stock number', 'text', ['stock number', 'stock no', 'stk number', 'unit number']),
      f('vin', 'VIN / PIN', 'text', ['vin', 'pin', 'hin', 'product id']),
      f('make', 'Make', 'text', ['make', 'manufacturer', 'mfr', 'brand', 'line']),
      f('model', 'Model', 'text', ['model', 'model number']),
      f('model_year', 'Year', 'int', ['year', 'model year']),
      f('category', 'Category', 'text', ['category', 'unit type', 'class', 'group']),
      f('condition', 'New / used', 'enum', ['condition', 'new used', 'n u', 'inventory type'], {
        options: opts(['NEW', ['new', 'n']], ['USED', ['used', 'u', 'pre owned', 'trade']], ['DEMO', ['demo', 'demonstrator', 'd']], ['RENTAL', ['rental', 'rent', 'r', 'rental fleet']]),
      }),
      f('unit_status', 'Status', 'enum', ['status', 'unit status', 'stock status'], {
        options: opts(['IN_STOCK', ['in stock', 'stock', 'on hand', 'available', 'instock']], ['IN_TRANSIT', ['in transit', 'transit', 'shipped']], ['ON_ORDER', ['on order', 'ordered']], ['DEMO', ['demo']], ['RENTAL', ['rental', 'on rent']], ['ON_HOLD', ['hold', 'on hold', 'sold pending']]),
      }),
      f('received_on', 'Received', 'date', ['received date', 'received', 'date received', 'stock date', 'in stock date']),
      f('cost_cents', 'Cost', 'money', ['cost', 'unit cost', 'total cost', 'inventory cost', 'dealer cost', 'net cost'], req),
      f('list_price_cents', 'List price', 'money', ['list price', 'msrp', 'retail', 'retail price', 'list']),
      f('floor_lender', 'Floor-plan lender', 'text', ['floor plan lender', 'flooring company', 'lender', 'floor plan', 'flooring source']),
      f('floor_note_ref', 'Floor-plan note number', 'text', ['floor plan number', 'lender invoice number', 'flooring number', 'note number', 'floor number']),
      f('floored_on', 'Floored on', 'date', ['floored date', 'floor date', 'financed date', 'date floored']),
      f('floor_balance_cents', 'Floor-plan balance', 'money', ['floor plan balance', 'flooring balance', 'principal balance', 'curr bal', 'current balance', 'payoff', 'balance']),
      f('hours', 'Hour meter', 'number', ['hours', 'hour meter', 'meter']),
      f('description', 'Description', 'text', ['description', 'desc']),
];

export const ENTITY_DEFS: Readonly<Record<ImportEntity, EntityDef>> = {
  customer: {
    entity: 'customer', label: 'Customers', plural: 'customers', disposition: 'RECORD',
    effect: 'Matched to your customer list first; new ones are added with their site and contact.',
    fields: [
      REF('Customer ID', ['customer id', 'customer number', 'customer no', 'client id', 'account number', 'id', 'customer code']),
      f('name', 'Customer name', 'text', ['customer name', 'client name', 'company name', 'full name', 'display name', 'name', 'customer', 'client', 'account name'], req),
      f('email', 'Email', 'email', ['email address', 'email', 'e mail', 'primary email']),
      f('phone', 'Phone', 'phone', ['phone number', 'phone', 'mobile', 'cell', 'primary phone', 'telephone', 'mobile phone']),
      ...ADDRESS,
      f('contact_first', 'Contact first name', 'text', ['first name', 'contact first name', 'first']),
      f('contact_last', 'Contact last name', 'text', ['last name', 'contact last name', 'last', 'surname']),
      f('balance_cents', 'Open balance', 'signed_money', ['balance', 'open balance', 'balance due', 'ar balance']),
      f('customer_type', 'Customer type', 'text', ['customer type', 'type', 'client type']),
    ],
  },
  vendor: {
    entity: 'vendor', label: 'Vendors and subs', plural: 'vendors', disposition: 'RECORD',
    effect: 'Matched to your vendor list first; new ones are added and Books asks them for a W-9 and COI.',
    fields: [
      REF('Vendor ID', ['vendor id', 'vendor number', 'sub id', 'supplier id', 'id']),
      f('name', 'Vendor name', 'text', ['vendor name', 'company name', 'subcontractor', 'supplier', 'vendor', 'name', 'company'], req),
      f('email', 'Email', 'email', ['email address', 'email']),
      f('phone', 'Phone', 'phone', ['phone number', 'phone', 'mobile', 'cell']),
      f('kind', 'Kind', 'enum', ['vendor type', 'type', 'kind', 'category'], {
        options: opts(['SUBCONTRACTOR', ['sub', 'subcontractor', 'trade partner', 'trade', 'contractor']], ['SUPPLIER', ['supplier', 'vendor', 'material', 'materials', 'distributor', 'manufacturer']], ['OTHER', ['other', 'service', 'lender']]),
      }),
      f('trade', 'Trade', 'text', ['trade', 'division', 'specialty']),
      f('contact_first', 'Contact first name', 'text', ['first name', 'contact first name']),
      f('contact_last', 'Contact last name', 'text', ['last name', 'contact last name']),
      ...ADDRESS,
    ],
  },
  contact: {
    entity: 'contact', label: 'Contacts', plural: 'contacts', disposition: 'RECORD',
    effect: 'Added to their customer or vendor; the same person is never added twice.',
    fields: [
      REF('Contact ID', ['contact id', 'id']),
      ...CUSTOMER_LINK,
      f('vendor_name', 'Vendor', 'text', ['vendor name', 'vendor', 'company']),
      f('first_name', 'First name', 'text', ['first name', 'first', 'given name']),
      f('last_name', 'Last name', 'text', ['last name', 'last', 'surname']),
      f('email', 'Email', 'email', ['email address', 'email']),
      f('phone', 'Phone', 'phone', ['phone number', 'phone', 'mobile', 'cell']),
      f('title', 'Title', 'text', ['title', 'job title', 'role']),
      f('is_primary', 'Primary contact', 'bool', ['primary', 'is primary', 'primary contact']),
    ],
  },
  site: {
    entity: 'site', label: 'Service locations', plural: 'locations', disposition: 'RECORD',
    effect: 'Added to their customer (the same address is matched, not repeated).',
    fields: [
      REF('Location ID', ['location id', 'site id', 'location number']),
      ...CUSTOMER_LINK,
      f('name', 'Location name', 'text', ['location name', 'site name', 'location', 'site']),
      { ...ADDRESS[0], required: true }, ADDRESS[1], ADDRESS[2], ADDRESS[3], ADDRESS[4],
      f('access_notes', 'Access notes', 'text', ['access notes', 'gate code', 'notes', 'instructions', 'location notes']),
    ],
  },
  employee: {
    entity: 'employee', label: 'Employees', plural: 'people', disposition: 'ROSTER',
    effect: 'Pre-filled on the "Bring your crew" step; nothing changes in payroll.',
    fields: [
      REF('Employee ID', ['employee id', 'employee number', 'technician id', 'id']),
      f('name', 'Full name', 'text', ['full name', 'name', 'employee name', 'technician name', 'technician']),
      f('first_name', 'First name', 'text', ['first name', 'first']),
      f('last_name', 'Last name', 'text', ['last name', 'last']),
      f('email', 'Email', 'email', ['email address', 'email', 'work email']),
      f('phone', 'Mobile', 'phone', ['mobile phone', 'mobile', 'cell', 'phone', 'phone number']),
      f('title', 'Title', 'text', ['title', 'job title', 'position', 'role']),
      f('role_hint', 'Role or team', 'text', ['team', 'department', 'business unit', 'role type', 'employee type']),
    ],
  },
  cost_item: {
    entity: 'cost_item', label: 'Price book and cost catalog', plural: 'items', disposition: 'RECORD',
    effect: 'Added to the price book by code; an existing code is updated, not duplicated.',
    fields: [
      f('code', 'Code', 'text', ['item code', 'code', 'sku', 'item number', 'part number', 'service code', 'item id'], { max: 24 }),
      f('name', 'Name', 'text', ['item name', 'name', 'service name', 'title', 'item'], req),
      f('description', 'Description', 'text', ['description', 'customer description', 'details']),
      f('kind', 'Kind', 'enum', ['type', 'item type', 'kind', 'cost type'], {
        options: opts(['SERVICE', ['service', 'labor', 'task', 'flat rate', 'subcontractor', 'subcontract', 'sub']], ['MATERIAL', ['material', 'materials', 'part', 'inventory', 'non inventory', 'product']],
          ['EQUIPMENT', ['equipment', 'unit', 'system']], ['FEE', ['fee', 'charge', 'other charge', 'other']]),
      }),
      f('unit', 'Unit', 'text', ['unit', 'uom', 'unit of measure', 'units']),
      f('cost_cents', 'Unit cost', 'money', ['unit cost', 'cost', 'item cost', 'purchase cost', 'builder cost']),
      f('price_cents', 'Price', 'money', ['unit price', 'price', 'sales price', 'selling price', 'rate', 'client price', 'member price']),
      f('task_hours', 'Hours', 'number', ['hours', 'labor hours', 'task hours', 'duration hours']),
      f('category', 'Category', 'text', ['category', 'group', 'cost group', 'cost code']),
    ],
  },
  job: {
    entity: 'job', label: 'Open jobs', plural: 'jobs', disposition: 'RECORD',
    effect: 'Each open job is created with its customer, contract and (for jobs under way) the opening position for Books.',
    fields: [
      REF('Job number', ['job number', 'job no', 'job id', 'project number', 'project no', 'project id', 'job code', 'number', 'job']),
      f('name', 'Job name', 'text', ['job name', 'project name', 'job title', 'project title', 'name', 'title', 'project', 'description'], req),
      ...CUSTOMER_LINK,
      f('customer_email', 'Customer email', 'email', ['customer email', 'client email', 'owner email', 'email']),
      f('customer_phone', 'Customer phone', 'phone', ['customer phone', 'client phone', 'owner phone', 'phone']),
      f('job_type', 'Job type', 'text', ['job type', 'project type', 'work type', 'type', 'category', 'division', 'business unit']),
      f('status', 'Status', 'enum', ['job status', 'project status', 'status', 'stage', 'phase'], { options: STATUS_OPTIONS }),
      f('start_date', 'Start date', 'date', ['start date', 'projected start', 'actual start', 'scheduled start', 'contract date', 'start', 'created date']),
      f('site_address', 'Job address', 'text', ['job address', 'site address', 'jobsite address', 'project address', 'street address', 'address']),
      f('city', 'City', 'text', ['job city', 'city']),
      f('state', 'State', 'text', ['job state', 'state']),
      f('zip', 'ZIP', 'text', ['job zip', 'zip', 'zip code', 'postal code']),
      f('original_contract_cents', 'Original contract', 'money', ['original contract', 'original contract amount', 'base contract', 'original contract value']),
      f('approved_co_cents', 'Approved change orders', 'signed_money', ['approved change orders', 'approved cos', 'change orders', 'approved co amount', 'co total']),
      f('contract_cents', 'Contract (with approved COs)', 'money', ['revised contract', 'revised contract amount', 'current contract', 'contract amount', 'contract price', 'contract value', 'contract total', 'contract', 'price', 'total']),
      f('estimated_cost_cents', 'Estimated cost at completion', 'money', ['estimated cost', 'estimated cost at completion', 'eac', 'projected cost', 'revised budget', 'budget', 'cost budget', 'total budget']),
      f('cost_to_date_cents', 'Cost to date', 'money', ['cost to date', 'costs to date', 'actual cost', 'job cost to date', 'jtd cost', 'actual costs']),
      f('billed_to_date_cents', 'Billed to date', 'money', ['billed to date', 'billed', 'invoiced to date', 'invoiced', 'billings to date', 'total billed']),
      f('retainage_receivable_cents', 'Retainage held by owner', 'money', ['retainage held', 'retainage receivable', 'retention receivable', 'retainage', 'retention']),
      f('retainage_payable_cents', 'Retainage held from subs', 'money', ['retainage payable', 'sub retainage', 'retention payable', 'retainage withheld']),
      f('customer_deposits_cents', 'Customer deposits held', 'money', ['deposits held', 'customer deposits', 'deposit', 'deposits', 'unapplied deposits']),
      f('open_commitments_cents', 'Open commitments', 'money', ['open commitments', 'committed cost', 'open pos', 'committed remaining', 'commitments']),
      f('commitments_billed_cents', 'Commitments billed to date', 'money', ['commitments billed', 'sub billed to date', 'po billed']),
      f('pct_complete', 'Percent complete', 'percent', ['percent complete', 'pct complete', 'number complete', 'complete', 'completion']),
      f('last_pay_app_number', 'Last pay app number', 'int', ['last pay app', 'last pay app number', 'pay app number', 'last application', 'application number']),
      f('project_manager', 'Project manager', 'text', ['project manager', 'pm', 'manager', 'salesperson']),
    ],
  },
  budget: {
    entity: 'budget', label: 'Budgets by cost code', plural: 'budget lines', disposition: 'RECORD',
    effect: 'Added as each job’s original budget (draft) by cost code.',
    fields: [
      JOB_LINK,
      f('cost_code', 'Cost code', 'text', ['cost code', 'code', 'cost item', 'phase code', 'budget code', 'cost group'], req),
      f('cost_type', 'Cost type', 'enum', ['cost type', 'type'], {
        options: opts(['LABOR', ['labor', 'l']], ['MATERIALS', ['material', 'materials', 'm']], ['SUBCONTRACTOR', ['sub', 'subcontractor', 'subcontract', 's']], ['EQUIPMENT', ['equipment', 'e']], ['OTHER', ['other', 'o']]),
      }),
      f('description', 'Description', 'text', ['description', 'name', 'item']),
      f('amount_cents', 'Budget amount', 'money', ['budget amount', 'revised budget', 'budget', 'amount', 'estimated cost', 'builder cost', 'total cost'], req),
    ],
  },
  sov_line: {
    entity: 'sov_line', label: 'Schedule of values', plural: 'SOV lines', disposition: 'RECORD',
    effect: 'Added as the job’s draft schedule of values; billed to date per line goes to the opening position.',
    fields: [
      JOB_LINK,
      f('line_no', 'Line number', 'int', ['line number', 'line', 'item number', 'item no', 'line no']),
      f('description', 'Description', 'text', ['description of work', 'description', 'item', 'name'], req),
      f('cost_code', 'Cost code', 'text', ['cost code', 'code']),
      f('scheduled_value_cents', 'Scheduled value', 'money', ['scheduled value', 'revised scheduled value', 'value', 'amount'], req),
      f('billed_to_date_cents', 'Billed to date', 'money', ['total completed and stored to date', 'completed to date', 'billed to date', 'work completed', 'total billed']),
      f('stored_materials_cents', 'Stored materials', 'money', ['materials presently stored', 'stored materials', 'stored']),
      f('retainage_cents', 'Retainage', 'money', ['retainage', 'retention']),
    ],
  },
  commitment: {
    entity: 'commitment', label: 'Purchase orders and subcontracts', plural: 'commitments', disposition: 'REFERENCE',
    effect: 'The sub or supplier joins your vendor list; open amounts go to the job’s opening position.',
    fields: [
      JOB_LINK,
      REF('Commitment number', ['po number', 'commitment number', 'subcontract number', 'contract number', 'number', 'po']),
      f('vendor_name', 'Vendor', 'text', ['vendor', 'vendor name', 'subcontractor', 'supplier', 'company'], req),
      f('commitment_type', 'Type', 'enum', ['type', 'commitment type'], { options: opts(['PO', ['po', 'purchase order', 'material']], ['SUBCONTRACT', ['subcontract', 'sub', 'work order', 'contract']]) }),
      f('description', 'Description', 'text', ['description', 'title', 'scope']),
      f('amount_cents', 'Amount (revised)', 'money', ['revised amount', 'amount', 'total', 'contract amount', 'original amount', 'po total'], req),
      f('billed_cents', 'Billed to date', 'money', ['billed to date', 'invoiced', 'billed', 'paid to date']),
      f('retainage_held_cents', 'Retainage held', 'money', ['retainage held', 'retainage', 'retention']),
      f('status', 'Status', 'text', ['status']),
    ],
  },
  change_order: {
    entity: 'change_order', label: 'Change orders', plural: 'change orders', disposition: 'REFERENCE',
    effect: 'Kept with the job; approved totals feed the opening contract.',
    fields: [
      JOB_LINK,
      REF('CO number', ['co number', 'change order number', 'number', 'co']),
      f('title', 'Title', 'text', ['title', 'description', 'name']),
      f('amount_cents', 'Amount', 'signed_money', ['amount', 'price', 'total', 'co amount', 'client price'], req),
      f('status', 'Status', 'text', ['status', 'approval status']),
      f('date', 'Date', 'date', ['approved date', 'date', 'created date']),
    ],
  },
  selection: {
    entity: 'selection', label: 'Selections', plural: 'selections', disposition: 'REFERENCE',
    effect: 'Kept with the job for the selections tab.',
    fields: [
      JOB_LINK,
      f('category', 'Category', 'text', ['category', 'location', 'room']),
      f('name', 'Selection', 'text', ['selection', 'title', 'name', 'item'], req),
      f('choice', 'Choice', 'text', ['choice', 'selected choice', 'option', 'product']),
      f('allowance_cents', 'Allowance', 'money', ['allowance', 'budget']),
      f('selected_price_cents', 'Selected price', 'money', ['price', 'selected price', 'client price', 'amount']),
      f('status', 'Status', 'text', ['status']),
      f('due_date', 'Due', 'date', ['due date', 'deadline', 'due']),
    ],
  },
  file: {
    entity: 'file', label: 'Files and photos list', plural: 'files', disposition: 'REFERENCE',
    effect: 'Listed against each job so the zip of files can be matched later.',
    fields: [
      f('job_ref', 'Job number', 'text', ['job number', 'job', 'project', 'job id']),
      f('path', 'Path', 'text', ['path', 'folder', 'file path', 'location'], req),
      f('file_name', 'File name', 'text', ['file name', 'name', 'title']),
      f('kind', 'Kind', 'text', ['type', 'kind', 'file type']),
      f('taken_at', 'Date', 'date', ['date taken', 'date', 'uploaded', 'created']),
    ],
  },
  equipment: {
    entity: 'equipment', label: 'Customer equipment', plural: 'pieces of equipment', disposition: 'RECORD',
    effect: 'Added to the customer’s equipment (a serial already recorded is matched).',
    fields: [
      REF('Equipment ID', ['equipment id', 'asset id', 'id']),
      ...CUSTOMER_LINK,
      f('site_address', 'Location address', 'text', ['location address', 'service address', 'address']),
      f('city', 'City', 'text', ['city']), f('state', 'State', 'text', ['state']), f('zip', 'ZIP', 'text', ['zip', 'zip code']),
      f('equipment_type', 'Type', 'text', ['equipment type', 'type', 'system type']),
      f('make', 'Make', 'text', ['manufacturer', 'make', 'brand']),
      f('model', 'Model', 'text', ['model number', 'model']),
      f('serial_number', 'Serial number', 'text', ['serial number', 'serial', 'sn']),
      f('model_year', 'Year', 'int', ['year', 'model year']),
      f('installed_on', 'Installed', 'date', ['install date', 'installed', 'installed on', 'date installed']),
      f('warranty_expires_on', 'Warranty ends', 'date', ['warranty expiration', 'warranty expires', 'warranty end', 'warranty']),
      f('description', 'Description', 'text', ['description', 'name', 'notes']),
    ],
  },
  service_history: {
    entity: 'service_history', label: 'Service history', plural: 'past visits', disposition: 'REFERENCE',
    effect: 'Kept as history on the customer and equipment.',
    fields: [
      REF('Invoice / job number', ['invoice number', 'job number', 'work order number', 'ro number']),
      ...CUSTOMER_LINK,
      f('date', 'Date', 'date', ['completed on', 'completed date', 'date', 'invoice date', 'service date'], req),
      f('summary', 'Summary', 'text', ['summary', 'description', 'work performed', 'job type', 'notes']),
      f('technician', 'Technician', 'text', ['technician', 'tech', 'assigned technician']),
      f('unit_serial', 'Equipment serial', 'text', ['serial number', 'serial', 'unit serial']),
      f('total_cents', 'Total', 'money', ['total', 'invoice total', 'amount', 'revenue']),
    ],
  },
  open_ar: {
    entity: 'open_ar', label: 'Open invoices (AR)', plural: 'open invoices', disposition: 'FACT',
    effect: 'Summed per customer for Books’ opening receivables tie-out.',
    fields: [
      ...CUSTOMER_LINK.map((x) => (x.key === 'customer_name' ? { ...x, required: true } : x)),
      REF('Invoice number', ['invoice number', 'invoice no', 'invoice', 'number']),
      f('invoice_date', 'Invoice date', 'date', ['invoice date', 'date']),
      f('due_date', 'Due date', 'date', ['due date', 'due']),
      f('total_cents', 'Invoice total', 'money', ['total', 'invoice total', 'amount']),
      f('balance_cents', 'Open balance', 'signed_money', ['balance', 'open balance', 'balance due', 'amount due', 'outstanding'], req),
      f('job_ref', 'Job number', 'text', ['job number', 'job', 'project']),
    ],
  },
  agreement: {
    entity: 'agreement', label: 'Memberships and agreements', plural: 'agreements', disposition: 'RECORD',
    effect: 'Each agreement is created with its remaining visits scheduled and its deferred balance carried for Books.',
    fields: [
      REF('Agreement ID', ['agreement id', 'membership id', 'agreement number', 'membership number', 'id']),
      f('customer_name', 'Customer', 'text', ['customer name', 'customer', 'client name', 'client'], req),
      f('plan_name', 'Plan', 'text', ['plan name', 'membership type', 'agreement type', 'plan', 'membership', 'agreement name', 'name'], req),
      f('tier', 'Tier', 'text', ['tier', 'level', 'membership level']),
      f('starts_on', 'Start date', 'date', ['start date', 'starts on', 'from', 'start', 'effective date'], req),
      f('ends_on', 'End date', 'date', ['end date', 'expiration date', 'ends on', 'to', 'expires', 'end'], req),
      f('price_cents', 'Price per term', 'money', ['price', 'agreement price', 'membership price', 'amount', 'total price', 'billing amount']),
      f('billing_frequency', 'Billing', 'enum', ['billing frequency', 'billing schedule', 'billing', 'payment frequency'], {
        options: opts(['MONTHLY', ['monthly', 'month', 'mo']], ['QUARTERLY', ['quarterly', 'quarter']], ['ANNUAL', ['annual', 'annually', 'yearly', 'year']], ['UPFRONT', ['upfront', 'up front', 'one time', 'prepaid', 'paid in full']]),
      }),
      f('visits_per_term', 'Visits per term', 'int', ['visits per year', 'visits included', 'total visits', 'visits per term', 'visits']),
      f('visits_remaining', 'Visits remaining', 'int', ['visits remaining', 'remaining visits', 'visits left', 'open visits']),
      f('deferred_cents', 'Deferred balance', 'money', ['deferred revenue', 'deferred balance', 'unearned revenue', 'deferred', 'unearned']),
      f('revenue_policy', 'Revenue', 'enum', ['revenue recognition', 'revenue policy'], { options: opts(['PER_VISIT', ['per visit', 'visit']], ['STRAIGHT_LINE', ['straight line', 'monthly', 'ratable']]) }),
    ],
  },
  unit: {
    entity: 'unit', label: 'Units in stock', plural: 'units', disposition: 'RECORD',
    effect: 'Each unit joins inventory with its cost; Books loads the cost basis and floor-plan note from the opening file.',
    fields: UNIT_FIELDS,
  },
  rental_unit: {
    entity: 'rental_unit', label: 'Rental fleet', plural: 'rental units', disposition: 'RECORD',
    effect: 'Each unit joins the rental fleet at its cost; Books loads the rental inventory from the opening file.',
    fields: UNIT_FIELDS,
  },
  part: {
    entity: 'part', label: 'Parts on hand', plural: 'parts', disposition: 'RECORD',
    effect: 'Each part joins the parts catalog with its bin and on-hand count; Books values the inventory from the opening file.',
    fields: [
      REF('Part ID', ['part id', 'item id']),
      f('part_number', 'Part number', 'text', ['part number', 'part no', 'part', 'item number', 'sku'], req),
      f('manufacturer', 'Line / manufacturer', 'text', ['manufacturer', 'line', 'mfr', 'vendor code', 'line code', 'brand']),
      f('description', 'Description', 'text', ['description', 'desc', 'part description', 'name'], req),
      f('bin', 'Bin', 'text', ['bin', 'bin location', 'location', 'shelf']),
      f('on_hand', 'On hand', 'number', ['on hand', 'qty on hand', 'quantity on hand', 'qoh', 'quantity', 'qty']),
      f('cost_cents', 'Cost', 'money', ['cost', 'unit cost', 'avg cost', 'average cost', 'dealer cost']),
      f('price_cents', 'Price', 'money', ['price', 'sell price', 'counter price', 'retail']),
      f('list_price_cents', 'List price', 'money', ['list', 'list price', 'msrp']),
      f('uom', 'Unit', 'text', ['uom', 'unit', 'unit of measure']),
      f('category', 'Category', 'text', ['category', 'class', 'group']),
    ],
  },
  repair_order: {
    entity: 'repair_order', label: 'Open repair orders', plural: 'repair orders', disposition: 'REFERENCE',
    effect: 'Kept against the customer and unit so the shop can reopen them.',
    fields: [
      REF('RO number', ['ro number', 'repair order number', 'work order number', 'ro', 'number'], ),
      ...CUSTOMER_LINK,
      f('unit_serial', 'Unit serial', 'text', ['serial number', 'serial', 'unit serial']),
      f('opened_on', 'Opened', 'date', ['open date', 'opened', 'date opened', 'date in', 'ro date']),
      f('status', 'Status', 'text', ['status', 'ro status']),
      f('complaint', 'Complaint', 'text', ['complaint', 'concern', 'description', 'customer concern']),
      f('labor_cents', 'Labor', 'money', ['labor', 'labor amount', 'labor total']),
      f('parts_cents', 'Parts', 'money', ['parts', 'parts amount', 'parts total']),
      f('total_cents', 'Total', 'money', ['total', 'ro total', 'amount']),
    ],
  },
  special_order: {
    entity: 'special_order', label: 'Special orders and deposits', plural: 'special orders', disposition: 'REFERENCE',
    effect: 'Kept against the customer; deposits taken go to Books’ opening deposits.',
    fields: [
      REF('Order number', ['order number', 'special order number', 'so number', 'number']),
      ...CUSTOMER_LINK,
      f('part_number', 'Part number', 'text', ['part number', 'part', 'item'], req),
      f('qty', 'Quantity', 'number', ['qty', 'quantity']),
      f('deposit_cents', 'Deposit', 'money', ['deposit', 'deposit amount', 'prepaid']),
      f('ordered_on', 'Ordered', 'date', ['order date', 'ordered', 'date']),
      f('status', 'Status', 'text', ['status']),
    ],
  },
  warranty_claim: {
    entity: 'warranty_claim', label: 'Open warranty claims', plural: 'warranty claims', disposition: 'REFERENCE',
    effect: 'Kept against the unit; open amounts go to Books’ opening warranty receivable.',
    fields: [
      REF('Claim number', ['claim number', 'claim no', 'claim', 'claim id']),
      f('unit_serial', 'Unit serial', 'text', ['serial number', 'serial', 'unit serial']),
      ...CUSTOMER_LINK,
      f('manufacturer', 'Manufacturer', 'text', ['manufacturer', 'oem', 'make', 'line']),
      f('submitted_on', 'Submitted', 'date', ['submitted date', 'submitted', 'claim date', 'date']),
      f('status', 'Status', 'text', ['status', 'claim status']),
      f('amount_cents', 'Claim amount', 'money', ['claim amount', 'amount', 'total', 'claim total'], req),
    ],
  },
  rental_contract: {
    entity: 'rental_contract', label: 'Open rental contracts', plural: 'rental contracts', disposition: 'REFERENCE',
    effect: 'Kept against the customer and unit for check-in.',
    fields: [
      REF('Contract number', ['contract number', 'rental number', 'contract', 'number']),
      ...CUSTOMER_LINK,
      f('unit_serial', 'Unit serial', 'text', ['serial number', 'serial', 'unit serial']),
      f('starts_on', 'Out', 'date', ['out date', 'start date', 'date out', 'start']),
      f('due_on', 'Due back', 'date', ['due date', 'return date', 'due back', 'due in']),
      f('rate_cents', 'Rate', 'money', ['rate', 'daily rate', 'rental rate', 'amount']),
      f('deposit_cents', 'Deposit', 'money', ['deposit']),
      f('status', 'Status', 'text', ['status']),
    ],
  },
  deposit: {
    entity: 'deposit', label: 'Customer deposits', plural: 'deposits', disposition: 'FACT',
    effect: 'Summed for Books’ opening customer deposits (a liability, never revenue).',
    fields: [
      ...CUSTOMER_LINK,
      f('job_ref', 'Job number', 'text', ['job number', 'job', 'project']),
      REF('Reference', ['reference', 'payment number', 'receipt number', 'number']),
      f('amount_cents', 'Amount held', 'money', ['amount', 'deposit', 'unapplied amount', 'balance', 'deposit amount'], req),
      f('received_on', 'Received', 'date', ['date', 'received date', 'payment date']),
    ],
  },
};

export function entityDef(entity: ImportEntity): EntityDef {
  return ENTITY_DEFS[entity];
}

export function fieldOf(entity: ImportEntity, key: string): TargetField | undefined {
  return ENTITY_DEFS[entity].fields.find((x) => x.key === key);
}

export function dispositionOf(entity: ImportEntity): Disposition {
  return ENTITY_DEFS[entity].disposition;
}

/** Entities in the order a full migration should bring them in (masters first). */
export const COMMIT_ORDER: readonly ImportEntity[] = [
  'customer', 'site', 'contact', 'vendor', 'employee', 'cost_item', 'part', 'job', 'budget', 'sov_line', 'commitment', 'change_order',
  'selection', 'file', 'equipment', 'unit', 'rental_unit', 'agreement', 'service_history', 'repair_order', 'special_order',
  'warranty_claim', 'rental_contract', 'open_ar', 'deposit',
];
