"""Capability catalog (05-RBAC-SPEC 2.2) in plain English, plus the sample roles.
Action letters: V view C create E edit D delete A approve P post R release X export K configure."""
import json

ACTIONS = [("V", "View"), ("C", "Create"), ("E", "Edit"), ("D", "Delete"), ("A", "Approve"),
           ("P", "Post"), ("R", "Release"), ("X", "Export"), ("K", "Configure")]

# domain, [(key, label, actions, flags)]  flags: M money · S sensitive · L re-verify (step-up)
CATALOG = [
 ("GL", "General ledger", [
   ("gl.accounts", "Chart of accounts", "VCEDAXK", ""),
   ("gl.journal_entries", "Journal entries", "VCEDAPX", ""),
   ("gl.recurring_entries", "Recurring entries", "VCEDAP", ""),
   ("gl.periods", "Periods", "VEAK", ""),
   ("gl.period_override", "Post to a soft-closed period", "P", "L"),
   ("gl.reporting_basis", "Cash and tax basis adjustments", "VCEP", ""),
   ("gl.dimensions", "Departments, classes, items", "VCEDK", ""),
   ("gl.year_end", "Year-end close", "VP", ""),
   ("gl.intercompany", "Intercompany", "VCEAP", ""),
   ("gl.internal_invoices", "Internal invoices", "VCEAPR", ""),
   ("gl.posted_edit", "Edit posted records", "E", "L")]),
 ("Close", "Close", [
   ("close.checklist", "Close checklist", "VEAK", ""),
   ("close.package", "Client close packet", "VXR", "")]),
 ("Bank", "Bank", [
   ("bank.connections", "Bank connections", "VCDK", "S"),
   ("bank.transactions", "Bank transactions", "VEAX", ""),
   ("bank.rules", "Coding rules", "VCED", ""),
   ("bank.statements", "Statements", "VC", ""),
   ("bank.reconciliations", "Reconciliations", "VCEAX", ""),
   ("bank.transfers", "Transfers", "VCAR", "M")]),
 ("Cards", "Cards", [
   ("cards.transactions", "Card transactions", "VEAX", ""),
   ("cards.ramp_sync", "Ramp sync", "VK", "")]),
 ("AP", "Bills & purchasing", [
   ("ap.bills", "Bills", "VCEDAPX", ""),
   ("ap.vendor_credits", "Vendor credits", "VCAP", ""),
   ("ap.purchase_orders", "Purchase orders", "VCEDA", ""),
   ("ap.policy", "AP policy", "VK", "")]),
 ("Payments", "Payments", [
   ("pay.batches", "Pay runs", "VCEARX", "M"),
   ("pay.checks", "Checks", "VCEP", ""),
   ("pay.customer_payments", "Customer payments", "VCEP", ""),
   ("pay.refunds", "Refunds", "VCAR", "M"),
   ("pay.vendor_bank_details", "Vendor bank details", "VE", "SL"),
   ("pay.provider_connections", "Payment provider setup", "VK", "L")]),
 ("Expenses", "Expenses", [
   ("exp.receipts", "Receipts", "VCEDA", ""),
   ("exp.reports", "Expense reports", "VCEA", ""),
   ("exp.reimbursements", "Reimbursements", "VCAR", "M"),
   ("exp.policy", "Expense policy", "VK", "")]),
 ("AR", "Invoices & collections", [
   ("ar.invoices", "Invoices", "VCEDAPRX", ""),
   ("ar.credit_memos", "Credit memos", "VCAP", ""),
   ("ar.write_offs", "Write-offs", "VCAP", ""),
   ("ar.estimates", "Estimates", "VCEDR", ""),
   ("ar.deposits", "Customer deposits", "VCP", ""),
   ("ar.recurring", "Recurring invoices", "VCED", ""),
   ("ar.collections", "Collections", "VER", ""),
   ("ar.statements", "Customer statements", "VR", ""),
   ("ar.payment_links", "Pay Now links", "VK", "")]),
 ("Rev rec", "Revenue recognition", [
   ("revrec.methods", "Methods by job", "VEK", ""),
   ("revrec.runs", "Recognition runs", "VCP", ""),
   ("revrec.schedules", "Schedules", "VX", "")]),
 ("Jobs", "Jobs", [
   ("jobs.jobs", "Jobs and cost codes", "VCED", ""),
   ("jobs.change_orders", "Change orders", "VCA", ""),
   ("jobs.wip", "WIP schedule", "VEPX", "")]),
 ("Inventory", "Inventory", [
   ("inv.items", "Items", "VCED", ""),
   ("inv.movements", "Movements", "VCAP", ""),
   ("inv.valuation", "Valuation", "VPK", "")]),
 ("Assets", "Assets, leases, prepaids", [
   ("fa.assets", "Fixed assets", "VCEDP", ""),
   ("fa.leases", "Leases", "VCEP", ""),
   ("fa.prepaids", "Prepaids", "VCEP", "")]),
 ("Debt", "Debt & covenants", [
   ("debt.loans", "Loans", "VCEP", ""),
   ("debt.covenants", "Covenants", "VEK", ""),
   ("debt.certificates", "Compliance certificates", "VCAR", ""),
   ("debt.borrowing_base", "Borrowing base", "VCAR", "")]),
 ("Cash", "Cash", [
   ("cash.position", "Cash position", "V", ""),
   ("cash.forecast", "Forecast", "VCE", ""),
   ("cash.obligations", "Renewals and subscriptions", "VCE", "")]),
 ("Payroll", "Payroll", [
   ("payroll.runs", "Payroll runs", "VCEAR", "M"),
   ("payroll.register", "Payroll register", "VCP", ""),
   ("payroll.employees", "Employee records", "VCE", "S"),
   ("payroll.remittances", "Remittances", "VCR", "M"),
   ("payroll.settings", "Payroll settings", "VK", "")]),
 ("Tax", "Tax", [
   ("tax.sales_tax", "Sales tax", "VEPK", ""),
   ("tax.filings", "Filings", "VCAR", ""),
   ("tax.1099", "1099s", "VCEX", "S"),
   ("tax.provision", "Tax provision", "VCEP", "")]),
 ("FP&A", "Budgets & planning", [
   ("fpa.budgets", "Budgets", "VCEAX", ""),
   ("fpa.scenarios", "Scenarios", "VCE", ""),
   ("fpa.profitability", "Profitability", "VX", "")]),
 ("Reports", "Reports", [
   ("reports.financial", "Financial reports", "VX", ""),
   ("reports.saved_views", "Saved views", "VCED", ""),
   ("reports.packs", "Report packs", "VCER", ""),
   ("reports.board_package", "Board package", "VCAR", "")]),
 ("Consolidation", "Consolidation", [
   ("consol.groups", "Groups", "VCEDK", ""),
   ("consol.statements", "Consolidated statements", "VX", ""),
   ("consol.eliminations", "Group adjustments", "VCP", "")]),
 ("Controls", "Controls & audit", [
   ("ctl.exceptions", "Exceptions", "VEA", ""),
   ("ctl.approval_workflows", "Approval workflows", "VK", ""),
   ("ctl.compliance", "Compliance", "VEA", ""),
   ("ctl.vendor_compliance", "W-9 and COI", "VEA", ""),
   ("ctl.pbc", "Auditor requests", "VCEA", ""),
   ("ctl.audit_trail", "Audit trail", "VX", ""),
   ("ctl.ai_decisions", "AI decision log", "VX", "")]),
 ("Masters", "Vendors & customers", [
   ("mdm.vendors", "Vendors", "VCED", ""),
   ("mdm.customers", "Customers", "VCED", ""),
   ("mdm.items", "Products and services", "VCED", "")]),
 ("Requests", "Requests & portals", [
   ("docs.documents", "Documents", "VCDX", ""),
   ("req.client_requests", "Client requests", "VCER", ""),
   ("portal.customer", "Customer portal", "VKR", ""),
   ("portal.vendor", "Vendor portal", "VKR", "")]),
 ("Onboarding", "Onboarding", [
   ("onb.clients", "Clients", "VCED", ""),
   ("onb.wizard", "Setup wizard", "VE", ""),
   ("onb.imports", "Imports", "VCP", ""),
   ("onb.conversion", "Conversion tie-out", "VAP", "")]),
 ("Integrations", "Integrations", [
   ("int.connections", "Connections", "VCDK", "L"),
   ("int.api_keys", "API keys", "VCD", "L"),
   ("int.sync_runs", "Sync runs", "VE", "")]),
 ("AI", "AI & automation", [
   ("ai.assist", "Assistant", "V", ""),
   ("ai.agents", "Agents", "VCK", ""),
   ("ai.autonomy", "Autonomy dial", "VK", "L")]),
 ("Workspace", "Workspace", [
   ("home.workspace", "Workspace home", "V", ""),
   ("ws.client_health", "Client health", "V", ""),
   ("ws.assignments", "Capacity assignments", "VCED", "")]),
 ("Access", "Access", [
   ("core.access.members", "Members", "VCED", ""),
   ("core.access.roles", "Roles", "VCEDK", "L"),
   ("core.access.assignments", "Grant access", "VCED", "L"),
   ("core.access.reviews", "Access reviews", "VCAX", ""),
   ("core.access.simulate", "View as", "V", ""),
   ("core.access.sod_policy", "Conflict rules", "VK", "L")]),
 ("Tenant", "Tenant settings", [
   ("core.tenant.settings", "Security and branding", "VK", "L"),
   ("core.tenant.accounting_settings", "Accounting settings", "VK", ""),
   ("core.tenant.billing", "Plan and billing", "VK", ""),
   ("core.tenant.dashboard_layouts", "Dashboard layouts", "VK", ""),
   ("core.tenant.export", "Full export", "X", "L")]),
]

