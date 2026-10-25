/**
 * Manifest v2 experience slots for the twelve packs (UX seat §3a "Industry × experience table",
 * §3b per-persona IA, §3c schedule defaults). Plain data: each pack's v2 version is its v1 manifest
 * plus these slots (packs/index.ts). Labels name the same object the screen shows (PLT-08).
 *
 * general carries the persona baseline every pack inherits (shallow per group / per job type), so
 * its job-type slots use '*' only.
 */
import type { PackManifestInput } from '../types';

export type ExperienceSlots = Pick<PackManifestInput, 'roles' | 'nav' | 'home' | 'jobTabs' | 'mobile' | 'schedule' | 'docTemplates' | 'checklists'>;

type NavIn = NonNullable<PackManifestInput['nav']>[keyof NonNullable<PackManifestInput['nav']>];
type NavEntryIn = NonNullable<NavIn>[number];
type TabIn = NonNullable<PackManifestInput['jobTabs']>[string]['tabs'][number];
type RoleIn = NonNullable<PackManifestInput['roles']>[number];
type Template = RoleIn['template'];

/** Rail item with a pack label. */
const L = <I extends Exclude<NavEntryIn, string>['item']>(item: I, label: string): NavEntryIn => ({ item, label });
/** Job tab with a pack label. */
const T = <K extends Exclude<TabIn, string>['tab']>(tab: K, label: string): TabIn => ({ tab, label });
/** Role titles, in display order (first title per template is the one people see). */
const roles = (...pairs: Array<[string, Template]>): RoleIn[] => pairs.map(([title, template]) => ({ title, template }));

// ---------------------------------------------------------------------------
// general — the persona baseline (UX seat §3b)
// ---------------------------------------------------------------------------

