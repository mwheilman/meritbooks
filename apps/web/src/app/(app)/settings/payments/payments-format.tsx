import { Pip, Status, Tag } from '@meritbooks/merit-ui';
import type { AccountView, CompanyOptions, FeePayer, Readiness, TestRunState } from './payments-types';

export const usd = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const min = Math.round((Date.now() - then) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

/** Account readiness as pip + word (shape, word and colour — never colour alone). */
export function ReadinessStatus({ readiness, label }: { readiness: Readiness; label: string }) {
  if (readiness === 'ready') return <Status kind="ready">{label}</Status>;
  if (readiness === 'restricted') return <Status kind="blocked">{label}</Status>;
  if (readiness === 'setup_incomplete') return <Status kind="risk">{label}</Status>;
  return (
    <span className="status">
      <Pip kind="closed" />
      {label}
    </span>
  );
}

/** TEST / LIVE badge. LIVE only ever comes from the server's verdict. */
export function ModeBadge({ badge }: { badge: AccountView['modeBadge'] }) {
  if (badge === 'LIVE') return <Tag tone="pos">LIVE</Tag>;
  if (badge === 'TEST') return <Tag tone="warn">TEST</Tag>;
  return <span className="ink-3">—</span>;
}

export function feePayerText(p: FeePayer): string {
  return p === 'customer' ? 'customer pays the fee' : 'company absorbs the fee';
}

export function methodSummary(on: boolean, payer: FeePayer): string {
  return on ? `On · ${feePayerText(payer)}` : 'Off';
}

export function payoutBankText(a: AccountView): string {
  if (!a.payoutBank) return a.hasAccount ? 'Not added yet' : '—';
  return `${a.payoutBank.name ?? 'Bank'} ··${a.payoutBank.last4}`;
}

export const TEST_RUN_LABEL: Record<TestRunState, { label: string; tone: 'default' | 'ai' | 'pos' | 'neg' | 'warn' | 'solid' }> = {
  awaiting_payment: { label: 'Waiting for payment', tone: 'ai' },
  processing: { label: 'Bank transfer clearing', tone: 'warn' },
  paid: { label: 'Paid · posted to the books', tone: 'pos' },
  cancelled: { label: 'Cancelled', tone: 'default' },
  refunded: { label: 'Refunded · books reversed', tone: 'default' },
};

export function optionsEqual(a: CompanyOptions, b: Omit<CompanyOptions, 'usingDefaults'>): boolean {
  return a.cardEnabled === b.cardEnabled && a.achEnabled === b.achEnabled && a.checkEnabled === b.checkEnabled && a.cardFeePayer === b.cardFeePayer && a.achFeePayer === b.achFeePayer;
}