# Accounting manager: what its 3 holders have today ("Current", published Oct 2)
AM_V5 = {
 "gl.accounts": "VCEDAX", "gl.journal_entries": "VCEDAPX", "gl.recurring_entries": "VCEDAP", "gl.periods": "VE",
 "gl.reporting_basis": "VCEP", "gl.dimensions": "VCED", "gl.year_end": "V", "gl.intercompany": "VCEAP",
 "gl.internal_invoices": "VCEAP", "close.checklist": "VEA", "close.package": "VXR",
 "bank.connections": "VC", "bank.transactions": "VEAX", "bank.rules": "VCED", "bank.statements": "VC",
 "bank.reconciliations": "VCEAX", "bank.transfers": "VC", "cards.transactions": "VEAX", "cards.ramp_sync": "V",
 "ap.bills": "VCEDAPX", "ap.vendor_credits": "VCAP", "ap.purchase_orders": "VCEDA", "ap.policy": "V",
 "pay.batches": "VCEAX", "pay.checks": "VCE", "pay.customer_payments": "VCEP", "pay.refunds": "VCA",
 "pay.vendor_bank_details": "V", "pay.provider_connections": "V",
 "exp.receipts": "VCEDA", "exp.reports": "VCEA", "exp.reimbursements": "VCA", "exp.policy": "V",
 "ar.invoices": "VCEDAPRX", "ar.credit_memos": "VCAP", "ar.write_offs": "VC", "ar.estimates": "VCEDR",
 "ar.deposits": "VCP", "ar.recurring": "VCED", "ar.collections": "VER", "ar.statements": "VR", "ar.payment_links": "V",
 "revrec.methods": "VE", "revrec.runs": "VCP", "revrec.schedules": "VX",
 "jobs.jobs": "VCED", "jobs.change_orders": "VCA", "jobs.wip": "VEPX",
 "inv.items": "VCED", "inv.movements": "VCA", "inv.valuation": "V",
 "fa.assets": "VCEDP", "fa.leases": "VCEP", "fa.prepaids": "VCEP",
 "debt.loans": "VCE", "debt.covenants": "VE", "debt.certificates": "VC", "debt.borrowing_base": "VC",
 "cash.position": "V", "cash.forecast": "VCE", "cash.obligations": "VCE",
 "payroll.runs": "VCEA", "payroll.register": "VCP", "payroll.employees": "VCE", "payroll.remittances": "VC", "payroll.settings": "V",
 "tax.sales_tax": "VE", "tax.filings": "VC", "tax.1099": "VCEX", "tax.provision": "VCE",
 "fpa.budgets": "V", "fpa.scenarios": "V", "fpa.profitability": "VX",
 "reports.financial": "VX", "reports.saved_views": "VCED", "reports.packs": "VCER", "reports.board_package": "V",
 "ctl.exceptions": "VEA", "ctl.approval_workflows": "V", "ctl.compliance": "VE", "ctl.vendor_compliance": "VEA",
 "ctl.pbc": "VCEA", "ctl.audit_trail": "VX", "ctl.ai_decisions": "VX",
 "mdm.vendors": "VCED", "mdm.customers": "VCED", "mdm.items": "VCED",
 "docs.documents": "VCDX", "req.client_requests": "VCER", "portal.customer": "VR", "portal.vendor": "VR",
 "onb.clients": "VCE", "onb.wizard": "VE", "onb.imports": "VCP", "onb.conversion": "VAP",
 "int.connections": "VC", "int.sync_runs": "VE",
 "ai.assist": "V", "ai.agents": "VC", "ai.autonomy": "V",
 "home.workspace": "V", "ws.client_health": "V", "ws.assignments": "VCED",
 "core.access.members": "VCE", "core.access.roles": "V", "core.access.assignments": "VCED", "core.access.reviews": "VA",
 "core.access.simulate": "V", "core.access.sod_policy": "V",
 "core.tenant.settings": "V", "core.tenant.accounting_settings": "V", "core.tenant.dashboard_layouts": "VK",
}

