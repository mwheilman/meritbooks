'use client';

import { useState } from 'react';
import { Button, Icon, Tag, cx } from '@meritbooks/merit-ui';
import { ACCOUNT_TYPE_HIERARCHY, COA_STATS } from '@meritbooks/shared';
import { AccountFlags } from './account-flags';
import s from './coa.module.css';

function Chevron({ open }: { open: boolean }) {
  return (
    <span className={cx(s.chev, open && s.chevOpen)} aria-hidden="true">
      <Icon name="right" />
    </span>
  );
}

export function AccountTree() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['ASSET', 'LIABILITY']));

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function expandAll() {
    const keys = new Set<string>();
    ACCOUNT_TYPE_HIERARCHY.forEach((t) => {
      keys.add(t.code);
      t.sub_types.forEach((st) => {
        keys.add(`${t.code}-${st.code}`);
        st.groups.forEach((g) => keys.add(`${t.code}-${st.code}-${g.name}`));
      });
    });
    setExpanded(keys);
  }

  return (
    <div>
      {/* Stats bar */}
      <div className={cx('t-cap tnum', s.treeStats)}>
        <span>{COA_STATS.accountTypes} account types</span>
        <span>{COA_STATS.subTypes} sub-types</span>
        <span>{COA_STATS.groups} groups</span>
        <span>{COA_STATS.accounts} accounts</span>
        <span className={s.grow} />
        <Button variant="quiet" onClick={expandAll}>Expand all</Button>
        <Button variant="quiet" onClick={() => setExpanded(new Set())}>Collapse all</Button>
      </div>

      {/* Tree */}
      <div className={s.tree} aria-label="Chart of accounts">
        {ACCOUNT_TYPE_HIERARCHY.map((type) => {
          const typeKey = type.code;
          const typeExpanded = expanded.has(typeKey);

          return (
            <div key={typeKey}>
              {/* Account Type level */}
              <button type="button" onClick={() => toggle(typeKey)} className={cx(s.treeRow, s.treeType)} aria-expanded={typeExpanded}>
                <Chevron open={typeExpanded} />
                <span>{type.name}</span>
                <Tag>{type.normal_balance === 'DEBIT' ? 'DR' : 'CR'}</Tag>
                {type.closes_to_retained_earnings && <span className="t-cap">closes to retained earnings</span>}
                <span className={cx('t-cap tnum', s.treeEnd)}>
                  {type.sub_types.reduce((sum, st) => sum + st.groups.reduce((g, gr) => g + gr.accounts.length, 0), 0)} accounts
                </span>
              </button>

              {/* Sub-types */}
              {typeExpanded && type.sub_types.map((subType) => {
                const stKey = `${typeKey}-${subType.code}`;
                const stExpanded = expanded.has(stKey);

                return (
                  <div key={stKey}>
                    <button type="button" onClick={() => toggle(stKey)} className={cx(s.treeRow, s.treeSub)} aria-expanded={stExpanded}>
                      <Chevron open={stExpanded} />
                      <span>{subType.name}</span>
                      <span className={cx('t-cap tnum', s.treeEnd)}>
                        {subType.groups.reduce((g, gr) => g + gr.accounts.length, 0)}
                      </span>
                    </button>

                    {/* Groups */}
                    {stExpanded && subType.groups.map((group) => {
                      const gKey = `${stKey}-${group.name}`;
                      const gExpanded = expanded.has(gKey);

                      return (
                        <div key={gKey}>
                          <button type="button" onClick={() => toggle(gKey)} className={cx(s.treeRow, s.treeGroup)} aria-expanded={gExpanded}>
                            <Chevron open={gExpanded} />
                            <span>{group.name}</span>
                            <span className={cx('t-cap tnum', s.treeEnd)}>{group.accounts.length}</span>
                          </button>

                          {/* Accounts */}
                          {gExpanded && group.accounts.map((account) => (
                            <div key={account.number} className={cx(s.treeRow, s.treeAcct)}>
                              <span className={s.num}>{account.number}</span>
                              <span>{account.name}</span>

                              {/* Flags */}
                              <span className={s.treeEnd}>
                                <AccountFlags
                                  account={{
                                    isControlAccount: !!account.is_control_account,
                                    isCompanySpecific: !!account.is_company_specific,
                                    isBankAccount: !!account.is_bank_account,
                                    isCreditCard: !!account.is_credit_card,
                                  }}
                                />
                              </span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
