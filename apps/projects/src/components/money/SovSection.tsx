'use client';

import { useMemo, useState } from 'react';
import {
  Button, Check, ConfirmDialog, Field, Input, InlineNotice, MoneyInput, Seg, Select, StatementTable, WidgetState, money, pct,
  type StatementRow,
} from '@meritbooks/merit-ui';
import type { CostCodeRow } from '@/lib/pm/types';
import type { BillingLineRow, BillingRequestRow, SovLineRow, SovStatusRow, SovVersionRow } from '@/lib/pm/money/types';
import type { PrimaryContract } from '@/lib/pm/money/queries';
import { g702, g703Line, previousApplications, priorByLineage, type G703Entry } from '@/lib/pm/money/aia';
import { useShell } from '@/components/shell/ShellContext';
import { useAction } from '@/components/job/useAction';
import { m, p, parsePct, pctInput } from './common';
import { G702Table, G703Table, type G703Row } from './PayApp';

export interface SovSectionProps {
  jobId: string;
  versions: SovVersionRow[];
  sovLines: SovLineRow[];
  sovStatus: SovStatusRow[];
  requests: BillingRequestRow[];
  lines: BillingLineRow[];
  contract: PrimaryContract | null;
  revisedContractCents: number;
  costCodes: CostCodeRow[];
  today: string;
  hasAcceptedEstimate: boolean;
  /** Called with the new request id after drafting, so the tab can open it. */
  onDrafted: (id: string) => void;
}

/** Schedule of values (draft → active → revised) and the pay application editor on the active version. */
export function SovSection(p0: SovSectionProps) {
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const active = p0.versions.find((v) => v.status === 'ACTIVE') ?? null;
  const draft = p0.versions.find((v) => v.status === 'DRAFT') ?? null;
  const draftApp = p0.requests.find((r) => r.billing_subtype === 'SOV' && r.status === 'DRAFT') ?? null;
  const [seed, setSeed] = useState(p0.hasAcceptedEstimate);
  const [editing, setEditing] = useState<'new' | 'redo' | null>(null);
  const url = `/api/jobs/${p0.jobId}/billing/sov`;

  if (!active && !draft) {
    return (
      <div className="surface">
        <WidgetState
          state={{
            kind: 'empty',
            title: 'Set up the schedule of values',
            body: 'The schedule of values splits the contract into billable lines. Pay applications bill work and stored materials against each line, with retainage, on the AIA G702/G703.',
            action: readOnly ? undefined : (
              <div className="row">
                {p0.hasAcceptedEstimate && <Check label="Start from the accepted estimate’s prices by cost code" checked={seed} onChange={(e) => setSeed(e.target.checked)} />}
                <Button variant="primary" icon="plus" disabled={busy === 'sov'} onClick={() => void run<{ seeded: number }>('sov', 'post', url, { op: 'create_version', seed: seed ? 'estimate' : 'none' }, (d) => (d.seeded ? `Started the schedule with ${d.seeded} lines from the estimate` : 'Started the schedule of values'))}>
                  Start schedule of values
                </Button>
              </div>
            ),
          }}
        />
      </div>
    );
  }

  return (
    <div className="stack">
      {draft && <SovDraftEditor jobId={p0.jobId} version={draft} lines={p0.sovLines.filter((l) => l.sov_version_id === draft.id)} costCodes={p0.costCodes} revisedContractCents={p0.revisedContractCents} hasActive={!!active} draftApp={!!draftApp} />}
      {active && (
        <>
          <ActiveSov version={active} status={p0.sovStatus} revisedContractCents={p0.revisedContractCents} canRevise={!readOnly && !draft} onRevise={() => void run('rev', 'post', url, { op: 'revise', versionId: active.id }, `Started v${active.version + 1} of the schedule with the same lines`)} busy={busy === 'rev'} />
          {!readOnly && !editing && (
            <div className="btn-row">
              {draftApp ? (
                <Button onClick={() => setEditing('redo')}>Change pay application #{draftApp.application_no} amounts</Button>
              ) : (
                <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New pay application</Button>
              )}
            </div>
          )}
          {editing && (
            <PayAppEditor
              jobId={p0.jobId}
              version={active}
              sovLines={p0.sovLines.filter((l) => l.sov_version_id === active.id)}
              requests={p0.requests}
              lines={p0.lines}
              contract={p0.contract}
              today={p0.today}
              replace={editing === 'redo' ? draftApp : null}
              onCancel={() => setEditing(null)}
              onDrafted={(id) => { setEditing(null); p0.onDrafted(id); }}
            />
          )}
        </>
      )}
    </div>
  );
}