export const generalExperience: ExperienceSlots = {
  roles: roles(
    ['Owner', 'projects_owner'], ['General manager', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Bookkeeper', 'projects_project_accountant'], ['Scheduler', 'projects_dispatcher'], ['Purchasing', 'projects_purchasing'],
    ['Project manager', 'projects_pm'], ['Lead', 'projects_supervisor'], ['Crew member', 'projects_labor'],
    ['Estimator', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'jobs', L('leads', 'Pipeline'), 'customers', 'estimates', 'schedule', L('margin', 'Insights'), 'backlog', 'settings'],
    admin: ['home', 'inbox', 'leads', 'jobs', 'schedule', 'billing', 'customers', L('subcontractors', 'Vendors'), 'documents', 'settings'],
    pm: ['home', 'my_jobs', 'estimates', 'schedule', 'change_orders', 'commitments', 'time', 'billing', 'inbox'],
    supervisor: ['today', 'my_jobs', 'schedule', 'crew_time', 'logs', 'punch', 'documents'],
    labor: ['today', 'time', 'jobs', 'me'],
    sales: ['home', 'inbox', 'leads', 'customers', 'estimates', 'my_jobs'],
  },
  home: {
    management: ['weekly_brief', 'cash_ar', 'jobs_at_risk', 'backlog_capacity', 'over_under_billing', 'pipeline', 'approvals_queue'],
    admin: ['needs_you', 'today_schedule', 'billing_ready', 'new_leads', 'setup_card'],
    pm: ['needs_you', 'my_jobs', 'week_schedule', 'billing_due', 'client_updates'],
    supervisor: ['today_on_site', 'lookahead_constraints', 'crew_time_to_approve', 'open_punch', 'daily_report_status'],
    labor: ['current_assignment', 'rest_of_today', 'timecard', 'earnings', 'office_messages'],
    sales: ['new_leads', 'pipeline', 'my_jobs'],
  },
  jobTabs: {
    '*': { tabs: ['overview', 'estimates', T('schedule', 'Tasks'), 'budget', 'time', 'billing', T('documents', 'Files'), T('portal', 'Client portal')] },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['daily_log', 'photo', 'approve_crew_time'] },
      labor: { '*': ['clock_in', 'photo', 'note', 'checklist'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'gantt' }, multiJob: 'calendar', byGroup: {} },
  docTemplates: ['estimate', 'contract', 'change_order', 'invoice', 'purchase_order', 'daily_report', 'closeout'],
  checklists: [
    { key: 'site_safety_walk', label: 'Site safety walk' },
    { key: 'job_closeout', label: 'Job closeout' },
  ],
};

// ---------------------------------------------------------------------------
// commercial_gc — Project; Owner; budget sheet and pay apps
// ---------------------------------------------------------------------------

export const commercialGcExperience: ExperienceSlots = {
  roles: roles(
    ['President', 'projects_owner'], ['Project executive', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Project accountant', 'projects_project_accountant'], ['Project coordinator', 'projects_dispatcher'],
    ['Purchasing manager', 'projects_purchasing'], ['Project manager', 'projects_pm'], ['Assistant project manager', 'projects_pm'],
    ['Superintendent', 'projects_supervisor'], ['Assistant superintendent', 'projects_supervisor'], ['Field crew', 'projects_labor'],
    ['Estimator', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'jobs', L('leads', 'Pipeline'), 'estimates', 'wip', L('margin', 'Insights'), 'backlog', 'compliance', 'settings'],
    admin: ['home', 'inbox', 'estimates', 'jobs', 'schedule', 'pay_apps', 'billing_calendar', 'retainage', 'compliance', 'customers', 'subcontractors', 'documents', 'portals', 'settings'],
    pm: ['home', 'my_jobs', 'estimates', 'schedule', 'commitments', L('change_events', 'Change events'), 'rfis', 'submittals', 'pay_apps', 'meetings', 'project_review', 'documents', L('margin', 'Reports'), 'inbox'],
    supervisor: ['today', 'my_jobs', L('schedule', 'Look-ahead'), 'crew_time', 'logs', 'rfis', 'punch', 'safety_center', 'documents'],
  },
  home: {
    management: ['weekly_brief', 'jobs_at_risk', 'over_under_billing', 'backlog_capacity', 'cash_ar', 'pipeline', 'approvals_queue'],
    pm: ['needs_you', 'my_jobs', 'pay_apps_due', 'week_schedule', 'billing_due'],
  },
  jobTabs: {
    '*': {
      tabs: ['overview', 'budget', 'schedule', 'commitments', T('change_events', 'Changes'), T('rfis', 'RFIs'), 'pay_apps',
        'submittals', T('logs', 'Daily reports'), 'meetings', 'buyout', 'closeout', 'directory',
        T('safety', 'Safety & inspections'), 'documents', 'specifications', 'correspondence', T('project_review', 'Monthly review'),
        T('portal', 'Owner portal'), 'billing'],
    },
    small_work: { tabs: ['overview', 'budget', T('change_events', 'Changes'), T('tm_tickets', 'T&M tickets'), 'time', 'billing', 'documents'] },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['daily_log', 'photo', 'punch_item', 'crew_time', 'inspection'] },
      labor: { '*': ['clock_in', 'photo', 'punch_item'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'gantt', small_work: 'calendar' }, multiJob: 'gantt', byGroup: { supervisor: 'lookahead', management: 'milestone_timeline' } },
  docTemplates: ['contract', 'subcontract', 'change_order', 'pay_app', 'purchase_order', 'daily_report', 'lien_waiver', 'punch_list', 'closeout'],
  checklists: [
    { key: 'preconstruction_meeting', label: 'Preconstruction meeting' },
    { key: 'site_safety_walk', label: 'Site safety walk' },
    { key: 'mep_rough_in', label: 'MEP rough-in inspection' },
    { key: 'punch_walk', label: 'Punch walk' },
    { key: 'closeout', label: 'Closeout package' },
  ],
};

// ---------------------------------------------------------------------------
// specialty_trade — Job for a GC; SOV, productivity, T&M
// ---------------------------------------------------------------------------

export const specialtyTradeExperience: ExperienceSlots = {
  roles: roles(
    ['Owner', 'projects_owner'], ['Operations manager', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Project accountant', 'projects_project_accountant'], ['Scheduler', 'projects_dispatcher'], ['Purchasing', 'projects_purchasing'],
    ['Project manager', 'projects_pm'], ['Foreman', 'projects_supervisor'], ['General foreman', 'projects_supervisor'],
    ['Journeyman', 'projects_labor'], ['Apprentice', 'projects_labor'], ['Estimator', 'projects_sales'],
  ),
  nav: {
    admin: ['home', 'inbox', L('estimates', 'Bids'), 'trade_proposals', 'jobs', L('schedule', 'Crew schedule'), 'workforce', 'calls', 'dispatch', 'pay_apps', 'retainage', 'compliance', 'customers', 'price_book', 'documents', 'settings'],
    pm: ['home', 'my_jobs', L('estimates', 'Bids'), L('schedule', 'Crew schedule'), 'pay_apps', L('change_events', 'Change events'), 'rfis', 'submittals', 'time', 'commitments', 'workforce', 'dispatch', 'price_book', 'inbox'],
    supervisor: ['today', 'foreman', 'my_jobs', L('schedule', 'Crew board'), 'crew_time', 'logs', 'rfis', 'punch', 'safety_center', 'documents'],
  },
  home: {
    pm: ['needs_you', 'productivity', 'my_jobs', 'pay_apps_due', 'week_schedule'],
    supervisor: ['today_on_site', 'crew_time_to_approve', 'crew_board', 'daily_report_status', 'open_punch'],
  },
  jobTabs: {
    '*': {
      tabs: ['overview', 'pay_apps', T('productivity', 'Productivity'), T('change_events', 'Changes'),
        T('tm_tickets', 'T&M tickets'), T('team', 'Crew'), T('rfis', 'RFIs'), 'submittals', T('safety', 'Safety & inspections'),
        'documents', 'budget', 'time', 'logs', 'closeout', T('billing', 'SOV & billing'), 'directory', 'correspondence'],
    },
    tm_work: { tabs: ['overview', T('tm_tickets', 'T&M tickets'), 'time', 'billing', T('change_events', 'Changes'), 'documents'] },
    trade_service_call: { tabs: ['work_orders', 'estimates', 'billing', 'time', T('activity', 'History'), 'overview'], defaultTab: 'work_orders' },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['crew_time', 'report_quantities', 'tm_ticket', 'photo', 'daily_log'] },
      labor: { '*': ['clock_in', 'report_quantities', 'photo'], trade_service_call: ['on_my_way', 'start', 'take_payment'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'gantt', tm_work: 'calendar', trade_service_call: 'dispatch' }, multiJob: 'crew_board', byGroup: { supervisor: 'lookahead' } },
  docTemplates: ['pay_app', 'change_order', 'tm_ticket', 'lien_waiver', 'daily_report', 'invoice'],
  checklists: [
    { key: 'jobsite_safety', label: 'Jobsite safety (toolbox talk)' },
    { key: 'rough_in_inspection', label: 'Rough-in inspection' },
    { key: 'system_startup', label: 'System startup', jobTypes: ['subcontract'] },
  ],
};

// ---------------------------------------------------------------------------
// residential_remodel — Project; Client; selections and client decisions
// ---------------------------------------------------------------------------

export const residentialRemodelExperience: ExperienceSlots = {
  roles: roles(
    ['Owner', 'projects_owner'], ['General manager', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Bookkeeper', 'projects_project_accountant'], ['Production coordinator', 'projects_dispatcher'], ['Purchasing', 'projects_purchasing'],
    ['Project manager', 'projects_pm'], ['Lead carpenter', 'projects_supervisor'], ['Carpenter', 'projects_labor'],
    ['Designer', 'projects_sales'], ['Salesperson', 'projects_sales'],
  ),
  nav: {
    admin: ['home', 'inbox', 'leads', 'appointments', 'proposals', 'jobs', 'schedule', 'selections', 'billing', 'customers', 'documents', 'portals', 'settings'],
    pm: ['home', 'leads', 'proposals', 'my_jobs', 'schedule', 'selections', 'change_orders', 'billing', 'inbox'],
    supervisor: ['today', 'my_jobs', 'schedule', 'crew_time', L('logs', 'Logs & photos'), L('punch', 'To-dos & punch'), 'documents'],
    sales: ['home', 'inbox', 'leads', 'appointments', 'proposals', 'customers', 'my_jobs'],
  },
  home: {
    pm: ['needs_you', 'selections_queue', 'my_jobs', 'week_schedule', 'client_updates', 'billing_due'],
  },
  jobTabs: {
    '*': {
      tabs: ['overview', T('estimates', 'Proposal'), 'selections', 'schedule', 'change_orders', 'budget', 'billing',
        T('logs', 'Logs & photos'), T('portal', 'Client view')],
    },
    design_agreement: { tabs: ['overview', T('estimates', 'Proposal'), 'selections', 'time', 'billing', 'documents', T('portal', 'Client view')] },
    small_repair: { tabs: ['overview', T('estimates', 'Proposal'), 'billing', 'time', 'documents'] },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['daily_log', 'photo', 'clock_in', 'punch_item', 'request_change_order'] },
      labor: { '*': ['clock_in', 'photo', 'todo'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'gantt', small_repair: 'calendar' }, multiJob: 'crew_board', byGroup: {} },
  docTemplates: ['proposal', 'design_agreement', 'contract', 'change_order', 'selection_sheet', 'invoice', 'daily_report', 'punch_list', 'closeout'],
  checklists: [
    { key: 'preconstruction_meeting', label: 'Preconstruction meeting' },
    { key: 'demo_protection', label: 'Demo and dust protection' },
    { key: 'pre_drywall_walk', label: 'Pre-drywall walk' },
    { key: 'final_walkthrough', label: 'Final walkthrough with the client' },
  ],
};

// ---------------------------------------------------------------------------
// home_builder — Home per lot; multi-home schedule and lender draws
// ---------------------------------------------------------------------------

export const homeBuilderExperience: ExperienceSlots = {
  roles: roles(
    ['Owner', 'projects_owner'], ['President', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Bookkeeper', 'projects_project_accountant'], ['Scheduler', 'projects_dispatcher'], ['Purchasing agent', 'projects_purchasing'],
    ['Construction manager', 'projects_pm'], ['Superintendent', 'projects_supervisor'], ['Field crew', 'projects_labor'],
    ['New home consultant', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'homes', 'communities', L('leads', 'Pipeline'), L('margin', 'Insights'), 'backlog', 'draws', 'settings'],
    admin: ['home', 'inbox', 'leads', 'homes', 'communities', 'jobs', 'schedule', 'selections', 'commitments', 'draws', 'customers', 'portals', 'settings'],
    pm: ['home', 'homes', 'my_jobs', 'schedule', 'selections', 'commitments', 'draws', L('punch', 'Warranty'), 'communities', 'inbox'],
    supervisor: ['today', 'my_jobs', 'schedule', 'crew_time', 'logs', L('punch', 'Punch & warranty'), 'documents'],
    sales: ['home', 'inbox', 'leads', 'appointments', 'homes', 'communities', 'proposals', 'customers'],
  },
  home: {
    pm: ['needs_you', 'my_jobs', 'draw_status', 'selections_queue', 'week_schedule'],
    supervisor: ['today_on_site', 'lookahead_constraints', 'open_punch', 'daily_report_status'],
  },
  jobTabs: {
    '*': { tabs: ['overview', 'home', 'schedule', 'selections', 'budget', 'commitments', 'draws', 'logs', T('punch', 'Warranty'), 'documents', T('portal', 'Buyer portal')] },
    spec_home: { tabs: ['overview', 'home', 'schedule', 'budget', 'commitments', 'draws', 'logs', T('punch', 'Warranty'), 'units', 'documents'] },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['stage_complete', 'daily_log', 'photo', 'trade_check_in', 'punch_item'] },
      labor: { '*': ['clock_in', 'photo', 'punch_item'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'gantt' }, multiJob: 'gantt', byGroup: { supervisor: 'crew_board', management: 'milestone_timeline' } },
  docTemplates: ['contract', 'purchase_order', 'change_order', 'selection_sheet', 'draw_request', 'daily_report', 'punch_list', 'closeout'],
  checklists: [
    { key: 'pre_pour', label: 'Pre-pour inspection' },
    { key: 'frame_walk', label: 'Frame walk' },
    { key: 'pre_drywall', label: 'Pre-drywall walk' },
    { key: 'blue_tape', label: 'Blue-tape walk' },
    { key: 'homeowner_orientation', label: 'Homeowner orientation' },
  ],
};

// ---------------------------------------------------------------------------
// field_service — Job with Visits; dispatch board
// ---------------------------------------------------------------------------

export const fieldServiceExperience: ExperienceSlots = {
  roles: roles(
    ['Owner', 'projects_owner'], ['General manager', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Bookkeeper', 'projects_project_accountant'], ['Dispatcher', 'projects_dispatcher'], ['CSR', 'projects_dispatcher'],
    ['Purchasing', 'projects_purchasing'], ['Service manager', 'projects_pm'], ['Install manager', 'projects_pm'],
    ['Field supervisor', 'projects_supervisor'], ['Technician', 'projects_labor'], ['Installer', 'projects_labor'],
    ['Comfort advisor', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'jobs', 'dispatch', 'scorecards', L('leads', 'Pipeline'), 'agreements', 'campaigns', L('margin', 'Insights'), 'settings'],
    admin: ['home', 'inbox', 'calls', 'dispatch', 'work_orders', 'call_log', 'fs_installs', 'jobs', 'agreements', 'equipment', 'price_book', 'invoice_review', L('billing', 'Invoices'), 'customers', 'capacity', 'settings'],
    pm: ['home', 'dispatch', 'capacity', 'my_jobs', 'work_orders', 'timesheets', 'agreements', 'equipment', 'price_book', L('billing', 'Invoices'), 'scorecards', 'inbox'],
    supervisor: ['today', 'dispatch', 'my_jobs', 'work_orders', 'crew_time', 'scorecards', 'documents'],
    sales: ['home', 'inbox', 'leads', 'customers', L('estimates', 'Options'), 'price_book', 'agreements', 'campaigns'],
  },
  home: {
    management: ['weekly_brief', 'cash_ar', 'jobs_at_risk', 'pipeline', 'approvals_queue'],
    admin: ['needs_you', 'dispatch_board', 'today_schedule', 'new_leads', 'billing_ready', 'setup_card'],
    pm: ['needs_you', 'dispatch_board', 'my_jobs', 'billing_due'],
  },
  jobTabs: {
    '*': {
      tabs: ['work_orders', T('estimates', 'Options'), 'equipment', T('billing', 'Invoice & payments'), 'agreement',
        T('activity', 'History'), 'overview'],
      defaultTab: 'work_orders',
    },
    replacement_install: {
      tabs: ['overview', T('estimates', 'Options'), 'schedule', 'work_orders', 'commitments', 'budget', T('billing', 'Invoice & payments'), 'equipment'],
    },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['on_my_way', 'photo', 'approve_crew_time'] },
      labor: {
        '*': ['on_my_way', 'start', 'present_options', 'take_payment', 'scan_equipment', 'sell_agreement'],
        replacement_install: ['clock_in', 'photo', 'checklist'],
      },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'dispatch', replacement_install: 'gantt' }, multiJob: 'dispatch', byGroup: {} },
  docTemplates: ['work_order', 'estimate', 'invoice', 'service_agreement', 'inspection_report', 'warranty_claim'],
  checklists: [
    { key: 'ac_tune_up', label: 'AC tune-up', jobTypes: ['maintenance_visit', 'service_call'] },
    { key: 'furnace_tune_up', label: 'Furnace tune-up', jobTypes: ['maintenance_visit', 'service_call'] },
    { key: 'install_startup', label: 'New install startup', jobTypes: ['replacement_install'] },
    { key: 'water_heater_install', label: 'Water heater install', jobTypes: ['replacement_install'] },
  ],
};

// ---------------------------------------------------------------------------
// manufacturing_eto — Job → release → work order → operation; capacity board
// ---------------------------------------------------------------------------

export const manufacturingEtoExperience: ExperienceSlots = {
  roles: roles(
    ['Owner', 'projects_owner'], ['Plant manager', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Controller', 'projects_project_accountant'], ['Production scheduler', 'projects_dispatcher'],
    ['Purchasing manager', 'projects_purchasing'], ['Project manager', 'projects_pm'], ['Production manager', 'projects_pm'],
    ['Shop foreman', 'projects_supervisor'], ['Install lead', 'projects_supervisor'], ['Shop worker', 'projects_labor'],
    ['Installer', 'projects_labor'], ['Estimator', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'jobs', 'production', 'shop_backlog', L('leads', 'Pipeline'), L('margin', 'Insights'), 'settings'],
    admin: ['home', 'inbox', 'leads', 'bid_board', 'estimates', 'jobs', 'production', 'cad_imports', 'materials', L('commitments', 'Purchasing'), 'installs', 'billing', 'customers', 'settings'],
    pm: ['home', 'my_jobs', 'bid_board', 'estimates', 'production', 'shop_backlog', 'cad_imports', 'materials', L('commitments', 'Purchasing'), 'installs', 'remakes', 'change_orders', 'billing', 'inbox'],
    supervisor: ['today', 'station', 'shop_floor', 'production', 'remakes', 'installs', 'my_jobs', 'crew_time', 'documents'],
  },
  home: {
    management: ['weekly_brief', 'backlog_capacity', 'jobs_at_risk', 'cash_ar', 'over_under_billing', 'approvals_queue'],
    pm: ['needs_you', 'capacity_board', 'my_jobs', 'week_schedule', 'billing_due'],
    supervisor: ['today_on_site', 'capacity_board', 'crew_time_to_approve', 'open_punch'],
  },
  jobTabs: {
    '*': {
      tabs: ['overview', T('estimates', 'Quote'), T('production', 'Releases & operations'), T('bom', 'BOM & cut list'),
        T('commitments', 'Purchasing'), T('schedule', 'Install'), 'budget', 'billing', 'change_orders'],
    },
    build_to_print: {
      tabs: ['overview', T('estimates', 'Quote'), T('production', 'Work orders & operations'), T('bom', 'BOM & cut list'),
        T('commitments', 'Purchasing'), 'budget', 'billing'],
    },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['approve_crew_time', 'flag_issue', 'photo'] },
      labor: { '*': ['operation_start_stop', 'good_scrap_qty', 'scan_label', 'flag_issue', 'clock_in'] },
    },
    kiosk: true,
  },
  schedule: { job: { '*': 'gantt' }, multiJob: 'production_capacity', byGroup: { supervisor: 'production_capacity' } },
  docTemplates: ['estimate', 'contract', 'change_order', 'purchase_order', 'work_order', 'delivery_receipt', 'invoice', 'closeout'],
  checklists: [
    { key: 'shop_drawing_review', label: 'Shop drawing review' },
    { key: 'finish_qc', label: 'Finish quality check' },
    { key: 'ship_check', label: 'Ship check' },
    { key: 'install_punch', label: 'Install punch' },
  ],
};

// ---------------------------------------------------------------------------
// flooring — Order; measure, install ticket; install board
// ---------------------------------------------------------------------------

export const flooringExperience: ExperienceSlots = {
  roles: roles(
    ['Owner', 'projects_owner'], ['Store manager', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Bookkeeper', 'projects_project_accountant'], ['Install coordinator', 'projects_dispatcher'], ['Purchasing', 'projects_purchasing'],
    ['Project manager', 'projects_pm'], ['Install lead', 'projects_supervisor'], ['Installer', 'projects_labor'],
    ['Measure tech', 'projects_labor'], ['Flooring consultant', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'flooring', 'jobs', L('leads', 'Pipeline'), 'estimates', L('margin', 'Insights'), 'settings'],
    admin: ['home', 'inbox', 'leads', 'flooring', L('selections', 'Measures'), 'estimates', 'jobs', L('dispatch', 'Install schedule'), L('work_orders', 'Install tickets'), 'flooring_rolls', 'flooring_catalog', L('commitments', 'Special orders'), 'billing', 'customers', 'settings'],
    pm: ['home', 'flooring', 'leads', 'estimates', 'my_jobs', L('dispatch', 'Install schedule'), 'flooring_rolls', L('commitments', 'Special orders'), 'flooring_pay', 'work_orders', 'inbox'],
    supervisor: ['today', L('dispatch', 'Install schedule'), 'my_jobs', 'work_orders', 'flooring_rolls', 'crew_time', L('punch', 'Callbacks'), 'documents'],
    labor: ['today', 'time', 'jobs', 'me'],
    sales: ['home', 'inbox', 'leads', 'flooring', 'estimates', 'flooring_catalog', 'customers', 'my_jobs'],
  },
  home: {
    admin: ['needs_you', 'install_board', 'today_schedule', 'new_leads', 'billing_ready'],
    pm: ['needs_you', 'install_board', 'my_jobs', 'billing_due'],
  },
  jobTabs: {
    '*': {
      tabs: ['overview', T('flooring_job', 'Measure to install'), T('estimates', 'Quote'), T('commitments', 'Products & POs'),
        'work_orders', T('billing', 'Deposits & billing'), T('punch', 'Callbacks'), T('selections', 'Selections'), T('portal', 'Customer portal')],
    },
    commercial_flooring: {
      tabs: ['overview', T('flooring_job', 'Measure to install'), 'estimates', 'budget', 'schedule', T('commitments', 'Products & POs'), 'work_orders', 'billing', 'change_orders', 'documents'],
    },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['start_ticket', 'photo', 'approve_crew_time'] },
      labor: { '*': ['measure_room', 'start_ticket', 'confirm_dye_lot', 'customer_sign_off', 'photo'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'install_board', commercial_flooring: 'calendar' }, multiJob: 'install_board', byGroup: {} },
  docTemplates: ['measure_sheet', 'estimate', 'contract', 'purchase_order', 'install_ticket', 'invoice', 'change_order'],
  checklists: [
    { key: 'subfloor_check', label: 'Subfloor check' },
    { key: 'moisture_test', label: 'Moisture test' },
    { key: 'install_sign_off', label: 'Install sign-off' },
  ],
};

// ---------------------------------------------------------------------------
// interior_design — Project with Items; FF&E item tracker
// ---------------------------------------------------------------------------

export const interiorDesignExperience: ExperienceSlots = {
  roles: roles(
    ['Principal designer', 'projects_owner'], ['Studio manager', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Bookkeeper', 'projects_project_accountant'], ['Design coordinator', 'projects_dispatcher'],
    ['Procurement coordinator', 'projects_purchasing'], ['Lead designer', 'projects_pm'], ['Install lead', 'projects_supervisor'],
    ['Design assistant', 'projects_labor'], ['Business development', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'design', 'jobs', L('leads', 'Pipeline'), L('margin', 'Insights'), 'time', 'settings'],
    admin: ['home', 'inbox', 'design', 'design_inbox', 'leads', 'jobs', 'selections', 'estimates', L('commitments', 'Purchasing'), 'billing', 'customers', 'time', 'portals', 'settings'],
    pm: ['home', 'design', 'design_inbox', 'my_jobs', 'selections', 'estimates', L('commitments', 'Purchasing'), 'time', 'customers', 'billing', 'inbox'],
    supervisor: ['today', 'my_jobs', 'design', 'selections', 'schedule', 'crew_time', 'punch', 'documents'],
  },
  home: {
    management: ['weekly_brief', 'utilization', 'cash_ar', 'jobs_at_risk', 'pipeline', 'approvals_queue'],
    pm: ['needs_you', 'item_tracker', 'my_jobs', 'client_updates', 'billing_due'],
  },
  jobTabs: {
    '*': {
      tabs: ['overview', T('design_project', 'Rooms & items'), 'estimates', 'commitments', 'receiving', T('time', 'Time & fees'),
        'billing', T('portal', 'Client view'), T('selections', 'Selections')],
    },
    procurement_order: { tabs: [T('design_project', 'Items'), 'estimates', 'commitments', 'receiving', 'billing', 'overview'], defaultTab: 'design_project' },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['receive_item', 'install_checklist', 'photo'] },
      labor: { '*': ['clip_product', 'receive_item', 'log_time', 'install_checklist'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'calendar' }, multiJob: 'calendar', byGroup: { management: 'resource_planner' } },
  docTemplates: ['design_agreement', 'proposal', 'purchase_order', 'invoice', 'delivery_receipt', 'closeout'],
  checklists: [
    { key: 'site_measure', label: 'Site measure' },
    { key: 'receiving_inspection', label: 'Receiving inspection' },
    { key: 'install_day', label: 'Install day' },
  ],
};

// ---------------------------------------------------------------------------
// equipment_dealer — Repair order, Deal, Unit; service board
// ---------------------------------------------------------------------------

export const equipmentDealerExperience: ExperienceSlots = {
  roles: roles(
    ['Dealer principal', 'projects_owner'], ['General manager', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Controller', 'projects_project_accountant'], ['Service writer', 'projects_dispatcher'], ['Parts manager', 'projects_purchasing'],
    ['Parts counter', 'projects_purchasing'], ['Service manager', 'projects_pm'], ['Shop foreman', 'projects_supervisor'],
    ['Technician', 'projects_labor'], ['Salesperson', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', L('stock', 'Units'), 'deals', 'store_scorecard', L('work_orders', 'Service'), 'jobs', L('margin', 'Insights'), 'settings'],
    admin: ['home', 'inbox', 'service_desk', L('work_orders', 'Service'), 'tech_board', 'jobs', L('stock', 'Units'), 'deals', L('parts', 'Parts'), 'parts_counter', 'price_files', 'rentals', 'warranty', 'warranty_deadlines', 'customers', 'settings'],
    pm: ['home', 'service_desk', L('work_orders', 'Service'), 'tech_board', 'my_jobs', L('stock', 'Units'), 'parts_counter', 'warranty', 'warranty_deadlines', 'rentals', 'programs', 'store_scorecard', 'inbox'],
    supervisor: ['today', L('work_orders', 'Service board'), 'tech_board', 'my_jobs', 'crew_time', 'parts', 'documents'],
    sales: ['home', 'inbox', 'leads', 'customers', L('stock', 'Units'), 'deals', 'programs'],
  },
  home: {
    management: ['weekly_brief', 'unit_aging', 'cash_ar', 'jobs_at_risk', 'approvals_queue'],
    admin: ['needs_you', 'service_board', 'today_schedule', 'billing_ready'],
    pm: ['needs_you', 'service_board', 'unit_aging', 'my_jobs'],
  },
  jobTabs: {
    '*': {
      tabs: [T('work_orders', 'Lines'), 'parts', T('time', 'Labor'), T('equipment', 'Unit history'), T('billing', 'Invoice'), 'overview', 'activity'],
      defaultTab: 'work_orders',
    },
    warranty_repair: {
      tabs: [T('work_orders', 'Lines'), 'parts', T('time', 'Labor'), 'warranty_claim', T('equipment', 'Unit history'), T('billing', 'Invoice'), 'overview', 'activity'],
      defaultTab: 'work_orders',
    },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['check_in_unit', 'rental_inspection', 'approve_crew_time'] },
      labor: { '*': ['clock_on_ro_line', 'voice_notes', 'request_part', 'check_in_unit', 'photo'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'service_board', field_service_call: 'dispatch' }, multiJob: 'service_board', byGroup: {} },
  docTemplates: ['repair_order', 'estimate', 'invoice', 'warranty_claim', 'buyers_order', 'rental_agreement', 'inspection_report'],
  checklists: [
    { key: 'pdi_checklist', label: 'Pre-delivery inspection', jobTypes: ['pdi_setup'] },
    { key: 'unit_check_in', label: 'Unit check-in' },
    { key: 'rental_out_in', label: 'Rental out and in inspection' },
  ],
};

// ---------------------------------------------------------------------------
// real_estate_development — Project per SPE/property; draw package
// ---------------------------------------------------------------------------

export const realEstateDevelopmentExperience: ExperienceSlots = {
  roles: roles(
    ['Principal', 'projects_owner'], ['Development director', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Development accountant', 'projects_project_accountant'], ['Project coordinator', 'projects_dispatcher'],
    ['Contracts manager', 'projects_purchasing'], ['Development manager', 'projects_pm'], ["Owner's representative", 'projects_supervisor'],
    ['Field staff', 'projects_labor'], ['Acquisitions manager', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'development', 'jobs', 'draws', L('job_cost', 'Budget'), L('margin', 'Insights'), 'documents', 'portals', 'settings'],
    admin: ['home', 'inbox', 'development', 'jobs', 'commitments', 'draws', 'units', 'documents', 'customers', 'portals', 'settings'],
    pm: ['home', 'development', 'my_jobs', L('job_cost', 'Budget'), 'commitments', 'draws', 'units', 'documents', 'change_orders', 'inbox'],
    supervisor: ['today', 'my_jobs', 'schedule', 'logs', 'punch', 'documents'],
  },
  home: {
    management: ['weekly_brief', 'draw_status', 'cash_ar', 'jobs_at_risk', 'approvals_queue'],
    pm: ['needs_you', 'draw_status', 'my_jobs', 'week_schedule'],
  },
  jobTabs: {
    '*': {
      tabs: ['overview', T('development', 'Pro forma & capital'), 'budget', T('commitments', 'Contracts & COs'), 'draws', T('schedule', 'Milestones'),
        'documents', 'units', 'change_orders', T('portal', 'Lender & investor portal')],
    },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['site_visit_report', 'photo', 'note'] },
      labor: { '*': ['site_visit_report', 'photo', 'note'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'milestone_timeline' }, multiJob: 'milestone_timeline', byGroup: {} },
  docTemplates: ['contract', 'draw_request', 'change_order', 'lien_waiver', 'closeout'],
  checklists: [
    { key: 'draw_inspection', label: 'Draw inspection walk' },
    { key: 'site_visit', label: 'Site visit report' },
    { key: 'closing_checklist', label: 'Closing checklist' },
  ],
};

// ---------------------------------------------------------------------------
// professional_services — Project; resource planner
// ---------------------------------------------------------------------------

export const professionalServicesExperience: ExperienceSlots = {
  roles: roles(
    ['Principal', 'projects_owner'], ['Managing director', 'projects_gm'], ['Office manager', 'projects_office_manager'],
    ['Bookkeeper', 'projects_project_accountant'], ['Resource manager', 'projects_dispatcher'],
    ['Operations coordinator', 'projects_purchasing'], ['Project manager', 'projects_pm'], ['Team lead', 'projects_supervisor'],
    ['Consultant', 'projects_labor'], ['Business development', 'projects_sales'],
  ),
  nav: {
    management: ['home', 'inbox', 'approvals', 'jobs', L('leads', 'Pipeline'), L('margin', 'Insights'), 'time', 'settings'],
    admin: ['home', 'inbox', 'leads', 'jobs', 'estimates', 'time', L('schedule', 'Resourcing'), 'billing', 'customers', 'settings'],
    pm: ['home', 'my_jobs', 'estimates', 'time', L('schedule', 'Resourcing'), 'billing', 'change_orders', 'inbox'],
    supervisor: ['today', 'my_jobs', 'schedule', 'crew_time', 'documents'],
  },
  home: {
    management: ['weekly_brief', 'utilization', 'cash_ar', 'jobs_at_risk', 'pipeline', 'approvals_queue'],
    pm: ['needs_you', 'utilization', 'my_jobs', 'billing_due'],
  },
  jobTabs: {
    '*': {
      tabs: ['overview', T('schedule', 'Phases & tasks'), 'time', T('budget', 'Budget (hours & fees)'), 'change_orders', 'billing', T('documents', 'Files')],
    },
    monthly_retainer: { tabs: ['overview', 'time', T('budget', 'Budget (hours & fees)'), 'billing', T('documents', 'Files')] },
  },
  mobile: {
    actions: {
      supervisor: { '*': ['timer', 'approve_crew_time', 'expense_receipt'] },
      labor: { '*': ['timer', 'log_time', 'expense_receipt'] },
    },
    kiosk: false,
  },
  schedule: { job: { '*': 'gantt' }, multiJob: 'resource_planner', byGroup: {} },
  docTemplates: ['proposal', 'contract', 'change_order', 'invoice'],
  checklists: [
    { key: 'project_kickoff', label: 'Project kickoff' },
    { key: 'project_closeout', label: 'Project closeout' },
  ],
};
