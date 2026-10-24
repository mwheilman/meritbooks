'use client';

/**
 * Driver panel (Wave 4B, AC-B13): build one row from a driver — pick the method, fill its inputs
 * (dollars → cents, % → basis points), preview the 12 months with the plain-English explanation,
 * then apply (writes the months and remembers the driver for the bridges).
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Field, Input, InlineNotice, MoneyInput, PanelSection, Select, Textarea, api, money, toast } from '@meritbooks/merit-ui';
import {
  BRIDGE_DRIVERS,
  BRIDGE_DRIVER_LABEL,
  DRIVER_METHODS,
  DRIVER_METHOD_LABEL,
  type BridgeDriver,
  type DriverMethod,
  type GridRow,
} from '@/lib/budgets/types';
import { MONTH_LABELS, errText } from './budget-format';
import s from './budgets.module.css';

type ParamKind = 'money' | 'pct' | 'count' | 'month';
const PARAMS: Record<DriverMethod, Array<{ key: string; label: string; kind: ParamKind; help?: string }>> = {
  FIXED_MONTHLY: [{ key: 'monthlyCents', label: 'Amount a month', kind: 'money' }],
  ANNUAL_EVEN: [{ key: 'annualCents', label: 'Amount for the year', kind: 'money' }],
  ANNUAL_SEASONAL: [{ key: 'annualCents', label: 'Amount for the year', kind: 'money', help: 'Spread by last year’s monthly shape for this line.' }],
  PY_GROWTH: [{ key: 'growthBps', label: 'Growth over last year %', kind: 'pct' }],
  PRIOR_BUDGET_GROWTH: [{ key: 'growthBps', label: 'Growth over last year’s budget %', kind: 'pct' }],
  PCT_OF_REVENUE: [{ key: 'pctBps', label: '% of department revenue', kind: 'pct', help: 'Uses the revenue already budgeted in this department.' }],
  HEADCOUNT_RATE: [
    { key: 'headcount', label: 'Headcount', kind: 'count' },
    { key: 'monthlyRateCents', label: 'Monthly pay per person', kind: 'money' },
    { key: 'burdenBps', label: 'Burden % (taxes, benefits)', kind: 'pct' },
    { key: 'startMonth', label: 'Starts in', kind: 'month' },
  ],
  UNITS_RATE: [
    { key: 'unitsPerMonth', label: 'Units a month', kind: 'count' },
    { key: 'rateCents', label: 'Rate per unit', kind: 'money' },
    { key: 'growthBps', label: 'Unit growth by year end %', kind: 'pct' },
  ],
  MANUAL: [],
};

interface DriverResult { months: number[]; annualCents: number; explain: string; fellBackToEven: boolean }

export interface DriverDrawerProps {
  open: boolean;
  onClose: () => void;
  versionId: string;
  departmentId: string | null;
  row: GridRow | null;
  editable: boolean;
  onApplied: () => void;
}

export function DriverDrawer({ open, onClose, versionId, departmentId, row, editable, onApplied }: DriverDrawerProps) {
  const [method, setMethod] = useState<DriverMethod>('PY_GROWTH');
  const [params, setParams] = useState<Record<string, number>>({});
  const [pctText, setPctText] = useState<Record<string, string>>({});
  const [bridge, setBridge] = useState<BridgeDriver>('AUTO');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<DriverResult | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'apply'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !row) return;
    const d = row.driver;
    const m = d?.method ?? (row.pyActualCents ? 'PY_GROWTH' : 'FIXED_MONTHLY');
    setMethod(m);
    setParams(d?.params ?? { startMonth: 1 });
    setPctText(Object.fromEntries(Object.entries(d?.params ?? {}).filter(([k]) => /Bps$/.test(k)).map(([k, v]) => [k, String(v / 100)])));
    setBridge(d?.bridgeDriver ?? 'AUTO');
    setNote(d?.note ?? '');
    setPreview(null);
    setError(null);
  }, [open, row]);

  const fields = PARAMS[method];
  const body = useMemo(
    () => ({ version_id: versionId, department_id: departmentId, account_id: row?.accountId ?? '', method, params, bridge_driver: bridge, note: note.trim() || null }),
    [versionId, departmentId, row, method, params, bridge, note],
  );

  const call = async (dryRun: boolean) => {
    if (!row) return;
    setBusy(dryRun ? 'preview' : 'apply');
    setError(null);
    const res = await api.post<DriverResult>('/api/budgets/lines/driver', { ...body, dry_run: dryRun });
    setBusy(null);
    if (res.error || !res.data) {
      setError(errText(res.error));
      return;
    }
    setPreview(res.data);
    if (!dryRun) {
      toast(`${row.accountName}: ${money(res.data.annualCents)} for the year`);
      onApplied();
      onClose();
    }
  };

  const setP = (k: string, v: number | null) => setParams((p) => ({ ...p, [k]: v ?? 0 }));

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={440}
      eyebrow={['Driver', departmentId ? 'Department line' : 'Company line']}
      title={row ? `${row.accountNumber} ${row.accountName}` : 'Driver'}
      meta={row ? `Last year ${money(row.pyActualCents)} · this version ${money(row.totalCents)}` : undefined}
      foot={
        <>
          <Button variant="quiet" onClick={onClose}>Close</Button>
          <Button onClick={() => call(true)} disabled={!row || busy !== null}>{busy === 'preview' ? 'Working…' : 'Preview'}</Button>
          {editable && <Button variant="primary" onClick={() => call(false)} disabled={!row || busy !== null}>{busy === 'apply' ? 'Applying…' : 'Apply to row'}</Button>}
        </>
      }
    >
      {!editable && <InlineNotice tone="info" className={s.notice}>This version is read-only — you can preview a driver but not apply it.</InlineNotice>}
      {error && <InlineNotice tone="neg" className={s.notice}>{error}</InlineNotice>}
      <PanelSection title="How this line is built">
        <div className={s.stack}>
          <Field label="Method">
            <Select value={method} onChange={(e) => { setMethod(e.target.value as DriverMethod); setPreview(null); }}>
              {DRIVER_METHODS.map((m) => <option key={m} value={m}>{DRIVER_METHOD_LABEL[m]}</option>)}
            </Select>
          </Field>
          {fields.map((f) => (
            <Field key={f.key} label={f.label} help={f.help}>
              {f.kind === 'money' ? (
                <MoneyInput valueCents={params[f.key] ?? null} onChangeCents={(c) => setP(f.key, c)} />
              ) : f.kind === 'pct' ? (
                <Input
                  inputMode="decimal"
                  value={pctText[f.key] ?? ''}
                  onChange={(e) => {
                    const t = e.target.value;
                    setPctText((p) => ({ ...p, [f.key]: t }));
                    const n = Number(t.replace('%', ''));
                    if (t.trim() === '' || Number.isFinite(n)) setP(f.key, t.trim() === '' ? 0 : Math.round(n * 100));
                  }}
                />
              ) : f.kind === 'month' ? (
                <Select value={String(params[f.key] ?? 1)} onChange={(e) => setP(f.key, parseInt(e.target.value, 10))}>
                  {MONTH_LABELS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
                </Select>
              ) : (
                <Input inputMode="decimal" value={params[f.key] === undefined ? '' : String(params[f.key])} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setP(f.key, n); }} />
              )}
            </Field>
          ))}
          <Field label="Reports in the last-year → budget bridge as" help="Auto decides from the line (new, dropped, payroll, revenue growth, volume-driven cost).">
            <Select value={bridge} onChange={(e) => setBridge(e.target.value as BridgeDriver)}>
              {BRIDGE_DRIVERS.map((b) => <option key={b} value={b}>{b === 'AUTO' ? 'Auto' : BRIDGE_DRIVER_LABEL[b]}</option>)}
            </Select>
          </Field>
          <Field label="Note for the reviewer (optional)">
            <Textarea rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </PanelSection>
      {preview && (
        <PanelSection title="Preview" meta={money(preview.annualCents)}>
          <p aria-live="polite">{preview.explain}</p>
          {preview.fellBackToEven && <p className={s.muted}>Last year has no usable monthly shape, so the amount is spread evenly.</p>}
          <div className={s.months}>
            {preview.months.map((v, i) => (
              <div key={i} className={s.monthFig}><span>{MONTH_LABELS[i]}</span>{money(v)}</div>
            ))}
          </div>
        </PanelSection>
      )}
    </Drawer>
  );
}
