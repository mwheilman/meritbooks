'use client';

import { useCallback } from 'react';
import { money as fmt } from '@meritbooks/merit-ui';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { seesMargin } from './visibility';

export type MoneyKind = 'cost' | 'contract' | 'rates' | 'margin';

/**
 * A drop-in for merit-ui money() inside a component whose figures are all one money kind:
 * formats when the caller holds that kind, otherwise an em dash. A safety net for panels that
 * are already behind a grant — screens with mixed money remove the column or figure instead.
 */
export function useMoneyText(kind: MoneyKind): (cents: number, opts?: Parameters<typeof fmt>[1]) => string {
  const mv = useMoneyVis();
  const ok = kind === 'margin' ? seesMargin(mv) : mv[kind];
  return useCallback((cents: number, opts?: Parameters<typeof fmt>[1]) => (ok ? fmt(cents, opts) : '—'), [ok]);
}

/**
 * Sell prices from the price book and parts counter: contract_value, plus the office (spec §2.2:
 * the dispatcher sees price-book sell only, an app rule). Labor and supervisors see none.
 */
export function useSellText(): (cents: number, opts?: Parameters<typeof fmt>[1]) => string {
  const mv = useMoneyVis();
  const { access } = useShell();
  const ok = mv.contract || access?.group === 'admin';
  return useCallback((cents: number, opts?: Parameters<typeof fmt>[1]) => (ok ? fmt(cents, opts) : '—'), [ok]);
}
