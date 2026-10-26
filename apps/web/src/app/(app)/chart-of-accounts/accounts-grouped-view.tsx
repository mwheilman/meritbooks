'use client';

import { useMemo, useState } from 'react';
import { Button, Icon, Keyhints, Tag, cx, useListKeynav } from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import { AccountFlags } from './account-flags';
import s from './coa.module.css';

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

interface GroupNode { name: string; totals: Totals; rows: GroupedAccount[] }
interface SubTypeNode { name: string; totals: Totals; groups: Map<string, GroupNode> }
interface TypeNode { name: string; normalBalance: string; totals: Totals; subTypes: Map<string, SubTypeNode> }

type RenderRow =
  | { kind: 'type'; key: string; node: TypeNode; open: boolean; count: number }
  | { kind: 'sub'; key: string; node: SubTypeNode; open: boolean }
  | { kind: 'group'; key: string; node: GroupNode; open: boolean }
  | { kind: 'acct'; key: string; account: GroupedAccount; acctIndex: number };

// Natural-balance sign: a CREDIT-normal account (liability/equity/revenue)
// carries the opposite raw (debit − credit) net, so flip it for display.
function toNatural(rawNetCents: number, normalBalance: string): number {
  return normalBalance === 'CREDIT' ? -rawNetCents : rawNetCents;
}

/** A net figure: tabular, right-aligned, never coloured by sign; zero is a quiet dash. */
function NetCell({ cents }: { cents: number }) {
  return cents === 0 ? <span className="ink-3">—</span> : <>{formatMoney(cents)}</>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className={cx(s.chev, open && s.chevOpen)} aria-hidden="true">
      <Icon name="right" />
    </span>
  );
}

