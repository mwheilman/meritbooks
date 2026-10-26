'use client';

/**
 * Department view (Wave 4B, AC-B15 / AC-B16): one department's P&L — actual vs budget vs last year
 * for a month / QTD / YTD / TTM window — material variances with the owner's explanation and
 * finance's review, the GL drill, and the three bridges.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Drawer,
  Field,
  InlineNotice,
  PanelSection,
  Seg,
  Select,
  Tag,
  Textarea,
  api,
  money,
  shortDate,
  toast,
  useQuery,
} from '@meritbooks/merit-ui';
import { ChartCard, VarianceBars, summarizeVariance, varianceTable, type VarianceRow } from '@/components/charts';
import type { BudgetAccessSummary, BvaLine, BvaWindow, DepartmentViewResponse, GlDrillLine } from '@/lib/budgets/types';
import { BridgeCard } from './bridge-card';
import { MONTH_LABELS, SECTION_LABEL, SECTION_OF_TYPE, defaultMonth, errText, maxThroughMonth, pctText } from './budget-format';
import s from './budgets.module.css';

const WINDOWS: Array<{ value: BvaWindow; label: string }> = [
  { value: 'MONTH', label: 'Month' },
  { value: 'QTD', label: 'QTD' },
  { value: 'YTD', label: 'YTD' },
  { value: 'TTM', label: 'TTM' },
];

export interface DepartmentViewProps {
  locationId: string;
  fiscalYear: number;
  departmentId: string | null;
  departmentName: string;
  versionId: string | null;
  access: BudgetAccessSummary | null;
}

export function DepartmentView({ locationId, fiscalYear, departmentId, departmentName, versionId, access }: DepartmentViewProps) {
  const [window, setWindow] = useState<BvaWindow>('YTD');
  // Never open on a future month: a year that hasn't started shows the full-year budget (no actuals).
  const maxMonth = maxThroughMonth(fiscalYear);
  const notStarted = maxMonth === 0;
  const [month, setMonthState] = useState<number>(() => defaultMonth(fiscalYear) ?? 12);
  const [monthTouched, setMonthTouched] = useState(false);
  const setMonth = (m: number) => {
    setMonthTouched(true);
    setMonthState(m);
  };
  const [onlyMaterial, setOnlyMaterial] = useState(false);
  const [drill, setDrill] = useState<BvaLine | null>(null);
  const q = useQuery<DepartmentViewResponse>('/api/budgets/department-view', {
    location_id: locationId, fiscal_year: String(fiscalYear), month: String(notStarted ? 12 : month), window: notStarted ? 'YTD' : window, department_id: departmentId ?? 'company', version_id: versionId ?? undefined,
  });
  const d = q.data;
  // Once we know where this department's actuals end, open on that month (until the user picks one).
  const latestActual = d?.latestActualMonth ?? null;
  useEffect(() => {
    if (monthTouched || notStarted || latestActual === null) return;
    const m = defaultMonth(fiscalYear, new Date(), latestActual);
    if (m !== null && m !== month) setMonthState(m);
  }, [latestActual, monthTouched, notStarted, fiscalYear, month]);
  const periodKey = `${fiscalYear}-${String(month).padStart(2, '0')}`;

  const varRows: VarianceRow[] = useMemo(
    () => (d?.lines ?? []).filter((l) => l.budgetCents !== 0 || l.actualCents !== 0).sort((x, y) => Math.abs(y.varianceCents) - Math.abs(x.varianceCents)).slice(0, 10)
      .map((l) => ({ key: l.accountId, label: `${l.accountNumber} ${l.accountName}`, actual: l.actualCents, plan: l.budgetCents, direction: l.nature === 'income' ? 'higher_is_better' : 'lower_is_better' })),
    [d],
  );

  const header = (
    <div className={s.bar}>
      <div className={s.grow}>
        <div className="t-cap">Department budget vs actual</div>
        <h2 className="t-head" style={{ margin: 0 }}>{departmentName}</h2>
      </div>
      <Field label="Window">
        <Seg aria-label="Window" items={WINDOWS} value={window} onChange={setWindow} />
      </Field>
      <Field label="Through">
        {notStarted ? (
          <Select value="full" disabled aria-describedby="dept-not-started">
            <option value="full">Full year — not started</option>
          </Select>
        ) : (
          <Select value={String(month)} onChange={(e) => setMonth(parseInt(e.target.value, 10))}>
            {MONTH_LABELS.map((m, i) => <option key={m} value={String(i + 1)} disabled={i + 1 > maxMonth}>{m} {fiscalYear}</option>)}
          </Select>
        )}
      </Field>
    </div>
  );

  if (q.isLoading && !d) return <>{header}<div className={`${s.surface} ${s.state}`} aria-busy="true">Loading the department…</div></>;
  if (q.error) return <>{header}<InlineNotice tone="neg" title="Couldn’t load this department" className={s.notice}>{q.error}</InlineNotice></>;
  if (!d) return header;

  const t = d.totals;
  const variance = t.actualCents - t.budgetCents;
  const fav = t.measure === 'contribution' ? variance >= 0 : variance <= 0;
  // Nothing budgeted for the window: no favourable / unfavourable call.
  const noBudget = t.budgetCents === 0;
  const material = d.lines.filter((l) => l.material);
  const lines = onlyMaterial ? material : d.lines;
  const finance = !!access && access.scope === 'ALL';
  const measureWord = t.measure === 'contribution' ? 'Contribution' : 'Spend';

  return (
    <div>
      {header}
      <p className={s.muted} style={{ marginTop: -8 }}>
        {notStarted ? `Full year FY ${fiscalYear} (not started)` : d.period.label} · budget: {d.version ? d.version.label : 'none for this year'}{d.closedThrough ? ` · actuals locked (soft-closed or closed) through ${d.closedThrough}` : ' · no soft-closed or closed months yet (actuals are preliminary)'}
      </p>
      {notStarted && <InlineNotice tone="info" className={s.notice}><span id="dept-not-started">FY {fiscalYear} hasn’t started — there are no actuals yet, so this shows the full-year budget against last year.</span></InlineNotice>}
      {!d.version && <InlineNotice tone="info" className={s.notice}>There is no FY {fiscalYear} budget yet — actuals and last year still show.</InlineNotice>}

      <div className={s.strip}>
        <div className={s.cell}><span className={s.cellL}>{measureWord} actual</span><span className={s.cellV}>{money(t.actualCents)}</span><span className={s.cellS}>{d.period.from} – {d.period.to}</span></div>
        <div className={s.cell}><span className={s.cellL}>{measureWord} budget</span><span className={s.cellV}>{money(t.budgetCents)}</span></div>
        <div className={s.cell}>
          <span className={s.cellL}>Variance</span>
          <span className={`${s.cellV} ${variance === 0 || noBudget ? '' : fav ? s.pos : s.neg}`}>{noBudget ? '—' : money(variance, { sign: 'delta' })}</span>
          <span className={s.cellS}>{noBudget ? 'Nothing budgeted for this period' : variance === 0 ? 'On budget' : fav ? 'Favourable' : 'Unfavourable'}{t.budgetCents ? ` · ${pctText(variance / Math.abs(t.budgetCents))}` : ''}</span>
        </div>
        <div className={s.cell}><span className={s.cellL}>Last year</span><span className={s.cellV}>{money(t.pyCents)}</span><span className={s.cellS}>{t.pyCents ? `${pctText((t.actualCents - t.pyCents) / Math.abs(t.pyCents))} vs last year` : 'No prior-year activity'}</span></div>
        <div className={s.cell}><span className={s.cellL}>Material variances</span><span className={`${s.cellV} ${d.materialCount ? s.neg : ''}`}>{d.materialCount}</span><span className={s.cellS}>Over {d.version ? money(d.version.materialityCents) : '$5,000'} or {d.version ? (d.version.materialityBps / 100).toFixed(0) : '10'}%</span></div>
      </div>

      <div className={s.bridges}>
        <BridgeCard index={1} eyebrow="Bridge" period={`FY ${fiscalYear}`} bridge={d.bridges.pyToBudget} />
        <BridgeCard index={2} eyebrow="Bridge" period={d.period.label} bridge={d.bridges.budgetToActual} />
        <div>
          <BridgeCard index={3} eyebrow="Bridge" period={`FY ${fiscalYear}`} bridge={d.bridges.budgetToForecast} />
          <p className={s.tie}>End = {d.forecastLabel}.</p>
        </div>
        {varRows.length > 0 && (
          <ChartCard
            index={4}
            eyebrow="Variance"
            title="Largest variances to budget"
            period={d.period.label}
            summary={summarizeVariance('department lines', varRows, 'money')}
            table={varianceTable(varRows, { caption: 'Largest variances to budget', unit: 'money', planLabel: 'Budget' })}
            onRowDrill={(k) => setDrill(d.lines.find((l) => l.accountId === k) ?? null)}
            drillHint="Click a line to see its GL entries"
            height={300}
          >
            <VarianceBars rows={varRows} unit="money" planLabel="Budget" onDrill={(k) => setDrill(d.lines.find((l) => l.accountId === k) ?? null)} />
          </ChartCard>
        )}
      </div>

      <div className={s.surface}>
        <div className={s.toolbar}>
          <span className={s.toolbarTitle}>Department P&amp;L</span>
          <Seg aria-label="Lines" items={[{ value: 'all', label: 'All lines' }, { value: 'material', label: 'Material', count: material.length }]} value={onlyMaterial ? 'material' : 'all'} onChange={(v) => setOnlyMaterial(v === 'material')} />
        </div>
        {d.lines.length === 0 ? (
          <div className={s.state}><strong>No activity</strong><p>Nothing was budgeted or posted to this department in the window or a year earlier.</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className={s.table}>
              <thead>
                <tr><th>Account</th><th className={s.n}>Actual</th><th className={s.n}>Budget</th><th className={s.n}>Var $</th><th className={s.n}>Var %</th><th>F/U</th><th className={s.n}>Last year</th><th className={s.n}>vs LY</th><th>Explanation</th></tr>
              </thead>
              <tbody>
                {(['revenue', 'cogs', 'opex', 'other'] as const).map((sec) => {
                  const ls = lines.filter((l) => (SECTION_OF_TYPE[l.accountType] ?? 'other') === sec);
                  if (ls.length === 0) return null;
                  const st = d.sections.find((x) => x.key === sec);
                  return [
                    <tr key={`${sec}-h`} className={s.section}><td colSpan={9}>{SECTION_LABEL[sec]}</td></tr>,
                    ...ls.map((l) => (
                      <tr key={l.accountId} className={l.material ? s.isMaterial : undefined}>
                        <td><button type="button" className={s.linkBtn} onClick={() => setDrill(l)} title="See the GL lines">{l.accountNumber} {l.accountName}</button></td>
                        <td className={s.n}>{money(l.actualCents)}</td>
                        <td className={s.n}>{money(l.budgetCents)}</td>
                        <td className={`${s.n} ${l.verdict === 'favourable' ? s.pos : l.verdict === 'unfavourable' ? s.neg : ''}`}>{money(l.varianceCents, { sign: 'delta' })}</td>
                        <td className={s.n}>{pctText(l.variancePct)}</td>
                        <td>{l.verdict === 'on_budget' || l.verdict === 'no_budget' ? <span title={l.verdict === 'no_budget' ? 'Nothing budgeted for this period' : 'On budget'}>—</span> : <Tag tone={l.verdict === 'favourable' ? 'pos' : 'neg'}>{l.verdict === 'favourable' ? 'F' : 'U'}</Tag>}{l.material && <span className="sr-only"> material</span>}</td>
                        <td className={`${s.n} ${s.muted}`}>{money(l.pyCents)}</td>
                        <td className={s.n}>{pctText(l.pyChangePct)}</td>
                        <td>{l.explanation ? <Tag tone={l.explanation.status === 'REVIEWED' ? 'pos' : 'default'}>{l.explanation.status === 'REVIEWED' ? 'Reviewed' : 'Explained'}</Tag> : l.material ? <Tag tone="warn">Needs a note</Tag> : null}</td>
                      </tr>
                    )),
                    st ? (
                      <tr key={`${sec}-t`} className={s.totalRow}>
                        <td>Total {SECTION_LABEL[sec].toLowerCase()}</td>
                        <td className={s.n}>{money(st.actualCents)}</td>
                        <td className={s.n}>{money(st.budgetCents)}</td>
                        <td className={s.n}>{money(st.actualCents - st.budgetCents, { sign: 'delta' })}</td>
                        <td className={s.n}>{st.budgetCents ? pctText((st.actualCents - st.budgetCents) / Math.abs(st.budgetCents)) : '—'}</td>
                        <td />
                        <td className={s.n}>{money(st.pyCents)}</td>
                        <td className={s.n}>{st.pyCents ? pctText((st.actualCents - st.pyCents) / Math.abs(st.pyCents)) : '—'}</td>
                        <td />
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={s.surface}>
        <div className={s.toolbar}><span className={s.toolbarTitle}>Variances to explain · {material.length}</span></div>
        {material.length === 0 ? (
          <div className={s.state}><p>No variance crosses the materiality line in this window.</p></div>
        ) : (
          <ul className={s.varList}>
            {material.map((l) => (
              <VarianceItem key={l.accountId} line={l} locationId={locationId} versionId={d.version?.id ?? null} departmentId={departmentId} periodKey={periodKey} window={window}
                canReview={finance && (access?.canApprove || access?.canEdit) === true} userId={access?.userId ?? ''} onChanged={() => q.refetch()} onDrill={() => setDrill(l)} />
            ))}
          </ul>
        )}
      </div>

      <DrillDrawer line={drill} onClose={() => setDrill(null)} locationId={locationId} fiscalYear={fiscalYear} month={notStarted ? 12 : month} window={notStarted ? 'YTD' : window} departmentId={departmentId} />
    </div>
  );
}

function VarianceItem({ line, locationId, versionId, departmentId, periodKey, window, canReview, userId, onChanged, onDrill }: {
  line: BvaLine; locationId: string; versionId: string | null; departmentId: string | null; periodKey: string; window: BvaWindow;
  canReview: boolean; userId: string; onChanged: () => void; onDrill: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const e = line.explanation;

  const explain = async () => {
    setBusy(true);
    const res = await api.post('/api/budgets/comments', {
      location_id: locationId, version_id: versionId, department_id: departmentId, account_id: line.accountId, kind: 'VARIANCE_EXPLANATION',
      body: text, period_key: periodKey, variance_window: window, variance_cents: line.varianceCents,
    });
    setBusy(false);
    if (res.error) return toast.error(errText(res.error));
    setText('');
    toast(`Explained ${line.accountName}`);
    onChanged();
  };
  const review = async () => {
    if (!e) return;
    setBusy(true);
    const res = await api.patch('/api/budgets/comments', { comment_id: e.id, action: 'review', note: reviewNote || null });
    setBusy(false);
    if (res.error) return toast.error(errText(res.error));
    toast(`Reviewed the ${line.accountName} explanation`);
    onChanged();
  };

  return (
    <li className={s.varItem}>
      <div className={s.varHead}>
        <button type="button" className={s.linkBtn} onClick={onDrill}>{line.accountNumber} {line.accountName}</button>
        <span className={s.row}>
          <span className={s.tnum}>Actual {money(line.actualCents)} vs budget {money(line.budgetCents)}</span>
          {line.verdict === 'no_budget'
            ? <Tag tone="default">{money(line.varianceCents, { sign: 'delta' })} · not budgeted</Tag>
            : <Tag tone={line.verdict === 'favourable' ? 'pos' : 'neg'}>{money(line.varianceCents, { sign: 'delta' })} {line.verdict === 'favourable' ? 'F' : 'U'}</Tag>}
        </span>
      </div>
      {e ? (
        <div className={`${s.note} ${e.status === 'REVIEWED' ? s.noteReviewed : ''}`}>
          <p style={{ margin: 0 }}>{e.body}</p>
          <div className={s.hint}>{e.authorName ?? (e.authorUserId === userId ? 'You' : 'Owner')} · {shortDate(e.createdAt)}{e.status === 'REVIEWED' ? ` · reviewed${e.reviewNote ? `: “${e.reviewNote}”` : ''}` : ' · awaiting review'}</div>
          {e.status !== 'REVIEWED' && canReview && e.authorUserId !== userId && (
            <div className={s.row} style={{ marginTop: 8 }}>
              <Field label="Review note (optional)" className={s.grow}><Textarea rows={1} value={reviewNote} onChange={(ev) => setReviewNote(ev.target.value)} /></Field>
              <Button onClick={review} disabled={busy}>Mark reviewed</Button>
            </div>
          )}
        </div>
      ) : (
        <div className={s.row} style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <Field label="Why did this move?" className={s.grow} help="At least a sentence — it goes to the reviewer and the monthly pack.">
            <Textarea rows={2} value={text} maxLength={4000} onChange={(ev) => setText(ev.target.value)} />
          </Field>
          <Button variant="primary" onClick={explain} disabled={busy || text.trim().length < 10}>Explain</Button>
        </div>
      )}
    </li>
  );
}

function DrillDrawer({ line, onClose, locationId, fiscalYear, month, window, departmentId }: {
  line: BvaLine | null; onClose: () => void; locationId: string; fiscalYear: number; month: number; window: BvaWindow; departmentId: string | null;
}) {
  const [which, setWhich] = useState<'actual' | 'py'>('actual');
  const q = useQuery<{ lines: GlDrillLine[]; totalCents: number; from: string; to: string }>(
    line ? '/api/budgets/department-view/drill' : null,
    { location_id: locationId, fiscal_year: String(fiscalYear), month: String(month), window, department_id: departmentId ?? 'company', account_id: line?.accountId, which },
  );
  return (
    <Drawer open={!!line} onClose={onClose} width={480} eyebrow={['GL detail', which === 'actual' ? 'This period' : 'Last year']} title={line ? `${line.accountNumber} ${line.accountName}` : ''}
      meta={q.data ? `${q.data.from} – ${q.data.to} · ${money(q.data.totalCents)}` : undefined}>
      <Seg aria-label="Period" items={[{ value: 'actual', label: 'This period' }, { value: 'py', label: 'Last year' }]} value={which} onChange={setWhich} />
      <PanelSection title="Posted lines" meta={q.data ? String(q.data.lines.length) : ''}>
        {q.isLoading && <p className={s.muted}>Loading…</p>}
        {q.error && <InlineNotice tone="neg">{q.error}</InlineNotice>}
        {q.data && q.data.lines.length === 0 && <p className={s.muted}>No posted lines for this account and department in the period.</p>}
        <ul className={s.glList}>
          {(q.data?.lines ?? []).map((g) => (
            <li key={g.lineId}>
              <span className={s.tnum}>{g.entryDate}</span>
              <span><a href={`/journal-entries?id=${g.entryId}`}>{g.entryNumber}</a>{g.memo ? <span className={s.hint}> · {g.memo}</span> : null}</span>
              <span className={s.tnum}>{money(g.naturalCents)}</span>
            </li>
          ))}
        </ul>
      </PanelSection>
    </Drawer>
  );
}
