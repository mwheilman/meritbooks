/**
 * Dealer Pack (D2 slice A) — plain-English labels the shared labels.ts doesn't
 * carry yet: unit source, inventory bucket, cost offsets, sale status. Pure.
 */

import type { InventoryRole, RowStatus, UnitSource } from '../types';
import type { Labelled } from './labels';

export const UNIT_SOURCE: Record<UnitSource, string> = {
  DMS: 'Dealer system import',
  LENDER: 'Lender flooring',
  MANUAL: 'Entered in Books',
  TRADE_IN: 'Trade-in',
  OPENING: 'Opening balance',
};

export const INVENTORY_ROLE: Record<InventoryRole, string> = {
  WHOLE_GOODS_INVENTORY: 'New equipment inventory',
  USED_WHOLE_GOODS_INVENTORY: 'Used equipment inventory',
  RENTAL_INVENTORY: 'Rental fleet',
};

/** Offsets for a direct (journal) cost addition — validations `unitCostAdd.offset`. */
export type CostOffset = 'AP_CONTROL' | 'OPERATING_BANK' | 'INVENTORY_ASSET' | 'SETUP_LABOR_CAPITALIZED';
export const COST_OFFSET: Record<CostOffset, Labelled> = {
  AP_CONTROL: { label: 'Owed to a vendor (accounts payable)', tone: 'neutral', hint: 'The cost is on a vendor’s account but not on a bill in Books.' },
  OPERATING_BANK: { label: 'Paid from the operating bank', tone: 'neutral' },
  INVENTORY_ASSET: { label: 'Taken from parts inventory', tone: 'neutral', hint: 'Parts pulled from stock at cost.' },
  SETUP_LABOR_CAPITALIZED: { label: 'Shop labor capitalized to the unit', tone: 'neutral', hint: 'Labor at actual cost — no overhead or burden.' },
};

/** A deal's status (dealer_unit_sales.status). */
export const SALE_STATUS: Record<RowStatus, Labelled> = {
  PROPOSED: { label: 'Not posted yet', tone: 'warning' },
  POSTED: { label: 'Posted', tone: 'success' },
  VOID: { label: 'Voided', tone: 'neutral' },
};