export function AccountsGroupedView({
  accounts,
  balances,
  periodLabel,
  onSelectAccount,
  onOpenLedger,
  keynavEnabled = true,
}: {
  accounts: GroupedAccount[];
  balances: Record<string, AccountBalance>;
  periodLabel: string;
  onSelectAccount: (id: string) => void;
  onOpenLedger: (a: GroupedAccount) => void;
  /** J/K/Enter/L row keys; turn off while a drawer or dialog is open. */
  keynavEnabled?: boolean;
}) {
  // Build type → subType → group → accounts, preserving the account_number order
  // the API already sorted by. Subtotals (natural sign) roll up at each level.
  const tree = useMemo(() => {
    const types = new Map<string, TypeNode>();

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

  // Flatten what is visible into table rows; account rows get a cursor index.
  const { rows, visibleAccounts } = useMemo(() => {
    const out: RenderRow[] = [];
    const accts: GroupedAccount[] = [];
    for (const t of tree.values()) {
      const typeKey = t.name;
      const typeOpen = expanded.has(typeKey);
      const count = Array.from(t.subTypes.values()).reduce((sum, st) => sum + Array.from(st.groups.values()).reduce((g, gr) => g + gr.rows.length, 0), 0);
      out.push({ kind: 'type', key: typeKey, node: t, open: typeOpen, count });
      if (!typeOpen) continue;
      for (const st of t.subTypes.values()) {
        const stKey = `${t.name}::${st.name}`;
        const stOpen = expanded.has(stKey);
        out.push({ kind: 'sub', key: stKey, node: st, open: stOpen });
        if (!stOpen) continue;
        for (const g of st.groups.values()) {
          const gKey = `${stKey}::${g.name}`;
          const gOpen = expanded.has(gKey);
          out.push({ kind: 'group', key: gKey, node: g, open: gOpen });
          if (!gOpen) continue;
          for (const a of g.rows) {
            out.push({ kind: 'acct', key: a.id, account: a, acctIndex: accts.length });
            accts.push(a);
          }
        }
      }
    }
    return { rows: out, visibleAccounts: accts };
  }, [tree, expanded]);

  // J/K move between visible accounts · Enter opens the account · L opens its ledger.
  const { setActiveIndex, rowProps } = useListKeynav({
    count: visibleAccounts.length,
    onOpen: (i) => { const a = visibleAccounts[i]; if (a) onSelectAccount(a.id); },
    onAction: (i) => { const a = visibleAccounts[i]; if (a) onOpenLedger(a); },
    actionKey: 'l',
    enabled: keynavEnabled,
    owner: 'Chart of accounts (grouped)',
  });

  const typeTag = (normalBalance: string) => (
    <Tag title={normalBalance === 'DEBIT' ? 'Debit-normal' : 'Credit-normal'}>{normalBalance === 'DEBIT' ? 'DR' : 'CR'}</Tag>
  );

  return (
    <div>
      <div className={s.viewBar}>
        <span className="t-cap">Net movement shown in each account&apos;s normal balance.</span>
        <span className={s.viewActs}>
          <Button variant="quiet" onClick={() => setAll(true)}>Expand all</Button>
          <Button variant="quiet" onClick={() => setAll(false)}>Collapse all</Button>
        </span>
      </div>

      <div className={s.tableWrap}>
        <table className="tbl tbl-q tbl-q--compact" aria-label="Chart of accounts, grouped">
          <colgroup>
            <col />
            <col style={{ width: 176 }} />
            <col style={{ width: 168 }} />
            <col style={{ width: 168 }} />
            <col style={{ width: 120 }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Flags</th>
              <th scope="col" className="n" title={`Net movement in ${periodLabel}`}>{periodLabel}</th>
              <th scope="col" className="n" title="Net movement year-to-date">Year to date</th>
              <th scope="col"><span className="sr">Ledger</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              if (r.kind === 'type') {
                return (
                  <tr key={r.key} className={s.typeRow} onClick={() => toggle(r.key)}>
                    <td>
                      <button type="button" className={s.groupBtn} aria-expanded={r.open} onClick={(e) => { e.stopPropagation(); toggle(r.key); }}>
                        <Chevron open={r.open} />
                        <span>{r.node.name}</span>
                        {typeTag(r.node.normalBalance)}
                        <span className="t-cap tnum">{r.count}</span>
                      </button>
                    </td>
                    <td />
                    <td className="n"><NetCell cents={r.node.totals.period} /></td>
                    <td className="n"><NetCell cents={r.node.totals.ytd} /></td>
                    <td />
                  </tr>
                );
              }
              if (r.kind === 'sub') {
                return (
                  <tr key={r.key} className={s.subRow} onClick={() => toggle(r.key)}>
                    <td className={s.lvl1}>
                      <button type="button" className={s.groupBtn} aria-expanded={r.open} onClick={(e) => { e.stopPropagation(); toggle(r.key); }}>
                        <Chevron open={r.open} />
                        <span>{r.node.name}</span>
                      </button>
                    </td>
                    <td />
                    <td className="n"><NetCell cents={r.node.totals.period} /></td>
                    <td className="n"><NetCell cents={r.node.totals.ytd} /></td>
                    <td />
                  </tr>
                );
              }
              if (r.kind === 'group') {
                return (
                  <tr key={r.key} className={s.grpRow} onClick={() => toggle(r.key)}>
                    <td className={s.lvl2}>
                      <button type="button" className={s.groupBtn} aria-expanded={r.open} onClick={(e) => { e.stopPropagation(); toggle(r.key); }}>
                        <Chevron open={r.open} />
                        <span>{r.node.name}</span>
                        <span className="t-cap tnum">{r.node.rows.length}</span>
                      </button>
                    </td>
                    <td />
                    <td className="n"><NetCell cents={r.node.totals.period} /></td>
                    <td className="n"><NetCell cents={r.node.totals.ytd} /></td>
                    <td />
                  </tr>
                );
              }
              const a = r.account;
              const bal = balances[a.id];
              const periodNat = bal ? toNatural(bal.periodNetCents, a.normalBalance) : 0;
              const ytdNat = bal ? toNatural(bal.ytdNetCents, a.normalBalance) : 0;
              const { ref, 'data-active': active } = rowProps(r.acctIndex);
              return (
                <tr
                  key={r.key}
                  ref={ref}
                  className={cx('q-row', active && 'is-cursor', !a.isActive && s.inactive)}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => { setActiveIndex(r.acctIndex); onSelectAccount(a.id); }}
                  style={{ cursor: 'pointer' }}
                >
                  <td className={s.lvl3}>
                    <span className={s.acctCell}>
                      <span className={s.num}>{a.accountNumber}</span>
                      <span className="mb-trunc">{a.name}</span>
                      {a.approvalStatus === 'PENDING' && <Tag tone="warn">Pending</Tag>}
                      {!a.isActive && <Tag>Inactive</Tag>}
                    </span>
                  </td>
                  <td><AccountFlags account={a} /></td>
                  <td className="n"><NetCell cents={periodNat} /></td>
                  <td className="n"><NetCell cents={ytdNat} /></td>
                  <td className="n">
                    <Button
                      variant="quiet"
                      className={s.ledgerBtn}
                      icon="book"
                      onClick={(e) => { e.stopPropagation(); onOpenLedger(a); }}
                      aria-label={`View GL detail for ${a.accountNumber} ${a.name}`}
                    >
                      Ledger
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Keyhints
        className={s.hints}
        hints={[
          { chord: 'j k', label: 'Move' },
          { chord: 'enter', label: 'Open account' },
          { chord: 'l', label: 'Open ledger' },
          { chord: '/', label: 'Search' },
        ]}
      />
    </div>
  );
}
