'use client';

import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, Drawer, Field, Input, MoneyInput, Select, Switch, Tag, Textarea, toast, useQuery } from '@meritbooks/merit-ui';
import { usd, type CompanySettings, type SettingsResponse } from './cash-types';
import s from './cash.module.css';

type Basis = CompanySettings['runrateBasis'];
const BASIS_WORD: Record<Basis, string> = { BUDGET: 'Published budget', TRAILING_3M: 'Last 3 months’ actuals', OFF: 'Off' };
const SOURCE_WORD: Record<string, string> = { CONFIGURED: 'Entered here', BANK_FEED: 'Bank feed (available credit)', DEBT_REGISTER: 'Debt register (limit − balance)' };

interface Row {
  minimum: number | null;
  alerts: boolean;
  employerTaxPct: string;
  estTax: number | null;
  basis: Basis;
  unapproved: boolean;
}

function rowOf(st: CompanySettings, locationMin: number): Row {
  return {
    minimum: st.minimumCashCents > 0 ? st.minimumCashCents : locationMin > 0 ? locationMin : null,
    alerts: st.alertsEnabled,
    employerTaxPct: st.employerTaxBps === null ? '' : String(st.employerTaxBps / 100),
    estTax: st.estimatedTaxQuarterlyCents,
    basis: st.runrateBasis,
    unapproved: st.includeUnapprovedBills,
  };
}

interface LineDraft {
  id: string | null;
  location_id: string;
  name: string;
  commitment: number | null;
  borrowingBase: number | null;
  drawn: number | null;
  instrument_id: string;
  as_of_date: string;
  note: string;
}

/**
 * Per-company cash assumptions (minimum cash + alerts, employer payroll tax, estimated income tax,
 * opex run-rate basis, unapproved bills) and the credit lines that make up liquidity headroom.
 */