function ActiveSov({ version, status, revisedContractCents, canRevise, onRevise, busy }: { version: SovVersionRow; status: SovStatusRow[]; revisedContractCents: number; canRevise: boolean; onRevise: () => void; busy: boolean }) {
  const total = status.reduce((s, r) => s + r.scheduled_value_cents, 0);
  const rows: StatementRow[] = status.map((r) => ({
    kind: 'line', id: r.sov_line_id,
    label: <><span className="code">{r.line_no}</span> {r.description}</>,
    values: [r.scheduled_value_cents, r.completed_and_stored_cents, r.balance_to_finish_cents, r.retainage_outstanding_cents],
  }));
  rows.push({
    kind: 'grand', label: 'Schedule total', sumOf: status.map((r) => r.sov_line_id),
    values: [total, status.reduce((s, r) => s + r.completed_and_stored_cents, 0), status.reduce((s, r) => s + r.balance_to_finish_cents, 0), status.reduce((s, r) => s + r.retainage_outstanding_cents, 0)],
  });
  const diff = total - revisedContractCents;
  return (
    <div className="sec">
      <div className="sec-h">
        <h2 className="t-section">Schedule of values v{version.version}</h2>
        <span className="t-cap">Active{version.retainage_pct != null ? ` · ${p(version.retainage_pct)} retainage` : ''}</span>
        <span className="sp" />
        {canRevise && <Button disabled={busy} onClick={onRevise}>Revise schedule</Button>}
      </div>
      <StatementTable
        aria-label="Schedule of values, billed to date"
        unitLabel="Line · in US dollars"
        columns={[
          { id: 's', header: 'Scheduled', width: 136 },
          { id: 'c', header: 'Completed & stored', width: 152, current: true },
          { id: 'b', header: 'Balance', width: 136 },
          { id: 'r', header: 'Retainage held', width: 136 },
        ]}
        rows={rows}
        caption={diff === 0 ? `Ties to the revised contract (${money(revisedContractCents)}). Billed to date counts sent, issued and approved applications.` : `${money(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'} the revised contract (${money(revisedContractCents)}). Revise the schedule to add approved change orders.`}
      />
    </div>
  );
}

