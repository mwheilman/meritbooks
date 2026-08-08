/**
 * ERP connector CATALOG — the provider-agnostic registry of operational systems a
 * MeritBooks tenant can link so accounting-relevant data flows into the book of
 * record.
 *
 * This module is the single source of truth for WHICH systems exist and HOW they
 * connect; it holds NO per-ERP sync logic and NO credentials. Per-ERP field mapping
 * and pull/push sync is deliberately future work — the framework here (catalog +
 * connection method taxonomy) is what the Connect UI and the API routes render and
 * gate against.
 *
 * Design intent (why this shape):
 * - `connectionMethod` is the coarse integration STRATEGY, not the specific vendor.
 *   The Connect UI branches on it (OAuth handshake vs. CSV upload vs. "request it"),
 *   so a new connector only needs a catalog row, never new UI.
 * - `status` lets us ship a broad, honest catalog now: CSV + MANUAL are AVAILABLE
 *   today (they route into the existing /import pipeline or record intent); almost
 *   everything vendor-specific is PLANNED (framework ready, sync not built) or
 *   REQUEST (we record demand and reach out).
 * - Adding a connector = appending one typed row. Nothing else in the app hardcodes
 *   a vendor list.
 */

/** The integration STRATEGY for a connector — the Connect UI branches on this. */
export type ErpConnectionMethod =
  | 'NATIVE_API' // first-party REST/GraphQL API with an API key / token
  | 'OAUTH' // three-legged OAuth authorization to the vendor
  | 'AGGREGATOR' // reached via a data aggregator (Rutter / Codat / Finch-style)
  | 'WEBHOOK' // the system pushes events to a MeritBooks endpoint
  | 'CSV' // periodic/one-time CSV export → MeritBooks import pipeline
  | 'MANUAL'; // no external system — user keys data directly

/** How ready a connector is. AVAILABLE ships today; PLANNED = framework-ready,
 *  sync not built; REQUEST = we record demand and follow up. */
export type ErpCatalogStatus = 'AVAILABLE' | 'PLANNED' | 'REQUEST';

/** Accounting-relevant object types a connector can bring into the book of record. */
export type ErpDataType =
  | 'customers'
  | 'jobs'
  | 'invoices'
  | 'bills'
  | 'payments'
  | 'costs'
  | 'payroll'
  | 'items';

/** Vertical grouping used to organize the catalog grid. */
export type ErpVertical =
  | 'field_service'
  | 'construction'
  | 'flooring'
  | 'project_management'
  | 'accounting'
  | 'general';

export interface ErpConnector {
  /** Stable slug — persisted on ErpConnection.erp_id. Never reuse or rename. */
  id: string;
  name: string;
  vertical: ErpVertical;
  connectionMethod: ErpConnectionMethod;
  status: ErpCatalogStatus;
  dataTypes: ErpDataType[];
  /** Short brand slug used to render a monogram/logo fallback in the UI. */
  logoHint: string;
  /** One-line "what this is / who uses it", shown on the connector card. */
  description?: string;
}

/** Human labels + display order for verticals (drives the grouped grid). */
export const ERP_VERTICALS: { id: ErpVertical; label: string; blurb: string }[] = [
  { id: 'field_service', label: 'Field Service', blurb: 'HVAC, plumbing, electrical, and trades dispatch systems.' },
  { id: 'construction', label: 'Construction & Trades', blurb: 'Project, job-cost, and construction management platforms.' },
  { id: 'flooring', label: 'Flooring & Surfaces', blurb: 'Flooring-specific estimating, POS, and job systems.' },
  { id: 'project_management', label: 'Project Management', blurb: 'General work / project management tools.' },
  { id: 'accounting', label: 'Accounting Systems', blurb: 'Existing books you are moving off of, or reading from.' },
  { id: 'general', label: 'Everything Else', blurb: 'Bring data by file, aggregator, webhook, or enter it manually.' },
];

/** Human-friendly labels for each data type (for badges/tooltips). */
export const ERP_DATA_TYPE_LABELS: Record<ErpDataType, string> = {
  customers: 'Customers',
  jobs: 'Jobs / Projects',
  invoices: 'Invoices (AR)',
  bills: 'Bills (AP)',
  payments: 'Payments',
  costs: 'Job Costs',
  payroll: 'Payroll',
  items: 'Items / Catalog',
};

/** Human-friendly labels for each connection method. */
export const ERP_METHOD_LABELS: Record<ErpConnectionMethod, string> = {
  NATIVE_API: 'Direct API',
  OAUTH: 'Secure sign-in (OAuth)',
  AGGREGATOR: 'Via aggregator',
  WEBHOOK: 'Event webhook',
  CSV: 'File upload (CSV)',
  MANUAL: 'Manual entry',
};