# The platform template the tenant role was cloned from (v4): no layout publishing, write-offs approve on.
AM_TPL4 = dict(AM_V5); AM_TPL4["core.tenant.dashboard_layouts"] = "V"; AM_TPL4["ar.write_offs"] = "VCAP"
# Latest template (v5, Oct 14): connections no longer create; adds read of AI autonomy? no: adds 1099 export already; adds sales tax post.
AM_TPL5 = dict(AM_TPL4); AM_TPL5["int.connections"] = "V"; AM_TPL5["tax.sales_tax"] = "VEP"
# Mike's proposed changes (the one editable draft)
AM_DRAFT = dict(AM_V5); AM_DRAFT["pay.batches"] = "VCEARX"; AM_DRAFT["payroll.runs"] = "VCEAR"; AM_DRAFT["int.connections"] = "V"

LIMITS_V5 = {"ap.bills:A": "≤ $25,000", "gl.journal_entries:P": "≤ $25,000", "pay.batches:A": "≤ $25,000",
             "payroll.runs:A": "≤ $40,000", "exp.reports:A": "≤ $5,000"}
LIMITS_DRAFT = dict(LIMITS_V5); LIMITS_DRAFT["ap.bills:A"] = "≤ $35,000"; LIMITS_DRAFT["pay.batches:R"] = "≤ $25,000 · $60,000 a day"

