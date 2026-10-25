/**
 * The explicit list of money keys per object type, by the capability that reveals them
 * (spec §2.1 money tags, §4 response masking). Built from the row shapes the API returns
 * (lib/pm/types.ts, lib/pm/money/types.ts, lib/pm/dealer/types.ts, lib/pm/labor/types.ts,
 * lib/pm/ops/types.ts) and the widget payloads (lib/pm/dealer|ops/widget-queries.ts).
 *
 *   financials      cost, budget, committed, actual, margin, WIP, job cost, estimate cost lines,
 *                   dealer deal gross / unit cost / floor plan, development finance
 *   contract_value  contract / sell price, change-order, invoice, billing, deposit, allowance amounts
 *   labor_rates     individual pay rates and burden (field-class comp)
 *
 * PUBLIC keys are price-list figures every role may see (price-book sell, part list/counter
 * price, advertised unit price, rental rate card) — the dispatcher "price-book sell only" rule.
 * A key that is PUBLIC for one object type and money for another is money unless the route
 * declares the object type that makes it public.
 *
 * Anything that looks like money (`*_cents`, `*Cents`, margin / gross / markup / burden) but is
 * in no list is treated as needing BOTH financials and contract_value (fail closed).
 */

export type MoneyClass = 'financials' | 'contract_value' | 'labor_rates';

export interface MoneyKeyList {
  financials?: readonly string[];
  contract_value?: readonly string[];
  labor_rates?: readonly string[];
  public?: readonly string[];
}