/**
 * THE CATALOG.
 *
 * Broad by design — a customer should see their system here even if sync is not
 * built yet, so they can register intent (PLANNED/REQUEST) rather than bounce. CSV
 * and MANUAL are the two AVAILABLE-today paths and always work.
 */
export const ERP_CATALOG: ErpConnector[] = [
  // ── Field service ──────────────────────────────────────────────────────────
  {
    id: 'servicetitan',
    name: 'ServiceTitan',
    vertical: 'field_service',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'payments', 'items', 'costs'],
    logoHint: 'servicetitan',
    description: 'All-in-one platform for residential & commercial trades.',
  },
  {
    id: 'housecall-pro',
    name: 'Housecall Pro',
    vertical: 'field_service',
    connectionMethod: 'OAUTH',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'payments'],
    logoHint: 'housecallpro',
    description: 'Scheduling, invoicing, and payments for home-service pros.',
  },
  {
    id: 'jobber',
    name: 'Jobber',
    vertical: 'field_service',
    connectionMethod: 'OAUTH',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'payments'],
    logoHint: 'jobber',
    description: 'Quoting, scheduling, and invoicing for small field teams.',
  },
  {
    id: 'buildops',
    name: 'BuildOps',
    vertical: 'field_service',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'costs'],
    logoHint: 'buildops',
    description: 'Commercial contractor service & project management.',
  },
  {
    id: 'servicetrade',
    name: 'ServiceTrade',
    vertical: 'field_service',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices'],
    logoHint: 'servicetrade',
    description: 'Service management for commercial mechanical & fire contractors.',
  },

  // ── Construction & trades ───────────────────────────────────────────────────
  {
    id: 'procore',
    name: 'Procore',
    vertical: 'construction',
    connectionMethod: 'OAUTH',
    status: 'PLANNED',
    dataTypes: ['jobs', 'invoices', 'bills', 'costs'],
    logoHint: 'procore',
    description: 'Construction project & financials management.',
  },
  {
    id: 'buildertrend',
    name: 'Buildertrend',
    vertical: 'construction',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'bills', 'costs'],
    logoHint: 'buildertrend',
    description: 'Home builder & remodeler project management.',
  },
  {
    id: 'contractor-foreman',
    name: 'Contractor Foreman',
    vertical: 'construction',
    connectionMethod: 'CSV',
    status: 'PLANNED',
    dataTypes: ['jobs', 'invoices', 'bills', 'costs'],
    logoHint: 'contractorforeman',
    description: 'Affordable all-in-one construction management.',
  },
  {
    id: 'knowify',
    name: 'Knowify',
    vertical: 'construction',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['jobs', 'invoices', 'costs'],
    logoHint: 'knowify',
    description: 'Contractor job costing & project management.',
  },
  {
    id: 'jobtread',
    name: 'JobTread',
    vertical: 'construction',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'costs'],
    logoHint: 'jobtread',
    description: 'End-to-end construction business management.',
  },
  {
    id: 'sage-100-contractor',
    name: 'Sage 100 Contractor',
    vertical: 'construction',
    connectionMethod: 'CSV',
    status: 'PLANNED',
    dataTypes: ['jobs', 'invoices', 'bills', 'costs', 'payroll'],
    logoHint: 'sage',
    description: 'Construction accounting & job cost (formerly Master Builder).',
  },
  {
    id: 'foundation',
    name: 'Foundation Software',
    vertical: 'construction',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['jobs', 'costs', 'payroll', 'bills'],
    logoHint: 'foundation',
    description: 'Construction accounting & job-cost payroll.',
  },
  {
    id: 'innergy',
    name: 'Innergy',
    vertical: 'construction',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['jobs', 'invoices', 'costs', 'items'],
    logoHint: 'innergy',
    description: 'ERP for millwork & custom woodworking shops.',
  },
  {
    id: 'jobnimbus',
    name: 'JobNimbus',
    vertical: 'construction',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'payments'],
    logoHint: 'jobnimbus',
    description: 'Roofing & contractor CRM + project management.',
  },
  {
    id: 'acculynx',
    name: 'AccuLynx',
    vertical: 'construction',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'payments', 'costs'],
    logoHint: 'acculynx',
    description: 'Roofing contractor business management.',
  },

  // ── Flooring & surfaces ─────────────────────────────────────────────────────
  {
    id: 'rfms',
    name: 'RFMS',
    vertical: 'flooring',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'items', 'costs'],
    logoHint: 'rfms',
    description: 'Flooring business ERP (measure → sell → install).',
  },
  {
    id: 'compufloor',
    name: 'Comp-U-Floor / CompuSystems',
    vertical: 'flooring',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'items'],
    logoHint: 'compufloor',
    description: 'ERP for flooring dealers & contractors.',
  },
  {
    id: 'qfloors',
    name: 'QFloors',
    vertical: 'flooring',
    connectionMethod: 'CSV',
    status: 'PLANNED',
    dataTypes: ['customers', 'invoices', 'items', 'bills'],
    logoHint: 'qfloors',
    description: 'Flooring-specific business & inventory software.',
  },
  {
    id: 'rollmaster',
    name: 'RollMaster',
    vertical: 'flooring',
    connectionMethod: 'NATIVE_API',
    status: 'PLANNED',
    dataTypes: ['customers', 'jobs', 'invoices', 'items'],
    logoHint: 'rollmaster',
    description: 'Flooring ERP with rolls/inventory management.',
  },

  // ── Project management ──────────────────────────────────────────────────────
  {
    id: 'clickup',
    name: 'ClickUp',
    vertical: 'project_management',
    connectionMethod: 'OAUTH',
    status: 'PLANNED',
    dataTypes: ['jobs', 'costs'],
    logoHint: 'clickup',
    description: 'General project & task management (map tasks → jobs).',
  },

  // ── Accounting systems ──────────────────────────────────────────────────────
  {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    vertical: 'accounting',
    connectionMethod: 'OAUTH',
    status: 'PLANNED',
    dataTypes: ['customers', 'invoices', 'bills', 'payments', 'items'],
    logoHint: 'quickbooks',
    description: 'Read your existing books (also a migration import source).',
  },
  {
    id: 'xero',
    name: 'Xero',
    vertical: 'accounting',
    connectionMethod: 'OAUTH',
    status: 'PLANNED',
    dataTypes: ['customers', 'invoices', 'bills', 'payments'],
    logoHint: 'xero',
    description: 'Read your existing books (also a migration import source).',
  },

  // ── General / always-available paths ────────────────────────────────────────
  {
    id: 'aggregator-generic',
    name: 'Other accounting system (via aggregator)',
    vertical: 'general',
    connectionMethod: 'AGGREGATOR',
    status: 'PLANNED',
    dataTypes: ['customers', 'invoices', 'bills', 'payments'],
    logoHint: 'aggregator',
    description: 'Reach 20+ ledgers through a unified accounting aggregator.',
  },
  {
    id: 'webhook-generic',
    name: 'Custom webhook feed',
    vertical: 'general',
    connectionMethod: 'WEBHOOK',
    status: 'PLANNED',
    dataTypes: ['jobs', 'invoices', 'costs', 'payments'],
    logoHint: 'webhook',
    description: 'Have your system push events to a MeritBooks endpoint.',
  },
  {
    id: 'other-csv',
    name: 'Other system — CSV / spreadsheet',
    vertical: 'general',
    connectionMethod: 'CSV',
    status: 'AVAILABLE',
    dataTypes: ['customers', 'jobs', 'invoices', 'bills', 'payments', 'costs', 'items'],
    logoHint: 'csv',
    description: 'Export from anything and map it in — available today.',
  },
  {
    id: 'manual-none',
    name: "No system — I'll enter data manually",
    vertical: 'general',
    connectionMethod: 'MANUAL',
    status: 'AVAILABLE',
    dataTypes: [],
    logoHint: 'manual',
    description: 'Skip integration; work directly in the book of record.',
  },
  {
    id: 'request-erp',
    name: 'My system isn’t listed — request it',
    vertical: 'general',
    connectionMethod: 'MANUAL',
    status: 'REQUEST',
    dataTypes: [],
    logoHint: 'request',
    description: 'Tell us what you use and we’ll prioritize a connector.',
  },
];

/** Lookup a connector by its stable id. */
export function getErpConnector(id: string): ErpConnector | undefined {
  return ERP_CATALOG.find((c) => c.id === id);
}

/** Group the catalog by vertical, preserving ERP_VERTICALS order. */
export function groupErpCatalogByVertical(
  catalog: ErpConnector[] = ERP_CATALOG,
): { vertical: ErpVertical; label: string; blurb: string; connectors: ErpConnector[] }[] {
  return ERP_VERTICALS.map((v) => ({
    vertical: v.id,
    label: v.label,
    blurb: v.blurb,
    connectors: catalog.filter((c) => c.vertical === v.id),
  })).filter((g) => g.connectors.length > 0);
}