# SoD rules (05 4.3). "any money release" is read as [M] releases (see spec issue).
# The id is internal only and is never rendered. "p" is the one plain sentence the UI shows;
# "fix" is the suggested fix: ("rm", capability) removes a grant, ("ctl", text) adds a control.
SOD = [
 {"id": "S1", "need": ["pay.batches:C", "pay.batches:A", "pay.batches:R"], "hard": False,
  "p": "Could create, approve and release the same pay run.",
  "fix": ("ctl", "Require a second person on releases over $10,000")},
 {"id": "S2", "need": ["pay.vendor_bank_details:E", "pay.batches:R"], "hard": True,
  "p": "Could change where a vendor gets paid and then send the payment.",
  "fix": ("rm", "pay.vendor_bank_details:E")},
 {"id": "S4", "need": ["payroll.employees:E", "payroll.runs:R"], "hard": True,
  "p": "Could change an employee’s pay and then release payroll.",
  "fix": ("rm", "payroll.runs:R")},
 {"id": "S5", "need": ["gl.journal_entries:P", "gl.periods:E"], "hard": False,
  "p": "Could reopen a closed month and post entries into it.",
  "fix": ("ctl", "Have the controller approve every reopened month")},
 {"id": "S6", "need": ["core.access.assignments:C", "@release_money"], "hard": False,
  "p": "Could give people access and also release money, so two managers could give each other release.",
  "fix": ("ctl", "Only let managers grant roles that can’t release money")},
 {"id": "S7", "need": ["mdm.vendors:C", "ap.bills:A", "pay.batches:R"], "hard": False,
  "p": "Could add a vendor, approve its bill and pay it.",
  "fix": ("ctl", "Require a second approver on a new vendor’s first payment")},
 {"id": "S8", "need": ["ai.autonomy:K", "pay.batches:R"], "hard": False,
  "p": "Could switch on automatic actions for payments it also releases.",
  "fix": ("rm", "ai.autonomy:K")},
]


def js_base():
    return "window.MB=" + json.dumps({"actions": ACTIONS, "catalog": CATALOG, "sod": SOD}, ensure_ascii=False, separators=(",", ":")) + ";"


def js_data(**extra):
    return js_base() + "\nObject.assign(MB," + json.dumps(extra, ensure_ascii=False, separators=(",", ":")) + ");"