export const MONEY_KEYS = {
  /** v_project_list, v_job_overview, v_job_money (JobFinancialsRow), progress snapshots, contracts. */
  job: {
    contract_value: [
      'original_contract_cents', 'approved_co_cents', 'revised_contract_cents', 'contract_revised_cents', 'pending_co_cents',
      'contract_value_cents', 'pending_co_value_cents', 'original_cents', 'billed_to_date_cents', 'billed_net_to_date_cents',
      'retainage_held_cents', 'retainage_released_cents', 'retainage_outstanding_cents', 'deposits_requested_cents',
      'contractCents', 'contract_price_cents', 'p_contract_cents',
    ],
    financials: [
      'budget_total_cents', 'budget_original_cents', 'budget_revised_cents', 'revised_budget_cents', 'cost_estimate_cents',
      'projected_margin_cents', 'projected_margin_pct', 'committed_cents', 'committed_open_cents', 'actual_cost_cents',
      'pending_cost_cents', 'forecast_by_cost_code_cents', 'projected_final_cost_cents', 'cost_to_complete_cents',
      'earned_revenue_cents', 'over_under_billing_cents', 'pct_complete_cost', 'marginCents', 'margin_pct', 'margin_cents',
    ],
  },
  /** pm.budget_lines, v_cost_code_status, budget revisions. */
  budget: {
    financials: [
      'amount_cents', 'budget_cents', 'committed_cents', 'committed_open_cents', 'actual_cents', 'pending_cents',
      'uncommitted_cost_cents', 'forecast_cents', 'variance_cents', 'original_cents', 'revised_cents', 'amountCents',
    ],
  },
  /** pm.job_costs (cost drain from Books). */
  cost: {
    financials: ['amount_cents', 'cost_cents', 'actual_cents', 'actual_cost_cents', 'amountCents', 'costCents'],
  },
  /** Commitments (POs / subcontracts), lines, changes, receipts, compliance, v_commitment_status. */
  commitment: {
    financials: [
      'amount_cents', 'unit_cost_cents', 'original_amount_cents', 'received_cents', 'billed_cents', 'approved_change_cents',
      'revised_amount_cents', 'open_cents', 'over_billed_cents', 'received_not_billed_cents', 'amountCents', 'unitCostCents',
      'committed', 'original', 'received', 'billed', 'overBilled', 'receivedNotBilled',
    ],
  },
  /** pm.change_orders: the price is a contract figure, the cost impact is cost. */
  change_order: {
    contract_value: ['amount_cents', 'amountCents'],
    financials: ['cost_impact_cents', 'costImpactCents'],
  },
  /** Billing requests, lines, pay applications (G702/G703), SOV, deposits, allowances, retainage, milestones. */
  billing: {
    contract_value: [
      'amount_cents', 'gross_earned_cents', 'retainage_cents', 'retainage_released_cents', 'net_cents', 'scheduled_value_cents',
      'previous_work_cents', 'this_period_work_cents', 'stored_materials_cents', 'previous_stored_cents', 'total_completed_cents',
      'balance_to_finish_cents', 'retainage_work_to_date_cents', 'retainage_stored_to_date_cents', 'retainage_this_period_cents',
      'original_contract_cents', 'net_change_by_co_cents', 'contract_sum_to_date_cents', 'total_completed_stored_cents',
      'retainage_work_cents', 'retainage_stored_cents', 'retainage_total_cents', 'total_earned_less_retainage_cents',
      'previous_certificates_cents', 'current_payment_due_cents', 'balance_to_finish_incl_retainage_cents', 'request_net_cents',
      'work_completed_cents', 'completed_and_stored_cents', 'retainage_held_cents', 'retainage_outstanding_cents',
      'allowance_cents', 'actual_cents', 'held_cents', 'released_cents', 'outstanding_cents', 'billing_amount_cents',
      'billed_to_date_cents', 'billed_net_to_date_cents', 'deposits_requested_cents', 'revised_contract_cents',
      'amountCents', 'scheduledValueCents', 'workToDateCents', 'previousWorkCents', 'previousStoredCents', 'thisPeriodCents',
      'storedMaterialsCents', 'previousRetainageCents', 'previousRetainageHeldCents', 'previousCertificatesCents',
      'retainageReleasedCents', 'requestedCents', 'lineAmountCents', 'billedToDateCents', 'heldToDateCents',
    ],
  },
  /** Estimates and estimate lines: sell is contract, cost lines and margin are cost. */
  estimate: {
    contract_value: ['total_cents', 'unit_price_cents', 'amount_cents', 'unitPriceCents', 'amountCents', 'sell', 'allowances'],
    financials: [
      'cost_total_cents', 'unit_cost_cents', 'cost_cents', 'unitCostCents', 'costCents', 'margin', 'marginPct',
      'markup_pct', 'markupPct', 'cost', 'margin_cents', 'margin_pct',
    ],
    labor_rates: ['estimatingRateCents', 'estimating_rate_cents'],
  },
  /** pm.time_entries: the pinned pay rate is individual comp; the bill rate is sell. */
  time_entry: {
    labor_rates: ['cost_rate_cents', 'costRateCents', 'pinnedCostRateCents'],
    contract_value: ['bill_rate_cents', 'billRateCents'],
    financials: ['cost_cents', 'costCents', 'amount_cents'],
  },
  /** v_labor_rates, rate cards, employee cards, labor settings. */
  labor_rate: {
    labor_rates: [
      'base_rate_cents', 'cost_rate_cents', 'burden_pct', 'card_burden_pct', 'overhead_pct', 'card_overhead_pct',
      'overhead_rate_cents', 'estimating_rate_cents', 'default_burden_pct', 'default_overhead_pct', 'p_base_rate_cents',
      'baseRateCents', 'costRateCents', 'overheadRateCents', 'estimatingRateCents', 'baseCents', 'overheadCents', 'estimatingCents',
      'burdenPct', 'overheadPct', 'rateCents', 'rate_cents',
    ],
    contract_value: ['bill_rate_cents', 'billRateCents', 'p_bill_rate_cents'],
  },
  /** Dealer deals: price is contract; cost, gross, reserve, ACV, payoff are financials (spec: deal gross = financials). */
  dealer_deal: {
    contract_value: [
      'sale_price_cents', 'merchandise_cents', 'discount_cents', 'fees_cents', 'rebates_cents', 'incentives_cents',
      'trade_allowance_cents', 'allowance_cents', 'fi_price_cents', 'taxable_estimate_cents', 'tax_estimate_cents',
      'deposits_cents', 'cash_price_cents', 'balance_due_estimate_cents', 'amount_financed_cents', 'unit_price_cents',
      'amount_cents', 'price_cents', 'unitPriceCents', 'priceCents', 'amountFinancedCents', 'amountCents',
    ],
    financials: [
      'unit_cost_cents', 'cost_cents', 'fee_cost_cents', 'fi_cost_cents', 'trade_acv_cents', 'acv_cents', 'over_allowance_cents',
      'trade_payoff_cents', 'payoff_cents', 'finance_reserve_cents', 'subvention_cents', 'front_gross_cents', 'back_gross_cents',
      'total_gross_cents', 'front_gross_pct', 'grossCents', 'toDeskGrossCents', 'pct', 'unitCostCents', 'costCents',
      'acvCents', 'payoffCents', 'financeReserveCents', 'subventionCents', 'overAllowanceCents', 'frontCents',
      'margin_floor_pct', 'min_front_gross_cents', 'minFrontGrossCents',
    ],
  },
  /** Dealer units in stock: cost, books cost, floor plan are financials; retail/advertised price is a price list. */
  dealer_unit: {
    financials: [
      'cost_cents', 'dealer_cost_cents', 'books_cost_cents', 'cost_acked_by_books_cents', 'payoff_cents', 'principal_cents',
      'curtailment_cents', 'amount_cents', 'labor_cents', 'parts_cents', 'costCents', 'agedCostCents', 'amountCents',
      'payoffCents', 'extended_cost_cents',
    ],
    public: ['retail_price_cents', 'advertised_price_cents', 'retailPriceCents', 'advertisedPriceCents', 'list_price_cents'],
  },
  /** Dealer settings: margin floor and minimum front gross. */
  dealer_settings: {
    financials: ['margin_floor_pct', 'min_front_gross_cents', 'minFrontGrossCents', 'marginFloorPct'],
  },
  /** Parts catalog and on-hand: counter price is public; cost is financials. */
  part: {
    financials: ['cost_cents', 'extended_cost_cents', 'unit_cost_cents', 'costCents', 'unitCostCents'],
    public: ['list_price_cents', 'price_cents', 'core_charge_cents', 'listPriceCents', 'priceCents', 'coreChargeCents'],
  },
  /** Parts counter tickets: the sale is contract (invoice) money, the cost is financials. */
  parts_ticket: {
    contract_value: [
      'unit_price_cents', 'amount_cents', 'core_charge_cents', 'core_charges_cents', 'total_cents', 'merchandise_cents',
      'discount_cents', 'tax_estimate_cents', 'tax_cents', 'subtotal_cents', 'unitPriceCents', 'amountCents',
    ],
    financials: ['unit_cost_cents', 'cost_cents', 'cost_total_cents', 'margin_cents', 'unitCostCents', 'costCents'],
  },
  /** Parts purchase orders: cost. */
  parts_order: {
    financials: ['unit_cost_cents', 'amount_cents', 'extended_cost_cents', 'unitCostCents'],
  },
  /** Repair orders (dealer service): sell lines are contract; cost is financials; warranty claim amounts are billed (contract). */
  repair_order: {
    contract_value: ['unit_price_cents', 'amount_cents', 'claimed_cents', 'unitPriceCents', 'amountCents'],
    financials: ['unit_cost_cents', 'cost_cents', 'sublet_cost_cents', 'unitCostCents'],
  },
  /** Warranty claims (the OEM is billed): contract money. */
  warranty_claim: {
    contract_value: [
      'claimed_labor_cents', 'claimed_parts_cents', 'claimed_other_cents', 'claimed_cents', 'approved_cents', 'paid_cents',
      'short_paid_cents', 'outstanding_cents', 'claimedLaborCents', 'claimedPartsCents', 'claimedOtherCents',
    ],
  },
  /** Rental contracts and billing: negotiated rates and charges are contract; the rate card is a price list. */
  rental: {
    contract_value: [
      'rate_day_cents', 'rate_week_cents', 'rate_month_cents', 'damage_cents', 'fuel_cents', 'cleaning_cents', 'delivery_cents',
      'rental_cents', 'damage_waiver_cents', 'fees_cents', 'total_cents', 'waiverCents', 'feesCents', 'damageCents', 'fuelCents',
      'cleaningCents', 'deliveryCents',
    ],
    public: ['day_cents', 'week_cents', 'month_cents', 'damage_waiver_pct', 'dayCents', 'weekCents', 'monthCents'],
  },
  /** Field-service / shop work orders and their lines. */
  work_order: {
    contract_value: ['unit_price_cents', 'amount_cents', 'total_cents', 'unitPriceCents', 'amountCents'],
    financials: ['unit_cost_cents', 'cost_cents', 'unitCostCents', 'costCents', 'rate_cents', 'rateCents'],
  },
  /** Price book: sell is public (dispatcher rule); cost is financials. */
  price_book: {
    financials: ['cost_cents', 'costCents'],
    public: ['price_cents', 'priceCents'],
  },
  /**
   * Field-service option builder (1117: fs_estimates, options, option items, option totals): the
   * good / better / best sell prices are price-book sell figures the tech presents at the kitchen
   * table, so they are public like the price book (dispatcher "price-book sell only" rule); the
   * cost behind each line is financials.
   */
  fs_estimate: {
    public: [
      'unit_price_cents', 'member_unit_price_cents', 'unitPriceCents', 'memberUnitPriceCents', 'regular_cents', 'member_cents',
      'rebate_cents', 'regularCents', 'memberCents', 'rebateCents', 'deposit_cents', 'depositCents', 'price_cents', 'priceCents',
      'member_price_cents', 'memberPriceCents',
    ],
    financials: ['unit_cost_cents', 'unitCostCents', 'cost_cents', 'costCents', 'margin_cents', 'marginCents', 'gm_pct'],
  },
  /**
   * Commercial depth (1120: cm_change_events, PCOs, RFQs, exposure). Owner-side figures (ROM
   * revenue, PCO price, exposure with the owner) are contract; sub pricing and cost are cost;
   * markup is a margin figure (both).
   */
  change_event: {
    contract_value: [
      'rom_revenue_cents', 'amount_cents', 'approved_cents', 'pending_cents', 'pending_over_30_cents', 'rejected_cents',
      'unpriced_rom_cents', 'owner_co_without_sub_co_cents', 'markup_cents', 'romRevenueCents', 'amountCents',
    ],
    financials: ['rom_cost_cents', 'cost_cents', 'total_cents', 'markup_cents', 'sub_co_without_owner_co_cents', 'romCostCents', 'costCents'],
  },
  /** WIP schedule and EAC forecasts (1120 cm_v_wip, cm_eac_forecasts / lines). */
  wip: {
    contract_value: [
      'contract_original_cents', 'approved_co_cents', 'contract_cents', 'billed_cents', 'pending_co_cents', 'backlog_cents',
      'gp_cents',
    ],
    financials: [
      'eac_cents', 'cost_to_date_cents', 'uninstalled_materials_cents', 'earned_cents', 'over_billed_cents', 'under_billed_cents',
      'gp_cents', 'loss_provision_cents', 'total_budget_cents', 'total_actual_cents', 'total_ctc_cents', 'total_eac_cents',
      'prior_eac_cents', 'budget_cents', 'committed_cents', 'actual_cents', 'pending_cents', 'ctc_cents',
    ],
  },
  /** Sub pay applications (1120 cm_sub_pay_apps, 1118 portal_pay_apps): what the GC pays subs — cost. */
  sub_pay_app: {
    financials: [
      'scheduled_value_cents', 'gross_this_period_cents', 'work_to_date_cents', 'retainage_this_period_cents', 'net_due_cents',
      'gross_cents', 'retainage_cents', 'net_cents', 'this_period_cents',
    ],
  },
  /** Service agreements: the customer's contract price. */
  agreement: {
    contract_value: ['price_cents', 'priceCents'],
  },
  /** Work centers: shop burden rate. */
  work_center: {
    financials: ['rate_cents', 'rateCents'],
  },
  /** Selections, options and client approvals: allowance and chosen totals are contract; option cost/markup is cost. */
  selection: {
    contract_value: [
      'allowance_cents', 'chosen_total_cents', 'allowance_applied_cents', 'variance_cents', 'low_cents', 'high_cents',
      'unit_price_cents', 'amount_cents', 'allowanceCents', 'chosenCents', 'unitPriceCents', 'amountCents',
    ],
    financials: ['unit_cost_cents', 'markup_pct', 'freight_cents', 'unitCostCents', 'markupPct', 'freightCents'],
  },
  /** FF&E / flooring procurement items. */
  procurement: {
    contract_value: ['unit_sell_cents', 'sell_total_cents', 'unitSellCents', 'amount_cents'],
    financials: ['unit_cost_cents', 'markup_pct', 'freight_cents', 'cost_total_cents', 'margin_cents', 'margin_pct', 'unitCostCents', 'markupPct', 'freightCents'],
  },
  /** Development lots/units: contract price is contract; lender release price is development finance. List price is public. */
  dev_unit: {
    contract_value: ['contract_price_cents', 'contractPriceCents'],
    financials: ['lender_release_price_cents', 'lenderReleasePriceCents'],
    public: ['list_price_cents', 'listPriceCents'],
  },
  /** Development draws, draw schedules, loan / equity / interest reserve: development finance. */
  draw: {
    financials: [
      'loan_commitment_cents', 'equity_required_cents', 'interest_reserve_cents', 'interest_rate', 'projected_monthly_interest_cents',
      'original_cents', 'revised_cents', 'drawn_cents', 'open_request_cents', 'remaining_cents', 'retainage_held_cents',
      'retainage_released_cents', 'loan_funded_cents', 'equity_contributed_cents', 'original_budget_cents', 'revised_budget_cents',
      'drawn_gross_cents', 'cost_to_complete_cents', 'interest_reserve_used_cents', 'loan_remaining_cents', 'equity_remaining_cents',
      'in_balance_gap_cents', 'interest_reserve_remaining_cents', 'monthly_interest_cents', 'lines_requested_cents', 'requested_cents',
      'approved_cents', 'equity_applied_cents', 'loan_expected_cents', 'funded_cents', 'amountCents', 'outCents',
      'loanCommitmentCents', 'equityRequiredCents', 'interestReserveCents', 'projectedMonthlyInterestCents', 'requestedCents',
      'approvedCents', 'fundedCents', 'originalCents', 'revisedCents',
    ],
  },
  /**
   * KPI metrics (pm.v_kpis `metric` values; also used as keys). The signals widget formats the
   * value into a string, so the widget route drops money signals by metric (metricVisible).
   */
  kpi: {
    contract_value: ['avg_ticket_cents', 'revenue_per_tech_day_cents', 'warranty_claims_outstanding_cents'],
    financials: ['effective_labor_rate_cents', 'product_margin_pct', 'in_balance_gap_cents', 'interest_reserve_months', 'contingency_burn_ratio'],
  },
} as const satisfies Record<string, MoneyKeyList>;

