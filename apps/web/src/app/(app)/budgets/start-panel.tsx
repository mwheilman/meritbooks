'use client';

/**
 * "Start this department" (Wave 4B, AC-B13 / AC-B14): last year's actuals + x% (month shape kept),
 * or a recommended / tenant template resolved against this chart — preview first, then apply.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Field, Input, InlineNotice, Seg, Select, api, money, toast, useQuery } from '@meritbooks/merit-ui';
import { suggestTemplateKey } from '@/lib/budgets/templates/system';
import { DRIVER_METHOD_LABEL, type BudgetTemplate, type TemplateLine, type TemplatePreviewLine } from '@/lib/budgets/types';
import { errText } from './budget-format';
import s from './budgets.module.css';

interface TemplatesResponse { system: BudgetTemplate[]; tenant: BudgetTemplate[]; history: Record<string, number[]>; canEdit: boolean }
interface PreviewResponse { template: BudgetTemplate; lines: TemplatePreviewLine[]; missing: TemplateLine[]; annualRevenueCents: number; annualExpenseCents: number; changed?: number }

export interface StartPanelProps {
  open: boolean;
  onClose: () => void;
  locationId: string;
  versionId: string;
  departmentId: string | null;
  departmentName: string;
  fiscalYear: number;
  onApplied: () => void;
}

export function StartPanel({ open, onClose, locationId, versionId, departmentId, departmentName, fiscalYear, onApplied }: StartPanelProps) {
  const [mode, setMode] = useState<'PRIOR_YEAR' | 'TEMPLATE'>('TEMPLATE');
  const [growth, setGrowth] = useState('3');
  const [templateId, setTemplateId] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'apply'>(null);
  const [error, setError] = useState<string | null>(null);
  const tq = useQuery<TemplatesResponse>(open ? '/api/budgets/templates' : null, { location_id: locationId });

  const suggested = useMemo(() => `system:${suggestTemplateKey(departmentName)}`, [departmentName]);
  const options = useMemo(() => {
    const sys = [...(tq.data?.system ?? [])].sort((a, b) => Number(b.id === suggested) - Number(a.id === suggested));
    return { sys, tenant: tq.data?.tenant ?? [] };
  }, [tq.data, suggested]);

  useEffect(() => {
    if (open) {
      setPreview(null);
      setError(null);
      setTemplateId((t) => t || suggested);
    }
  }, [open, suggested]);

  const growthBps = Math.round(Number(growth.replace('%', '') || '0') * 100);
  const growthOk = Number.isFinite(growthBps) && growthBps >= -10000 && growthBps <= 100000;

  const run = async (apply: boolean) => {
    setBusy(apply ? 'apply' : 'preview');
    setError(null);
    if (mode === 'PRIOR_YEAR') {
      const res = await api.post<{ rows: number; annualCents: number; changed: number }>('/api/budgets/lines/start', { version_id: versionId, department_id: departmentId, mode, growth_bps: growthBps });
      setBusy(null);
      if (res.error || !res.data) return setError(errText(res.error));
      toast(`Filled ${res.data.rows} lines from FY${fiscalYear - 1} actuals · ${money(res.data.annualCents)}`);
      onApplied();
      onClose();
      return;
    }
    const res = await api.post<PreviewResponse>('/api/budgets/lines/start', {
      version_id: versionId, department_id: departmentId, mode, template_id: templateId, growth_bps: growthOk && growth.trim() !== '' ? growthBps : null, preview: !apply,
    });
    setBusy(null);
    if (res.error || !res.data) return setError(errText(res.error));
    setPreview(res.data);
    if (apply) {
      toast(`Applied ${res.data.template.name} · ${res.data.lines.length} lines`);
      onApplied();
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={720}
      title={`Start ${departmentId ? departmentName : 'company-level lines'}`}
      footNote="Applying replaces the months of the lines it writes; other lines are left alone."
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          {mode === 'TEMPLATE' && <Button onClick={() => run(false)} disabled={!templateId || busy !== null || !growthOk}>{busy === 'preview' ? 'Working…' : 'Preview'}</Button>}
          <Button variant="primary" onClick={() => run(true)} disabled={busy !== null || !growthOk || (mode === 'TEMPLATE' && !templateId)}>
            {busy === 'apply' ? 'Applying…' : mode === 'TEMPLATE' ? 'Apply template' : `Fill from FY${fiscalYear - 1} actuals`}
          </Button>
        </>
      }
    >
      <Seg
        aria-label="Start from"
        items={[{ value: 'TEMPLATE', label: 'A template' }, { value: 'PRIOR_YEAR', label: 'Last year’s actuals' }]}
        value={mode}
        onChange={(v) => { setMode(v); setPreview(null); }}
      />
      {error && <InlineNotice tone="neg" className={s.notice}>{error}</InlineNotice>}
      <div className={s.formGrid} style={{ marginTop: 12 }}>
        {mode === 'TEMPLATE' && (
          <Field label="Template" help={tq.isLoading ? 'Loading templates…' : tq.error ?? 'The suggestion for this department is first.'}>
            <Select value={templateId} onChange={(e) => { setTemplateId(e.target.value); setPreview(null); }}>
              <optgroup label="Recommended">
                {options.sys.map((t) => <option key={t.id} value={t.id}>{t.name}{t.id === suggested ? ' (suggested)' : ''}</option>)}
              </optgroup>
              {options.tenant.length > 0 && (
                <optgroup label="Your templates">
                  {options.tenant.map((t) => <option key={t.id} value={t.id}>{t.name} · v{t.version}</option>)}
                </optgroup>
              )}
            </Select>
          </Field>
        )}
        <Field label={mode === 'TEMPLATE' ? 'Growth % for “last year + x%” lines (blank = template default)' : 'Growth over last year %'}>
          <Input inputMode="decimal" value={growth} onChange={(e) => setGrowth(e.target.value)} aria-invalid={!growthOk || undefined} />
        </Field>
      </div>
      {mode === 'PRIOR_YEAR' && (
        <p className={s.muted}>Every account with FY{fiscalYear - 1} actuals posted to this {departmentId ? 'department' : 'company (no department)'} gets last year’s months × (1 + growth). Each line remembers the driver so the bridge can explain it.</p>
      )}
      {preview && mode === 'TEMPLATE' && (
        <div aria-live="polite">
          <div className={s.row} style={{ margin: '12px 0' }}>
            <strong>{preview.template.name}</strong>
            <span className={s.muted}>Revenue {money(preview.annualRevenueCents)} · Expense {money(preview.annualExpenseCents)}</span>
          </div>
          <table className={s.table}>
            <thead><tr><th>Template line</th><th>Account in your chart</th><th>Driver</th><th className={s.n}>Year</th></tr></thead>
            <tbody>
              {preview.lines.map((l, i) => (
                <tr key={`${l.line.key}-${l.account?.id ?? i}`}>
                  <td>{l.line.label}</td>
                  <td>{l.account ? `${l.account.number} ${l.account.name}` : '—'}</td>
                  <td title={l.explain}>{DRIVER_METHOD_LABEL[l.line.method]}<div className={s.hint}>{l.explain}</div></td>
                  <td className={s.n}>{money(l.annualCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.missing.length > 0 && (
            <InlineNotice tone="warn" title="Not in your chart" className={s.notice}>
              {preview.missing.map((m) => m.label).join(' · ')} — no matching account, so these are skipped. Add the account to the chart, or edit the template.
            </InlineNotice>
          )}
        </div>
      )}
    </Dialog>
  );
}
