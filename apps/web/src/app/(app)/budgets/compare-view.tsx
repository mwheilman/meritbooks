'use client';

/**
 * Compare tab (Wave 4B): two versions of the same company-year side by side — annual totals by
 * account × department, largest change first (GET /api/budgets/versions/compare).
 */
import { useEffect, useMemo, useState } from 'react';
import { Field, InlineNotice, Search, Select, money, useDebounce, useQuery } from '@meritbooks/merit-ui';
import type { CompareResponse } from '@/lib/budgets/types';
import { pctText } from './budget-format';
import { ScopeBar, useBudgetScope } from './budget-scope';
import { versionOptionLabel } from './version-bar';
import s from './budgets.module.css';

export function CompareView() {
  const sc = useBudgetScope();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [search, setSearch] = useState('');
  const term = useDebounce(search, 200).trim().toLowerCase();

  useEffect(() => {
    const ids = sc.versions.map((v) => v.id);
    if (!ids.includes(a)) setA(sc.versions.find((v) => v.status === 'SUPERSEDED' || (!v.isCurrent && v.kind === 'BUDGET'))?.id ?? sc.versions[1]?.id ?? '');
    if (!ids.includes(b)) setB(sc.versions.find((v) => v.isCurrent)?.id ?? sc.versions[0]?.id ?? '');
  }, [sc.versions, a, b]);

  const q = useQuery<CompareResponse>(a && b && a !== b ? '/api/budgets/versions/compare' : null, { a, b });
  const rows = useMemo(
    () => (q.data?.rows ?? []).filter((r) => !term || `${r.accountNumber} ${r.accountName} ${r.departmentName ?? 'company'}`.toLowerCase().includes(term)),
    [q.data, term],
  );
  const t = q.data?.totals;

  return (
    <div>
      <ScopeBar>
        {sc.versions.length > 1 && (
          <>
            <Field label="From (A)" className={s.wide}>
              <Select value={a} onChange={(e) => setA(e.target.value)}>
                {sc.versions.map((v) => <option key={v.id} value={v.id}>{versionOptionLabel(v)}</option>)}
              </Select>
            </Field>
            <Field label="To (B)" className={s.wide}>
              <Select value={b} onChange={(e) => setB(e.target.value)}>
                {sc.versions.map((v) => <option key={v.id} value={v.id}>{versionOptionLabel(v)}</option>)}
              </Select>
            </Field>
          </>
        )}
      </ScopeBar>
      {!sc.locationId ? (
        <div className={`${s.surface} ${s.state}`}><strong>Choose a company</strong></div>
      ) : sc.versions.length < 2 ? (
        <div className={`${s.surface} ${s.state}`}><strong>Nothing to compare yet</strong><p>Comparing needs two versions of the FY {sc.fiscalYear} plan — create one with “New version” on the Plan tab (copy the current one, then change it).</p></div>
      ) : a === b ? (
        <InlineNotice tone="info" className={s.notice}>Pick two different versions.</InlineNotice>
      ) : (
        <>
          {q.error && <InlineNotice tone="neg" title="Couldn’t compare" className={s.notice}>{q.error}</InlineNotice>}
          {t && (
            <div className={s.strip}>
              <div className={s.cell}><span className={s.cellL}>Revenue A → B</span><span className={s.cellV}>{money(t.bRevenueCents - t.aRevenueCents, { sign: 'delta' })}</span><span className={s.cellS}>{money(t.aRevenueCents)} → {money(t.bRevenueCents)}</span></div>
              <div className={s.cell}><span className={s.cellL}>Expense A → B</span><span className={s.cellV}>{money(t.bExpenseCents - t.aExpenseCents, { sign: 'delta' })}</span><span className={s.cellS}>{money(t.aExpenseCents)} → {money(t.bExpenseCents)}</span></div>
              <div className={s.cell}><span className={s.cellL}>Net A → B</span><span className={s.cellV}>{money((t.bRevenueCents - t.bExpenseCents) - (t.aRevenueCents - t.aExpenseCents), { sign: 'delta' })}</span></div>
              <div className={s.cell}><span className={s.cellL}>Lines changed</span><span className={s.cellV}>{q.data?.rows.filter((r) => r.changeCents !== 0).length ?? 0}</span></div>
            </div>
          )}
          <div className={s.surface}>
            <div className={s.toolbar}>
              <span className={s.toolbarTitle}>{q.data ? `${q.data.a.label} → ${q.data.b.label}` : 'Comparing…'}</span>
              <Search aria-label="Filter lines" placeholder="Filter account or department" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {q.isLoading && !q.data ? <div className={s.state} aria-busy="true">Comparing…</div> : rows.length === 0 ? (
              <div className={s.state}><p>{term ? 'No line matches the filter.' : 'Both versions are empty.'}</p></div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className={s.table}>
                  <thead><tr><th>Account</th><th>Department</th><th className={s.n}>A</th><th className={s.n}>B</th><th className={s.n}>Change</th><th className={s.n}>%</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.accountId}|${r.departmentId ?? ''}`}>
                        <td>{r.accountNumber} {r.accountName}</td>
                        <td>{r.departmentName ?? <span className={s.muted}>Company level</span>}</td>
                        <td className={s.n}>{money(r.aCents)}</td>
                        <td className={s.n}>{money(r.bCents)}</td>
                        <td className={`${s.n} ${r.changeCents ? s.total : s.muted}`}>{money(r.changeCents, { sign: 'delta' })}</td>
                        <td className={s.n}>{pctText(r.changePct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
