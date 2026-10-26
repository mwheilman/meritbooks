import { Icon, Tag } from '@meritbooks/merit-ui';
import s from './coa.module.css';

interface FlaggedAccount {
  isControlAccount: boolean;
  isCompanySpecific: boolean;
  isBankAccount: boolean;
  isCreditCard: boolean;
}

/** Account flags as words (the kit has no stock icons; status is never colour alone). */
export function AccountFlags({ account }: { account: FlaggedAccount }) {
  const any = account.isControlAccount || account.isCompanySpecific || account.isBankAccount || account.isCreditCard;
  if (!any) return <span className="ink-3">—</span>;
  return (
    <span className={s.flags}>
      {account.isControlAccount && (
        <Tag tone="warn" title="Control account — no direct posting"><Icon name="lock" />Control</Tag>
      )}
      {account.isCompanySpecific && <Tag title="Company-specific account">Company</Tag>}
      {account.isBankAccount && <Tag title="Bank account">Bank</Tag>}
      {account.isCreditCard && <Tag title="Credit card account">Card</Tag>}
    </span>
  );
}