function SovDraftEditor({ jobId, version, lines, costCodes, revisedContractCents, hasActive, draftApp }: { jobId: string; version: SovVersionRow; lines: SovLineRow[]; costCodes: CostCodeRow[]; revisedContractCents: number; hasActive: boolean; draftApp: boolean }) {
  const { readOnly } = useShell();
  const { run, busy } = useAction();
  const url = `/api/jobs/${jobId}/billing/sov`;
  const [desc, setDesc] = useState('');
  const [val, setVal] = useState<number | null>(null);
  const [cc, setCc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [rate, setRate] = useState(pctInput(version.retainage_pct));
  const total = lines.reduce((s, l) => s + l.scheduled_value_cents, 0);
  const diff = total - revisedContractCents;
  const codes = new Map(costCodes.map((c) => [c.id, c]));

  const add = async () => {
    if (!desc.trim()) return setErr('Describe the line, like “Concrete foundations”.');
    if (val == null) return setErr('Enter the scheduled value.');
    setErr(null);
    const r = await run('add', 'post', url, { op: 'add_line', versionId: version.id, description: desc.trim(), scheduledValueCents: val, costCodeId: cc || null }, 'Added the line');
    if (!r.error) { setDesc(''); setVal(null); }
  };
  const activate = async (f: boolean) => run('act', 'post', url, { op: 'activate', versionId: version.id, force: f }, `Activated schedule v${version.version}`, { quietError: true });

  return (
    <div className="sec">
      <div className="sec-h">
        <h2 className="t-section">Schedule of values v{version.version} · draft</h2>
        <span className="t-cap tnum">{m(total)} of {m(revisedContractCents)} revised contract</span>
        <span className="sp" />
        {!readOnly && (
          <div className="btn-row">
            <Button variant="quiet" disabled={busy === 'del'} onClick={() => void run('del', 'post', url, { op: 'delete_version', versionId: version.id }, 'Deleted the draft schedule')}>Delete draft</Button>
            <Button variant="primary" disabled={busy === 'act' || lines.length === 0 || draftApp}
              title={draftApp ? 'Approve or void the draft pay application first' : undefined}
              onClick={() => (diff === 0 ? void activate(false).then((r) => r.error && setErr(r.error.error)) : setForce(true))}>
              Activate
            </Button>
          </div>
        )}
      </div>
      {hasActive && <p className="t-cap" style={{ marginBottom: 8 }}>The active version stays in use until this one is activated. Billed lines keep their history (same lineage) and cannot drop below what has been billed.</p>}
      {err && <InlineNotice tone="neg" title="Not activated." role="alert">{err}</InlineNotice>}
      <div className="mp-table">
        {lines.length === 0 ? (
          <p className="t-cap" style={{ padding: 16 }}>No lines yet. Split the contract into the lines the owner will see on the G703.</p>
        ) : (
          <table className="tbl tbl-q tbl-q--compact">
            <colgroup><col style={{ width: 48 }} /><col /><col style={{ width: 200 }} /><col style={{ width: 144 }} /><col style={{ width: 96 }} />{!readOnly && <col style={{ width: 48 }} />}</colgroup>
            <thead><tr><th className="n">A</th><th>B · Description of work</th><th>Cost code</th><th className="n">C · Scheduled value</th><th className="n">Retainage</th>{!readOnly && <th><span className="sr">Remove</span></th>}</tr></thead>
            <tbody>
              {lines.map((l) => (
                <SovLineEdit key={l.id} line={l} url={url} versionId={version.id} codes={codes} costCodes={costCodes} readOnly={readOnly} />
              ))}
              <tr className="q-row"><td /><td className="b">Total</td><td /><td className="n b">{m(total)}</td><td /><td /></tr>
            </tbody>
          </table>
        )}
        {!readOnly && (
          <form className="mp-add" onSubmit={(e) => { e.preventDefault(); void add(); }} aria-label="Add a schedule line">
            <Field label="Description of work"><Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} placeholder="Concrete foundations" /></Field>
            <Field label="Cost code"><Select value={cc} onChange={(e) => setCc(e.target.value)} style={{ width: 200 }}><option value="">None</option>{costCodes.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select></Field>
            <Field label="Scheduled value" error={err && !lines.length ? err : undefined}><MoneyInput valueCents={val} onChangeCents={setVal} placeholder="0.00" style={{ width: 144 }} /></Field>
            <Button type="submit" icon="plus" disabled={busy === 'add'}>Add line</Button>
            <span className="sp" style={{ flex: 1 }} />
            <Field label="Retainage % for this schedule" help="Blank = the contract rate">
              <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 96 }}
                onBlur={() => { const f = rate.trim() ? parsePct(rate) : null; if ((rate.trim() === '' || f != null) && f !== version.retainage_pct) void run('rate', 'post', url, { op: 'set_rate', versionId: version.id, retainagePct: f }, 'Saved the retainage rate'); }} />
            </Field>
          </form>
        )}
      </div>
      <ConfirmDialog
        open={force}
        onClose={() => setForce(false)}
        title={`Activate v${version.version} off the contract`}
        confirmLabel="Activate anyway"
        onConfirm={async () => {
          const r = await activate(true);
          if (r.error) throw new Error(r.error.error);
        }}
      >
        The schedule totals {money(total)}; the revised contract is {money(revisedContractCents)} ({money(Math.abs(diff))} {diff > 0 ? 'over' : 'under'}). Pay applications would not reach 100% of the contract. Usually a change order is missing from the schedule.
      </ConfirmDialog>
    </div>
  );
}