export function SettingsTab({ locationId, refreshKey, onChanged }: { locationId: string | null; refreshKey: number; onChanged: () => void }) {
  const q = useQuery<SettingsResponse>('/api/cash/settings', { location_id: locationId ?? 'all' }, { key: `set:${refreshKey}`, scope: false });
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [line, setLine] = useState<LineDraft | null>(null);
  const [lineErr, setLineErr] = useState<string | null>(null);
  const [removeLine, setRemoveLine] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setRows(Object.fromEntries(q.data.companies.map((c) => [c.id, rowOf(c.settings, c.locationMinimumCents)])));
  }, [q.data]);

  const save = async (id: string) => {
    const r = rows[id];
    if (!r) return;
    const er = r.employerTaxPct.trim() === '' ? null : Math.round(Number(r.employerTaxPct) * 100);
    if (er !== null && !(er >= 0 && er <= 3000)) {
      toast.error('Employer payroll tax must be between 0% and 30%.');
      return;
    }
    setSaving(id);
    try {
      const res = await fetch('/api/cash/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ location_id: id, minimum_cash_cents: r.minimum, alerts_enabled: r.alerts, employer_tax_bps: er, estimated_tax_quarterly_cents: r.estTax, runrate_basis: r.basis, include_unapproved_bills: r.unapproved }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${res.status})`);
      toast('Cash settings saved — the forecast is recalculating.');
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const saveLine = async () => {
    if (!line) return;
    if (!line.location_id || !line.name.trim() || line.commitment === null) {
      setLineErr('Company, name and commitment are required.');
      return;
    }
    setLineErr(null);
    const res = await fetch('/api/cash/liquidity-lines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        ...(line.id ? { id: line.id } : {}),
        location_id: line.location_id,
        name: line.name.trim(),
        commitment_cents: line.commitment,
        borrowing_base_cents: line.borrowingBase,
        drawn_cents: line.drawn,
        instrument_id: line.instrument_id || null,
        as_of_date: line.as_of_date || null,
        note: line.note.trim() || null,
      }),
    });
    if (!res.ok) {
      setLineErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${res.status})`);
      return;
    }
    toast('Line saved.');
    setLine(null);
    onChanged();
  };

  if (q.isLoading) {
    return (
      <div className={s.state} role="status" style={{ marginTop: 16 }}>
        <p className="t-cap">Loading cash settings…</p>
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className={s.state} role="alert" style={{ marginTop: 16 }}>
        <p className="t-head">Couldn’t load cash settings.</p>
        <p className="t-cap">{q.error}</p>
        <Button onClick={() => void q.refetch()}>Try again</Button>
      </div>
    );
  }
  const d = q.data;
  const names = new Map(d.companies.map((c) => [c.id, c.name]));

  return (
    <div style={{ marginTop: 16 }}>
      <h2 className={`t-section ${s.section}`}>01 // Assumptions by company</h2>
      {d.companies.length === 0 ? (
        <p className="t-cap">No companies in your scope.</p>
      ) : (
        <div className={s.tableWrap}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Company</th>
                <th>Minimum cash</th>
                <th>Alert below minimum</th>
                <th>Employer payroll tax %</th>
                <th>Estimated tax / quarter</th>
                <th>Opex run-rate</th>
                <th>Unapproved bills</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.companies.map((c) => {
                const r = rows[c.id];
                if (!r) return null;
                const set = (patch: Partial<Row>) => setRows({ ...rows, [c.id]: { ...r, ...patch } });
                return (
                  <tr key={c.id}>
                    <td>
                      <span className="l1">{c.name}</span>
                      <span className="l2">{c.settings.configured ? 'Custom' : 'Defaults'}</span>
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <MoneyInput aria-label={`${c.name} minimum cash`} valueCents={r.minimum} onChangeCents={(v) => set({ minimum: v === null ? null : Math.max(0, v) })} />
                    </td>
                    <td>
                      <Switch aria-label={`${c.name} minimum-cash alerts`} checked={r.alerts} onChange={(e) => set({ alerts: e.target.checked })} />
                    </td>
                    <td style={{ minWidth: 110 }}>
                      <Input aria-label={`${c.name} employer payroll tax percent`} type="number" inputMode="decimal" step="0.01" min={0} max={30} placeholder="From runs" value={r.employerTaxPct} onChange={(e) => set({ employerTaxPct: e.target.value })} />
                    </td>
                    <td style={{ minWidth: 150 }}>
                      <MoneyInput aria-label={`${c.name} estimated tax per quarter`} valueCents={r.estTax} onChangeCents={(v) => set({ estTax: v === null ? null : Math.max(0, v) })} />
                    </td>
                    <td>
                      <Select aria-label={`${c.name} opex run-rate basis`} value={r.basis} onChange={(e) => set({ basis: e.target.value as Basis })}>
                        {(Object.keys(BASIS_WORD) as Basis[]).map((b) => (
                          <option key={b} value={b}>
                            {BASIS_WORD[b]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <Switch aria-label={`${c.name} include unapproved bills`} checked={r.unapproved} onChange={(e) => set({ unapproved: e.target.checked })} label={r.unapproved ? 'Included' : 'Left out'} />
                    </td>
                    <td className="n">
                      <Button variant="primary" disabled={saving === c.id} onClick={() => void save(c.id)}>
                        {saving === c.id ? 'Saving…' : 'Save'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="t-cap" style={{ marginTop: 8 }}>
        Minimum cash drives the alert (a critical notification to finance admins the first week a company is projected below it) and the transfer / line-draw suggestions. The opex run-rate adds budgeted spend nothing else covers — payroll, rent, interest and non-cash accounts are never double counted.
      </p>

      <div className="row row--between">
        <h2 className={`t-section ${s.section}`}>02 // Credit lines (liquidity headroom)</h2>
        <Button variant="primary" icon="plus" onClick={() => setLine({ id: null, location_id: locationId ?? d.companies[0]?.id ?? '', name: '', commitment: null, borrowingBase: null, drawn: null, instrument_id: '', as_of_date: '', note: '' })}>
          Add a line
        </Button>
      </div>
      {d.lines.length === 0 ? (
        <div className={s.state}>
          <p className="t-head">No credit lines on file.</p>
          <p className="t-cap">Add a revolver here, connect its bank feed, or record it in the debt register as a line of credit — available credit then counts as liquidity.</p>
        </div>
      ) : (
        <div className={s.tableWrap}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Line</th>
                <th>Company</th>
                <th className="n">Commitment</th>
                <th className="n">Borrowing base</th>
                <th className="n">Drawn</th>
                <th className="n">Available</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => {
                const cfg = l.source === 'CONFIGURED' ? d.configuredLines.find((x) => `line:${x.id}` === l.key) : undefined;
                return (
                  <tr key={l.key}>
                    <td>{l.name}</td>
                    <td>{names.get(l.companyId) ?? '—'}</td>
                    <td className="n tnum">{usd(l.commitmentCents)}</td>
                    <td className="n tnum">{usd(l.borrowingBaseCents)}</td>
                    <td className="n tnum">{usd(l.drawnCents)}</td>
                    <td className="n tnum">
                      <strong>{usd(l.availableCents)}</strong>
                    </td>
                    <td>
                      <Tag>{SOURCE_WORD[l.source] ?? l.source}</Tag>
                    </td>
                    <td className="n">
                      {cfg && (
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <Button
                            variant="quiet"
                            onClick={() =>
                              setLine({ id: cfg.id, location_id: cfg.location_id, name: cfg.name, commitment: Number(cfg.commitment_cents), borrowingBase: cfg.borrowing_base_cents === null ? null : Number(cfg.borrowing_base_cents), drawn: cfg.drawn_cents === null ? null : Number(cfg.drawn_cents), instrument_id: cfg.instrument_id ?? '', as_of_date: cfg.as_of_date ?? '', note: cfg.note ?? '' })
                            }
                          >
                            Edit
                          </Button>
                          <Button variant="quiet" icon="x" aria-label={`Remove ${cfg.name}`} onClick={() => setRemoveLine({ id: cfg.id, name: cfg.name })} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={line !== null}
        onClose={() => setLine(null)}
        eyebrow={['Liquidity', 'Credit line']}
        title={line?.id ? 'Edit line' : 'Add a line'}
        foot={
          <div className="row">
            <Button variant="quiet" onClick={() => setLine(null)}>
              Cancel
            </Button>
            <span className="sp" />
            <Button variant="primary" onClick={() => void saveLine()}>
              Save line
            </Button>
          </div>
        }
      >
        {line && (
          <div className="stack">
            <Field label="Company">
              <Select value={line.location_id} disabled={!!line.id} onChange={(e) => setLine({ ...line, location_id: e.target.value, instrument_id: '' })}>
                {d.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Name">
              <Input value={line.name} maxLength={120} onChange={(e) => setLine({ ...line, name: e.target.value })} placeholder="Operating revolver" />
            </Field>
            <Field label="Commitment (limit)">
              <MoneyInput valueCents={line.commitment} onChangeCents={(v) => setLine({ ...line, commitment: v })} />
            </Field>
            <Field label="Borrowing base (optional)" help="When the bank caps availability by a borrowing base, availability is the lower of the two.">
              <MoneyInput valueCents={line.borrowingBase} onChangeCents={(v) => setLine({ ...line, borrowingBase: v })} />
            </Field>
            <Field label="Drawn (optional)" help="Leave blank to use the linked loan's balance.">
              <MoneyInput valueCents={line.drawn} onChangeCents={(v) => setLine({ ...line, drawn: v })} />
            </Field>
            <Field label="Linked loan (optional)">
              <Select value={line.instrument_id} onChange={(e) => setLine({ ...line, instrument_id: e.target.value })}>
                <option value="">None</option>
                {d.instruments
                  .filter((i) => i.location_id === line.location_id)
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="As of">
              <Input type="date" value={line.as_of_date} onChange={(e) => setLine({ ...line, as_of_date: e.target.value })} />
            </Field>
            <Field label="Note" error={lineErr ?? undefined}>
              <Textarea rows={2} maxLength={1000} value={line.note} onChange={(e) => setLine({ ...line, note: e.target.value })} />
            </Field>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={removeLine !== null}
        onClose={() => setRemoveLine(null)}
        title={`Remove “${removeLine?.name ?? ''}”?`}
        confirmLabel="Remove line"
        tone="danger"
        onConfirm={async () => {
          const l = removeLine;
          setRemoveLine(null);
          if (!l) return;
          const res = await fetch(`/api/cash/liquidity-lines?id=${encodeURIComponent(l.id)}`, { method: 'DELETE', credentials: 'same-origin' });
          if (!res.ok) toast.error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not remove the line');
          else {
            toast('Line removed from liquidity.');
            onChanged();
          }
        }}
      >
        Its availability stops counting as liquidity headroom. The change is kept in the cash audit log.
      </ConfirmDialog>
    </div>
  );
}