export type MoneyObject = keyof typeof MONEY_KEYS;
export const MONEY_OBJECTS = Object.keys(MONEY_KEYS) as MoneyObject[];

/** Looks like money but is in no list → needs financials AND contract_value. */
export const MONEY_LIKE_KEY = /(_cents|Cents)$|margin|Margin|gross|Gross|markup|Markup|burden|Burden/;

export interface MaskRules {
  /** key → classes required (ALL of them) */
  money: ReadonlyMap<string, readonly MoneyClass[]>;
  public: ReadonlySet<string>;
}

const CLASSES: readonly MoneyClass[] = ['financials', 'contract_value', 'labor_rates'];

/**
 * Merge the lists of the given object types. With none given (the default for a route that
 * declares nothing) every type is merged — strictest union — but generic names that only mean
 * money inside a known object ('committed', 'sell', 'pct', 'interest_rate'…) are left out so a
 * count or a progress percent elsewhere is never blanked.
 */
export function rulesFor(objects?: ReadonlyArray<MoneyObject>): MaskRules {
  const declared = !!(objects && objects.length);
  const list = declared ? objects! : MONEY_OBJECTS;
  const money = new Map<string, Set<MoneyClass>>();
  const pub = new Set<string>();
  for (const o of list) {
    if (!Object.hasOwn(MONEY_KEYS, o)) continue;
    const k: MoneyKeyList = MONEY_KEYS[o];
    // own lists only: a polluted Object.prototype can never add a `public` list or drop a class
    const listOf = (name: MoneyClass | 'public'): readonly string[] => (Object.hasOwn(k, name) ? k[name] ?? [] : []);
    for (const c of CLASSES) {
      for (const key of listOf(c)) {
        if (!declared && !MONEY_LIKE_KEY.test(key)) continue;
        let set = money.get(key);
        if (!set) money.set(key, (set = new Set()));
        set.add(c);
      }
    }
    for (const key of listOf('public')) pub.add(key);
  }
  // A key that is money for any merged type is money (public loses).
  for (const key of money.keys()) pub.delete(key);
  return { money: new Map([...money].map(([k, v]) => [k, [...v]])), public: pub };
}

/** Classes a KPI metric needs, or null when it is not money (counts, %, days). */
export function metricClasses(metric: string): readonly MoneyClass[] | null {
  const k: MoneyKeyList = MONEY_KEYS.kpi;
  const out: MoneyClass[] = [];
  for (const c of CLASSES) if ((Object.hasOwn(k, c) ? k[c] ?? [] : []).includes(metric)) out.push(c);
  if (out.length) return out;
  return MONEY_LIKE_KEY.test(metric) ? ['financials', 'contract_value'] : null;
}