function SovLineEdit({ line, url, versionId, codes, costCodes, readOnly }: { line: SovLineRow; url: string; versionId: string; codes: Map<string, CostCodeRow>; costCodes: CostCodeRow[]; readOnly: boolean }) {
  const { run } = useAction();
  const [desc, setDesc] = useState(line.description);
  const [val, setVal] = useState<number | null>(line.scheduled_value_cents);
  const [rate, setRate] = useState(pctInput(line.retainage_pct));
  const save = (patch: Partial<{ description: string; scheduledValueCents: number; costCodeId: string | null; retainagePct: number | null }>, ok: string) =>
    void run(`s:${line.id}`, 'post', url, {
      op: 'update_line', versionId, lineId: line.id, description: line.description, scheduledValueCents: line.scheduled_value_cents,
      costCodeId: line.cost_code_id, retainagePct: line.retainage_pct, ...patch,
    }, ok);
  if (readOnly) {
    const c = line.cost_code_id ? codes.get(line.cost_code_id) : null;
    return <tr className="q-row"><td className="n">{line.line_no}</td><td>{line.description}</td><td>{c ? `${c.code} ${c.name}` : ''}</td><td className="n">{m(line.scheduled_value_cents)}</td><td className="n">{p(line.retainage_pct)}</td></tr>;
  }
  return (
    <tr className="q-row">
      <td className="n">{line.line_no}</td>
      <td><Input aria-label="Description of work" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc.trim() && desc !== line.description && save({ description: desc.trim() }, 'Saved the description')} /></td>
      <td>
        <Select aria-label="Cost code" value={line.cost_code_id ?? ''} onChange={(e) => save({ costCodeId: e.target.value || null }, 'Changed the cost code')}>
          <option value="">None</option>
          {costCodes.filter((c) => c.is_active || c.id === line.cost_code_id).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
        </Select>
      </td>
      <td className="n"><MoneyInput aria-label="Scheduled value" valueCents={val} onChangeCents={setVal} onBlur={() => val != null && val !== line.scheduled_value_cents && save({ scheduledValueCents: val }, 'Saved the scheduled value')} /></td>
      <td className="n"><Input aria-label="Line retainage percent" inputMode="decimal" value={rate} placeholder="—" onChange={(e) => setRate(e.target.value)} onBlur={() => { const f = rate.trim() ? parsePct(rate) : null; if ((rate.trim() === '' || f != null) && f !== line.retainage_pct) save({ retainagePct: f }, 'Saved the line retainage'); }} /></td>
      <td><Button variant="quiet" iconOnly icon="x" aria-label={`Remove line ${line.line_no}`} onClick={() => void run(`r:${line.id}`, 'post', url, { op: 'remove_line', versionId, lineId: line.id }, 'Removed the line')} /></td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Pay application editor (G703 entry with a live G702)
// ---------------------------------------------------------------------------

type EntryMode = 'pct' | 'amount';
interface Entry { pct: string; amount: number | null; stored: number | null }

function endOfMonth(iso: string): string {
  const [y, mo] = iso.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo, 0));
  return d.toISOString().slice(0, 10);
}

