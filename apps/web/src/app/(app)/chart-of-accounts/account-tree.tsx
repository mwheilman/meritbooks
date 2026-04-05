'use client';

import { useState } from 'react';
import { ChevronRight, ChevronDown, Lock, Building2, CreditCard, Landmark } from 'lucide-react';
import { clsx } from 'clsx';
import { StatusBadge } from '@/components/ui';
import { ACCOUNT_TYPE_HIERARCHY, COA_STATS } from '@meritbooks/shared';

export function AccountTree() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['ASSET', 'LIABILITY']));
  const [search, setSearch] = useState('');

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
      <div className="flex items-center gap-6 mb-4 text-xs text-slate-500">
        <span>{COA_STATS.accountTypes} account types</span>
        <span className="text-slate-700">·</span>
        <span>{COA_STATS.subTypes} sub-types</span>
        <span className="text-slate-700">·</span>
        <span>{COA_STATS.groups} groups</span>
        <span className="text-slate-700">·</span>
        <span>{COA_STATS.accounts} accounts</span>
        <button onClick={expandAll} className="ml-auto text-brand-400 hover:text-brand-300 transition-colors">
          Expand all
        </button>
        <button onClick={() => setExpanded(new Set())} className="text-slate-400 hover:text-slate-300 transition-colors">
          Collapse all
        </button>
      </div>

      {/* Tree */}
      <div className="card divide-y divide-slate-800/30">
        {ACCOUNT_TYPE_HIERARCHY.map((type) => {
          const typeKey = type.code;
          const typeExpanded = expanded.has(typeKey);

          return (
            <div key={typeKey}>
              {/* Account Type level */}
              <button
                onClick={() => toggle(typeKey)}
                className="w-full flex items-center gap-3 px-5 py-3 hover:bg-white/[0.02] transition-colors"
              >
                {typeExpanded ? <ChevronDown size={16} className="text-slate-500" /> : <ChevronRight size={16} className="text-slate-500" />}
                <span className="text-sm font-semibold text-white">{type.name}</span>
                <span className="text-2xs text-slate-600 font-mono">
                  {type.normal_balance === 'DEBIT' ? 'DR' : 'CR'}
                </span>
                {type.closes_to_retained_earnings && (
                  <span className="text-2xs text-slate-600">· closes to RE</span>
                )}
                <span className="ml-auto text-2xs text-slate-500">
                  {type.sub_types.reduce((s, st) => s + st.groups.reduce((g, gr) => g + gr.accounts.length, 0), 0)} accounts
                </span>
              </button>

              {/* Sub-types */}
              {typeExpanded && type.sub_types.map((subType) => {
                const stKey = `${typeKey}-${subType.code}`;
                const stExpanded = expanded.has(stKey);

                return (
                  <div key={stKey}>
                    <button
                      onClick={() => toggle(stKey)}
                      className="w-full flex items-center gap-3 pl-10 pr-5 py-2.5 hover:bg-white/[0.02] transition-colors"
                    >
                      {stExpanded ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
                      <span className="text-sm font-medium text-slate-300">{subType.name}</span>
                      <span className="ml-auto text-2xs text-slate-600">
                        {subType.groups.reduce((g, gr) => g + gr.accounts.length, 0)}
                      </span>
                    </button>

                    {/* Groups */}
                    {stExpanded && subType.groups.map((group) => {
                      const gKey = `${stKey}-${group.name}`;
                      const gExpanded = expanded.has(gKey);

                      return (
                        <div key={gKey}>
                          <button
                            onClick={() => toggle(gKey)}
                            className="w-full flex items-center gap-3 pl-16 pr-5 py-2 hover:bg-white/[0.02] transition-colors"
                          >
                            {gExpanded ? <ChevronDown size={12} className="text-slate-600" /> : <ChevronRight size={12} className="text-slate-600" />}
                            <span className="text-sm text-slate-400">{group.name}</span>
                            <span className="ml-auto text-2xs text-slate-600">{group.accounts.length}</span>
                          </button>

                          {/* Accounts */}
                          {gExpanded && group.accounts.map((account) => (
                            <div
                              key={account.number}
                              className="flex items-center gap-3 pl-24 pr-5 py-2 hover:bg-white/[0.02] transition-colors cursor-pointer group"
                            >
                              <span className="text-xs font-mono text-brand-400 w-12">{account.number}</span>
                              <span className="text-sm text-slate-300">{account.name}</span>

                              {/* Flags */}
                              <div className="ml-auto flex items-center gap-2">
                                {account.is_control_account && (
                                  <span title="Control account — no direct posting">
                                    <Lock size={12} className="text-amber-500/60" />
                                  </span>
                                )}
                                {account.is_company_specific && (
                                  <span title="Company-specific account">
                                    <Building2 size={12} className="text-blue-400/60" />
                                  </span>
                                )}
                                {account.is_bank_account && (
                                  <span title="Bank account">
                                    <Landmark size={12} className="text-slate-500" />
                                  </span>
                                )}
                                {account.is_credit_card && (
                                  <span title="Credit card account">
                                    <CreditCard size={12} className="text-slate-500" />
                                  </span>
                                )}
                              </div>
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
