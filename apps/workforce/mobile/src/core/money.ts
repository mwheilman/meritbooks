/**
 * Customer-facing money at the kitchen table (field-service sell flow) and the person's OWN pay —
 * the only amounts the phone ever shows. Integer cents throughout; the financing payment is the
 * standard amortised payment rounded half-up to the cent. Pure (unit-tested).
 */
import type { FinancingPlan, SellItem, SellOption } from './contract';
import type { Lang } from './i18n';

export function moneyText(cents: number, lang: Lang, opts: { whole?: boolean } = {}): string {
  const whole = opts.whole ?? cents % 100 === 0;
  return (cents / 100).toLocaleString(lang === 'es' ? 'es-US' : 'en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  });
}

/** Monthly payment for `principalCents` at `aprPct` (9.99 = 9.99 %) over `months`. 0 % → principal ÷ months, rounded up. */
export function monthlyPaymentCents(principalCents: number, aprPct: number, months: number): number {
  if (!Number.isFinite(principalCents) || principalCents <= 0 || !Number.isInteger(months) || months <= 0) return 0;
  const r = aprPct / 100 / 12;
  if (!Number.isFinite(r) || r <= 0) return Math.ceil(principalCents / months);
  const pay = (principalCents * r) / (1 - (1 + r) ** -months);
  return Math.round(pay);
}

export function planFits(plan: FinancingPlan, amountCents: number): boolean {
  return amountCents >= plan.minCents && (plan.maxCents == null || amountCents <= plan.maxCents);
}

/** The plan to quote on an option card: the option's own plan, else the company default, else the longest term that fits. */
export function planFor(plans: ReadonlyArray<FinancingPlan>, amountCents: number, preferredId: string | null): FinancingPlan | null {
  const fits = plans.filter((p) => planFits(p, amountCents));
  return fits.find((p) => p.id === preferredId) ?? fits.find((p) => p.isDefault) ?? [...fits].sort((a, b) => b.termMonths - a.termMonths)[0] ?? null;
}

export interface OptionPrice {
  regularCents: number;
  memberCents: number;
  rebateCents: number;
  /** What the customer pays: member price when they are (or are joining as) a member, less the rebate. */
  dueCents: number;
  /** What membership saves on this option. */
  memberSavingsCents: number;
}

const lineCents = (qty: number, unit: number) => Math.round(qty * unit);

/**
 * The option's price with the add-ons as ticked on the phone. The server totals reflect each
 * item's stored `selected`; a toggle that differs adds or removes that line.
 */
export function optionPrice(option: SellOption, items: ReadonlyArray<SellItem>, toggles: Readonly<Record<string, boolean>>, member: boolean): OptionPrice {
  let regular = option.regularCents;
  let mem = option.memberCents;
  for (const i of items) {
    if (i.optionId !== option.id || !i.optional) continue;
    const want = toggles[i.id];
    if (want === undefined || want === i.selected) continue;
    const sign = want ? 1 : -1;
    regular += sign * lineCents(i.qty, i.unitPriceCents);
    mem += sign * lineCents(i.qty, i.memberUnitPriceCents ?? i.unitPriceCents);
  }
  regular = Math.max(0, regular);
  mem = Math.max(0, Math.min(mem, regular));
  const base = member ? mem : regular;
  return { regularCents: regular, memberCents: mem, rebateCents: option.rebateCents, dueCents: Math.max(0, base - option.rebateCents), memberSavingsCents: regular - mem };
}

/** Typed dollars ("250", "250.50", "1,200") → cents, or null. */
export function parseDollars(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '');
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(t)) return null;
  const [w = '0', f = ''] = t.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}