function PayAppEditor({ jobId, version, sovLines, requests, lines, contract, today, replace, onCancel, onDrafted }: {
  jobId: string; version: SovVersionRow; sovLines: SovLineRow[]; requests: BillingRequestRow[]; lines: BillingLineRow[]; contract: PrimaryContract | null;
  today: string; replace: BillingRequestRow | null; onCancel: () => void; onDrafted: (id: string) => void;
}) {
  const { run, busy } = useAction();
  const reqById = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests]);
  const prior = useMemo(
    () => priorByLineage(lines.filter((l) => l.billing_request_id !== replace?.id).map((l) => {
      const r = reqById.get(l.billing_request_id);
      return { ...l, request: { status: r?.status ?? 'VOID', application_no: r?.application_no ?? null, created_at: r?.created_at ?? '' } };
    })),
    [lines, reqById, replace?.id],
  );
  const replaceLines = useMemo(() => new Map(lines.filter((l) => l.billing_request_id === replace?.id && l.sov_lineage_id).map((l) => [l.sov_lineage_id!, l])), [lines, replace?.id]);
  const [mode, setMode] = useState<EntryMode>('pct');
  const [periodEnd, setPeriodEnd] = useState(replace?.period_end ?? endOfMonth(today));
  const [entries, setEntries] = useState<Record<string, Entry>>(() => Object.fromEntries(sovLines.map((s) => {
    const pr = prior.get(s.lineage_id);
    const was = replaceLines.get(s.lineage_id);
    const work = (pr?.previousWorkCents ?? 0) + (was?.this_period_work_cents ?? 0);
    return [s.id, { pct: was && s.scheduled_value_cents > 0 ? String(Math.round((work / s.scheduled_value_cents) * 1_000_000) / 10_000) : '', amount: was?.this_period_work_cents ?? null, stored: was?.stored_materials_cents ?? null }];
  })));
  const [err, setErr] = useState<string | null>(null);

  const rateOf = (s: SovLineRow) => s.retainage_pct ?? version.retainage_pct ?? contract?.retention_pct ?? 0;
  const entryOf = (s: SovLineRow): G703Entry | null => {
    const e = entries[s.id];
    if (!e) return null;
    const stored = e.stored;
    if (mode === 'pct') {
      const t = e.pct.trim();
      if (!t && stored == null) return null;
      const f = t ? parsePctLoose(t) : null;
      return { pctComplete: t ? (f ?? -1) : null, thisPeriodCents: t ? null : 0, storedMaterialsCents: stored };
    }
    if (e.amount == null && stored == null) return null;
    return { thisPeriodCents: e.amount ?? 0, storedMaterialsCents: stored };
  };
  const computed: G703Row[] = sovLines.map((s) => ({
    id: s.id, item: s.line_no, description: s.description,
    line: g703Line({ scheduledCents: s.scheduled_value_cents, rate: rateOf(s), prior: prior.get(s.lineage_id) ?? { previousWorkCents: 0, previousStoredCents: 0, previousRetainageCents: 0 }, entry: entryOf(s) }),
  }));
  const appNo = replace?.application_no ?? (Math.max(0, ...requests.filter((r) => r.billing_subtype === 'SOV' && r.status !== 'VOID').map((r) => r.application_no ?? 0)) + 1);
  const prev = previousApplications(requests.filter((r) => r.id !== replace?.id), appNo);
  const summary = g702(computed.map((c) => c.line), { originalContractCents: contract?.original_cents ?? 0, ...prev });
  const bad = computed.filter((c) => c.line.error);

  const submit = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) return setErr('Pick the period end date.');
    if (bad.length) return setErr(`Fix ${bad.length === 1 ? 'line' : 'lines'} ${bad.map((b) => b.item).join(', ')} first.`);
    if (summary.grossThisPeriod <= 0) return setErr('Nothing to bill: enter work this period or stored materials.');
    setErr(null);
    const body = {
      mode: 'sov', sovVersionId: version.id, periodEnd, replaceDraftId: replace?.id ?? null,
      lines: sovLines.flatMap((s) => {
        const e = entryOf(s);
        if (!e) return [];
        return [{ sovLineId: s.id, pctComplete: e.pctComplete ?? null, thisPeriodCents: e.pctComplete != null ? null : e.thisPeriodCents ?? null, storedMaterialsCents: e.storedMaterialsCents ?? null }];
      }),
    };
    const r = await run<{ requestId: string }>('payapp', 'post', `/api/jobs/${jobId}/billing`, body, `${replace ? 'Redrafted' : 'Drafted'} pay application #${appNo}. Someone else approves and sends it`, { quietError: true });
    if (r.error) setErr(r.error.error);
    else if (r.data) onDrafted(r.data.requestId);
  };

  return (
    <div className="sec">
      <div className="sec-h">
        <h2 className="t-section">{replace ? `Change pay application #${appNo}` : `Pay application #${appNo}`}</h2>
        <span className="sp" />
        <Seg<EntryMode> aria-label="Enter work as" value={mode} onChange={setMode} items={[{ value: 'pct', label: '% complete to date' }, { value: 'amount', label: 'Amount this period' }]} />
      </div>
      <div className="mp-table">
        <table className="tbl tbl-q tbl-q--compact">
          <colgroup><col style={{ width: 48 }} /><col /><col style={{ width: 128 }} /><col style={{ width: 128 }} /><col style={{ width: 144 }} /><col style={{ width: 144 }} /></colgroup>
          <thead>
            <tr>
              <th className="n">A</th><th>B · Description</th><th className="n">C · Scheduled</th><th className="n">D · Previous</th>
              <th className="n">{mode === 'pct' ? 'Work to date %' : 'E · This period'}</th><th className="n">F · Stored now</th>
            </tr>
          </thead>
          <tbody>
            {sovLines.map((s) => {
              const e = entries[s.id] ?? { pct: '', amount: null, stored: null };
              const pr = prior.get(s.lineage_id);
              const c = computed.find((x) => x.id === s.id)!;
              const set = (patch: Partial<Entry>) => setEntries({ ...entries, [s.id]: { ...e, ...patch } });
              return (
                <tr key={s.id} className="q-row" aria-invalid={!!c.line.error || undefined}>
                  <td className="n">{s.line_no}</td>
                  <td>{s.description}<span className="l2">{p(pr && s.scheduled_value_cents > 0 ? pr.previousWorkCents / s.scheduled_value_cents : 0)} billed before · {p(rateOf(s))} retainage</span></td>
                  <td className="n">{m(s.scheduled_value_cents)}</td>
                  <td className="n">{m(pr?.previousWorkCents ?? 0)}</td>
                  <td className="n">
                    {mode === 'pct' ? (
                      <Input aria-label={`Line ${s.line_no} work completed to date, percent`} inputMode="decimal" value={e.pct} placeholder={pctInput(pr && s.scheduled_value_cents > 0 ? pr.previousWorkCents / s.scheduled_value_cents : 0)} onChange={(ev) => set({ pct: ev.target.value })} invalid={c.line.error === 'PCT_RANGE'} />
                    ) : (
                      <MoneyInput aria-label={`Line ${s.line_no} work this period`} valueCents={e.amount} onChangeCents={(v) => set({ amount: v })} allowNegative placeholder="0.00" />
                    )}
                  </td>
                  <td className="n"><MoneyInput aria-label={`Line ${s.line_no} materials stored now`} valueCents={e.stored} onChangeCents={(v) => set({ stored: v })} placeholder={m(pr?.previousStoredCents ?? 0)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="t-cap" style={{ margin: '8px 0 16px' }}>
        {mode === 'pct' ? 'Percent is work completed to date on the line, without stored materials.' : 'This period can be negative to correct an earlier application.'} Stored now is the balance on site or in a bonded warehouse; blank carries the last application’s balance forward.
      </p>
      <G703Table rows={computed} caption={`This application bills ${money(summary.grossThisPeriod)} and holds ${money(summary.retainageThisPeriod)} retainage: ${money(summary.netThisPeriod)} due. Preview before any retention cap on the contract${contract?.retention_cap_cents != null ? ` (${money(contract.retention_cap_cents)})` : ''}.`} />
      <div className="grid-12" style={{ marginTop: 24, alignItems: 'start', rowGap: 16 }}>
        <div style={{ gridColumn: 'span 6' }}><G702Table s={summary} applicationNo={appNo} /></div>
        <div style={{ gridColumn: 'span 6' }} className="stack">
          <Field label="Period ending" help="The application date Merit Books puts on the invoice"><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>
          {err && <InlineNotice tone="neg" title="Not drafted." role="alert">{err}</InlineNotice>}
          {replace && <InlineNotice title={`Replaces the draft of #${appNo}.`}>The current draft is voided and drafted again with these amounts.</InlineNotice>}
          <div className="btn-row">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={busy === 'payapp'} onClick={() => void submit()}>{replace ? 'Redraft' : 'Draft'} pay application</Button>
          </div>
          <p className="t-cap">Drafting does not send anything. Someone other than you approves it and sends it to Merit Books.</p>
          <p className="t-cap tnum">{pct(summary.contractSumToDate > 0 ? summary.completedStoredToDate / summary.contractSumToDate : 0)} complete and stored after this application.</p>
        </div>
      </div>
    </div>
  );
}

/** "12.5" → 0.125 with up to 4 decimals of a percent (6 of the fraction); null when not 0–100. */
function parsePctLoose(t: string): number | null {
  const s = t.trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 100 ? Math.round(n * 10_000) / 1_000_000 : null;
}
