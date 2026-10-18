'use client';

import { useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Lock, Building2, CreditCard, Landmark,
  Clock, ScrollText, EyeOff,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';

export interface GroupedAccount {
  id: string;
  accountNumber: string;
  name: string;
  accountType: string;
  groupName: string;
  subTypeName: string;
  typeName: string;
  normalBalance: string; // 'DEBIT' | 'CREDIT'
  isActive: boolean;
  isControlAccount: boolean;
  isCompanySpecific: boolean;
  isBankAccount: boolean;
  isCreditCard: boolean;
  approvalStatus: string;
}

export interface AccountBalance {
  periodNetCents: number;
  ytdNetCents: number;
  periodActivityCount: number;
  ytdActivityCount: number;
}

interface Totals {
  period: number;
  ytd: number;
}

// Natural-balance sign: a CREDIT-normal account (liability/equity/revenue)
// carries the opposite raw (debit − credit) net, so flip it for display.
function toNatural(rawNetCents: number, normalBalance: string): number {
  return normalBalance === 'CREDIT' ? -rawNetCents : rawNetCents;
}

function NetCell({ cents, strong }: { cents: number; strong?: boolean }) {
  const cls = cents < 0 ? 'text-red-400' : cents === 0 ? 'text-slate-600' : strong ? 'text-white' : 'text-slate-200';
  return (
    <span className={clsx('font-mono tabular-nums', strong && 'font-semibold', cls)}>
      {cents === 0 ? '—' : formatMoney(cents)}
    </span>
  );
}

export function AccountsGroupedView({
  accounts,
  balances,
  periodLabel,
  onSelectAccount,
  onOpenLedger,
}: {
  accounts: GroupedAccount[];
  balances: Record<string, AccountBalance>;
  periodLabel: string;
  onSelectAccount: (id: string) => void;
  onOpenLedger: (a: GroupedAccount) => void;
}) {
  // Build type → subType → group → accounts, preserving the account_number order
  // the API already sorted by. Subtotals (natural sign) roll up at each level.
  const tree = useMemo(() => {
    const types = new Map<
      string,
      {
        name: string;
        normalBalance: string;
        totals: Totals;
        subTypes: Map<string, { name: string; totals: Totals; groups: Map<string, { name: string; totals: Totals; rows: GroupedAccount[] }> }>;
      }
    >();

    for (const a of accounts) {
      const bal = balances[a.id];
      const periodNat = bal ? toNatural(bal.periodNetCents, a.normalBalance) : 0;
      const ytdNat = bal ? toNatural(bal.ytdNetCents, a.normalBalance) : 0;

      if (!types.has(a.typeName)) {
        types.set(a.typeName, { name: a.typeName, normalBalance: a.normalBalance, totals: { period: 0, ytd: 0 }, subTypes: new Map() });
      }
      const t = types.get(a.typeName)!;
      t.totals.period += periodNat; t.totals.ytd += ytdNat;

      if (!t.subTypes.has(a.subTypeName)) {
        t.subTypes.set(a.subTypeName, { name: a.subTypeName, totals: { period: 0, ytd: 0 }, groups: new Map() });
      }
      const st = t.subTypes.get(a.subTypeName)!;
      st.totals.period += periodNat; st.totals.ytd += ytdNat;

      if (!st.groups.has(a.groupName)) {
        st.groups.set(a.groupName, { name: a.groupName, totals: { period: 0, ytd: 0 }, rows: [] });
      }
      const g = st.groups.get(a.groupName)!;
      g.totals.period += periodNat; g.totals.ytd += ytdNat;
      g.rows.push(a);
    }
    return types;
  }, [accounts, balances]);

  // Default: expand every account-type header so balances are visible on load.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(Array.from(tree.keys())));

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function setAll(open: boolean) {
    if (!open) { setExpanded(new Set()); return; }
    const keys = new Set<string>();
    for (const [tn, t] of tree) {
      keys.add(tn);
      for (const [stn, st] of t.subTypes) {
        keys.add(`${tn}::${stn}`);
        for (const gn of st.groups.keys()) keys.add(`${tn}::${stn}::${gn}`);
      }
    }
    setExpanded(keys);
  }

  return (
    <div>
      <div className="flex items-center justify-end gap-4 mb-2 text-xs">
        <button onClick={() => setAll(true)} className="text-emerald-400 hover:text-emerald-300 transition-colors">Expand all</button>
        <button onClick={() => setAll(false)} className="text-slate-400 hover:text-slate-300 transition-colors">Collapse all</button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="border-b border-slate-800 text-2xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-2.5 text-left">Account</th>
              <th className="px-4 py-2.5 text-center w-16">Flags</th>
              <th className="px-4 py-2.5 text-right w-36" title={`Net movement in ${periodLabel}`}>Period · {periodLabel}</th>
              <th className="px-4 py-2.5 text-right w-36" title="Net movement year-to-date">YTD</th>
              <th className="px-4 py-2.5 text-right w-20"></th>
            </tr>
          </thead>
          <tbody>
            {Array.from(tree.values()).map((t) => {
              const typeKey = t.name;
              const typeOpen = expanded.has(typeKey);
              return (
                <TypeBlock
                  key={typeKey}
                  t={t}
                  typeOpen={typeOpen}
                  expanded={expanded}
                  toggle={toggle}
                  balances={balances}
                  onSelectAccount={onSelectAccount}
                  onOpenLedger={onOpenLedger}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TypeBlock({
  t, typeOpen, expanded, toggle, balances, onSelectAccount, onOpenLedger,
}: {
  t: { name: string; normalBalance: string; totals: Totals; subTypes: Map<string, { name: string; totals: Totals; groups: Map<string, { name: string; totals: Totals; rows: GroupedAccount[] }> }> };
  typeOpen: boolean;
  expanded: Set<string>;
  toggle: (k: string) => void;
  balances: Record<string, AccountBalance>;
  onSelectAccount: (id: string) => void;
  onOpenLedger: (a: GroupedAccount) => void;
}) {
  const acctCount = Array.from(t.subTypes.values()).reduce((s, st) => s + Array.from(st.groups.values()).reduce((g, gr) => g + gr.rows.length, 0), 0);
  return (
    <>
      <tr className="border-b border-slate-800 bg-slate-800/20 cursor-pointer hover:bg-slate-800/30" onClick={() => toggle(t.name)}>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {typeOpen ? <ChevronDown size={15} className="text-slate-500" /> : <ChevronRight size={15} className="text-slate-500" />}
            <span className="text-sm font-semibold text-white">{t.name}</span>
            <span className="text-2xs font-mono text-slate-600">{t.normalBalance === 'DEBIT' ? 'DR' : 'CR'}</span>
            <span className="text-2xs text-slate-600">· {acctCount}</span>
          </div>
        </td>
        <td />
        <td className="px-4 py-2.5 text-right"><NetCell cents={t.totals.period} strong /></td>
        <td className="px-4 py-2.5 text-right"><NetCell cents={t.totals.ytd} strong /></td>
        <td />
      </tr>

      {typeOpen && Array.from(t.subTypes.values()).map((st) => {
        const stKey = `${t.name}::${st.name}`;
        const stOpen = expanded.has(stKey);
        return (
          <SubTypeBlock
            key={stKey}
            typeName={t.name}
            st={st}
            stKey={stKey}
            stOpen={stOpen}
            expanded={expanded}
            toggle={toggle}
            balances={balances}
            onSelectAccount={onSelectAccount}
            onOpenLedger={onOpenLedger}
          />
        );
      })}
    </>
  );
}

function SubTypeBlock({
  typeName, st, stKey, stOpen, expanded, toggle, balances, onSelectAccount, onOpenLedger,
}: {
  typeName: string;
  st: { name: string; totals: Totals; groups: Map<string, { name: string; totals: Totals; rows: GroupedAccount[] }> };
  stKey: string;
  stOpen: boolean;
  expanded: Set<string>;
  toggle: (k: string) => void;
  balances: Record<string, AccountBalance>;
  onSelectAccount: (id: string) => void;
  onOpenLedger: (a: GroupedAccount) => void;
}) {
  return (
    <>
      <tr className="border-b border-slate-800/50 cursor-pointer hover:bg-white/[0.02]" onClick={() => toggle(stKey)}>
        <td className="px-4 py-2 pl-9">
          <div className="flex items-center gap-2">
            {stOpen ? <ChevronDown size={13} className="text-slate-500" /> : <ChevronRight size={13} className="text-slate-500" />}
            <span className="text-sm font-medium text-slate-300">{st.name}</span>
          </div>
        </td>
        <td />
        <td className="px-4 py-2 text-right"><NetCell cents={st.totals.period} /></td>
        <td className="px-4 py-2 text-right"><NetCell cents={st.totals.ytd} /></td>
        <td />
      </tr>

      {stOpen && Array.from(st.groups.values()).map((g) => {
        const gKey = `${stKey}::${g.name}`;
        const gOpen = expanded.has(gKey);
        return (
          <GroupBlock
            key={gKey}
            g={g}
            gKey={gKey}
            gOpen={gOpen}
            toggle={toggle}
            balances={balances}
            onSelectAccount={onSelectAccount}
            onOpenLedger={onOpenLedger}
          />
        );
      })}
    </>
  );
}

function GroupBlock({
  g, gKey, gOpen, toggle, balances, onSelectAccount, onOpenLedger,
}: {
  g: { name: string; totals: Totals; rows: GroupedAccount[] };
  gKey: string;
  gOpen: boolean;
  toggle: (k: string) => void;
  balances: Record<string, AccountBalance>;
  onSelectAccount: (id: string) => void;
  onOpenLedger: (a: GroupedAccount) => void;
}) {
  return (
    <>
      <tr className="cursor-pointer hover:bg-white/[0.02]" onClick={() => toggle(gKey)}>
        <td className="px-4 py-1.5 pl-14">
          <div className="flex items-center gap-2">
            {gOpen ? <ChevronDown size={12} className="text-slate-600" /> : <ChevronRight size={12} className="text-slate-600" />}
            <span className="text-xs text-slate-400">{g.name}</span>
            <span className="text-2xs text-slate-600">· {g.rows.length}</span>
          </div>
        </td>
        <td />
        <td className="px-4 py-1.5 text-right text-xs"><NetCell cents={g.totals.period} /></td>
        <td className="px-4 py-1.5 text-right text-xs"><NetCell cents={g.totals.ytd} /></td>
        <td />
      </tr>

      {gOpen && g.rows.map((a) => {
        const bal = balances[a.id];
        const periodNat = bal ? toNatural(bal.periodNetCents, a.normalBalance) : 0;
        const ytdNat = bal ? toNatural(bal.ytdNetCents, a.normalBalance) : 0;
        return (
          <tr
            key={a.id}
            className={clsx('group border-t border-slate-800/20 hover:bg-white/[0.02] cursor-pointer', !a.isActive && 'opacity-55')}
            onClick={() => onSelectAccount(a.id)}
          >
            <td className="px-4 py-2 pl-24">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-xs font-mono text-emerald-400 shrink-0">{a.accountNumber}</span>
                <span className="text-sm text-slate-300 truncate">{a.name}</span>
                {a.approvalStatus === 'PENDING' && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 shrink-0"><Clock size={9} />Pending</span>
                )}
                {!a.isActive && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-700/40 text-slate-400 shrink-0"><EyeOff size={9} />Inactive</span>
                )}
              </div>
            </td>
            <td className="px-4 py-2">
              <div className="flex items-center justify-center gap-1.5">
                {a.isControlAccount && <span title="Control account — no direct posting"><Lock size={11} className="text-amber-500/70" /></span>}
                {a.isCompanySpecific && <span title="Company-specific account"><Building2 size={11} className="text-blue-400/70" /></span>}
                {a.isBankAccount && <span title="Bank account"><Landmark size={11} className="text-slate-500" /></span>}
                {a.isCreditCard && <span title="Credit card account"><CreditCard size={11} className="text-slate-500" /></span>}
              </div>
            </td>
            <td className="px-4 py-2 text-right"><NetCell cents={periodNat} /></td>
            <td className="px-4 py-2 text-right"><NetCell cents={ytdNat} /></td>
            <td className="px-4 py-2 text-right">
              <button
                onClick={(e) => { e.stopPropagation(); onOpenLedger(a); }}
                aria-label={`View GL detail for ${a.accountNumber} ${a.name}`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-400 opacity-0 group-hover:opacity-100 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all"
              >
                <ScrollText size={12} /> Ledger
              </button>
            </td>
          </tr>
        );
      })}
    </>
  );
}
