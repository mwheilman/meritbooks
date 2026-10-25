'use client';

import { useState } from 'react';
import { Button, ButtonRow, Field, InlineNotice, Input, Select, Status, count, money } from '@meritbooks/merit-ui';
import { continuation, issueWords } from '@/lib/development/draw';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, centsFrom, day, pctText, useBoard, useDo } from '@/components/dealer/common/depth';

interface Issue { severity: 'BLOCK' | 'WARN'; code: string; message: string; ref?: string | null }
interface Section$ { key: string; label: string; required: boolean; present: boolean }
interface ContLine { line_no: number; description: string; category: string | null; scheduled_cents: number; previous_cents: number; this_period_cents: number; to_date_cents: number; balance_cents: number; pct_complete: number | null }
interface Data {
  draw: { id: string; job_id: string; draw_number: number; period_end: string | null; status: string; inspection_status: string | null; requested_cents: number | null; approved_cents: number | null };
  invoices: Array<{ id: string; vendor_id: string; invoice_number: string; invoice_on: string | null; amount_cents: number | null; retainage_cents: number | null; document_id: string | null; status: string; draw_budget_line_id: string | null; cost_code_id: string | null; commitment_id: string | null }>;
  waivers: Array<{ id: string; vendor_id: string; kind: string; compliance_doc_id: string; amount_cents: number | null; through_on: string | null }>;
  waiverDocs: Array<{ id: string; status: string; doc_type: string; document_id: string | null }>;
  envelopes: Array<{ id: string; on_completed_id: string; status: string; sent_at: string | null; completed_at: string | null }>;
  precheck: { ready: boolean; issues: Issue[] };
  package: { sections: Section$[]; continuation: ContLine[]; summary: Record<string, number | null> };
  template: { sections: Array<{ key: string; label: string; required: boolean }>; format_notes: string | null } | null;
}

/** One lender draw: invoices in, the pre-submission check, waivers tied to the payment, the package in the lender's read order. */
export function DrawView({ drawId, today, vendors }: { drawId: string; today: string; vendors: Array<{ id: string; name: string }> }) {
  const { readOnly } = useShell();
  const url = `/api/development/draws/${drawId}`;
  const b = useBoard<Data>(url);
  const { run, busy, error } = useDo(b.reload);
  const [inv, setInv] = useState({ vendor: '', number: '', amount: '', on: today, ret: '' });
  const [sign, setSign] = useState<Record<string, { doc: string; name: string; email: string }>>({});
  const vname = (id: string) => vendors.find((v) => v.id === id)?.name ?? 'Vendor';
  const state = <BoardState b={b} what="The draw" />;
  if (!b.data) return state;
  const d = b.data;
  const locked = !['DRAFT', 'RETURNED'].includes(d.draw.status);
  const blocks = d.precheck.issues.filter((i) => i.severity === 'BLOCK');
  const warns = d.precheck.issues.filter((i) => i.severity !== 'BLOCK');
  const cont = continuation(d.package.continuation.map((l) => ({ line_no: l.line_no, description: l.description, scheduled_cents: l.scheduled_cents, previous_cents: l.previous_cents, this_period_cents: l.this_period_cents })), Number(d.package.summary.retainage_pct ?? 0));
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {d.precheck.ready ? <InlineNotice tone="info" title="Ready for the lender.">Every required section is in and nothing blocks submission.</InlineNotice>
        : <InlineNotice tone="warn" title={`${count(blocks.length)} things block this draw.`}>Clear them before it goes to the lender; the out-of-balance block is enforced when the draw is submitted.</InlineNotice>}
      <Section title="Pre-submission check" meta={`Draw ${d.draw.draw_number} · ${d.draw.status.toLowerCase()}`}>
        <ul className="ops-checks">
          {blocks.map((i, n) => <li key={`b${n}`}><span className="no">Blocks</span> {i.message || issueWords(i.code)}</li>)}
          {warns.map((i, n) => <li key={`w${n}`}><span className="no">Check</span> {i.message || issueWords(i.code)}</li>)}
          {d.precheck.issues.length === 0 && <li><span className="ok">Done</span> Nothing open.</li>}
        </ul>
      </Section>
      <Section title="Invoices on this draw" meta={`${count(d.invoices.length)} invoices`} actions={!readOnly && !locked ? <ButtonRow>
        <Button disabled={busy === 'build'} onClick={() => void run('build', url, { op: 'build' }, (r: { lines_with_amounts: number; requested_cents: number }) => `Built the draw: ${r.lines_with_amounts} lender lines, ${money(r.requested_cents)}`)}>Build from approved invoices</Button>
        <Button disabled={busy === 'wv'} onClick={() => void run('wv', url, { op: 'request_waivers' }, (r: { requested: number }) => `Requested ${r.requested} waivers`)}>Request lien waivers</Button>
      </ButtonRow> : undefined}>
        {d.invoices.length > 0 && (
          <table className="ops-mini" aria-label="Draw invoices"><thead><tr><th>Vendor</th><th>Invoice</th><th className="n">Amount</th><th className="n">Retainage</th><th>File</th><th>Status</th><th /></tr></thead>
            <tbody>{d.invoices.map((x) => <tr key={x.id}><td>{vname(x.vendor_id)}</td><td>{x.invoice_number}<div className="t-cap">{day(x.invoice_on, today)}</div></td><td className="n">{x.amount_cents == null ? '—' : money(x.amount_cents)}</td><td className="n">{x.retainage_cents == null ? '—' : money(x.retainage_cents)}</td><td>{x.document_id ? 'Attached' : <span className="neg">Missing</span>}</td><td>{x.status.toLowerCase()}</td>
              <td>{!readOnly && x.status === 'PENDING' && <ButtonRow><Button disabled={busy === x.id} onClick={() => void run(x.id, url, { op: 'decide_invoice', invoiceId: x.id, approve: true }, (r: { status?: string; steps_left?: number }) => (r.status === 'APPROVED' ? 'Approved the invoice' : `Your step is approved — ${r.steps_left ?? 0} more to go`))}>Approve</Button><Button variant="quiet" disabled={busy === x.id} onClick={() => void run(x.id, url, { op: 'decide_invoice', invoiceId: x.id, approve: false }, 'Rejected the invoice')}>Reject</Button></ButtonRow>}</td></tr>)}</tbody></table>
        )}
        {!readOnly && !locked && (
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Vendor"><Select value={inv.vendor} onChange={(e) => setInv({ ...inv, vendor: e.target.value })}><option value="">Pick</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
            <Field label="Invoice #"><Input value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} style={{ width: 120 }} /></Field>
            <Field label="Amount"><Input inputMode="decimal" value={inv.amount} onChange={(e) => setInv({ ...inv, amount: e.target.value })} style={{ width: 120 }} /></Field>
            <Field label="Retainage"><Input inputMode="decimal" value={inv.ret} onChange={(e) => setInv({ ...inv, ret: e.target.value })} style={{ width: 110 }} /></Field>
            <Field label="Dated"><Input type="date" value={inv.on} onChange={(e) => setInv({ ...inv, on: e.target.value })} /></Field>
            <Button disabled={!inv.vendor || !inv.number.trim() || !(centsFrom(inv.amount) ?? 0) || busy === 'inv'} onClick={async () => { if (await run('inv', url, { op: 'add_invoice', vendorId: inv.vendor, invoiceNumber: inv.number.trim(), amountCents: centsFrom(inv.amount), retainageCents: centsFrom(inv.ret) ?? 0, invoiceOn: inv.on || null }, 'Added the invoice; someone else approves it')) setInv({ ...inv, number: '', amount: '', ret: '' }); }}>Add invoice</Button>
          </div>
        )}
      </Section>
      <Section title="Lien waivers" meta="Tied to this draw's payments; a missing conditional waiver holds the payment">
        {d.waivers.length === 0 ? <p className="t-cap">No waivers requested yet.</p> : (
          <table className="ops-mini" aria-label="Waivers"><thead><tr><th>Vendor</th><th>Waiver</th><th className="n">Amount</th><th>Status</th><th>Signature</th></tr></thead>
            <tbody>{d.waivers.map((w) => {
              const doc = d.waiverDocs.find((x) => x.id === w.compliance_doc_id);
              const env = d.envelopes.find((e) => e.on_completed_id === w.compliance_doc_id);
              const s = sign[w.id] ?? { doc: '', name: '', email: '' };
              return (
                <tr key={w.id}><td>{vname(w.vendor_id)}</td><td>{w.kind.toLowerCase().replace(/_/g, ' ')}{w.through_on ? <div className="t-cap">through {day(w.through_on, today)}</div> : null}</td><td className="n">{w.amount_cents == null ? '—' : money(w.amount_cents)}</td>
                  <td><Status kind={doc?.status === 'RECEIVED' || doc?.status === 'VERIFIED' ? 'ready' : 'blocked'} pip="open">{(doc?.status ?? 'missing').toLowerCase()}</Status></td>
                  <td>{env ? `${env.status}${env.completed_at ? ` · ${day(env.completed_at, today)}` : ''}` : readOnly || doc?.status === 'RECEIVED' ? '—' : (
                    <ButtonRow>
                      <Input aria-label="Waiver document id" value={s.doc} onChange={(e) => setSign({ ...sign, [w.id]: { ...s, doc: e.target.value } })} placeholder="Waiver file (document id)" style={{ width: 180 }} />
                      <Input aria-label="Signer name" value={s.name} onChange={(e) => setSign({ ...sign, [w.id]: { ...s, name: e.target.value } })} placeholder="Signer" style={{ width: 120 }} />
                      <Input aria-label="Signer email" value={s.email} onChange={(e) => setSign({ ...sign, [w.id]: { ...s, email: e.target.value } })} placeholder="Email" style={{ width: 160 }} />
                      <Button disabled={!/^[0-9a-f-]{36}$/i.test(s.doc) || !s.name.trim() || !s.email.includes('@') || busy === w.id} onClick={() => void run(w.id, url, { op: 'send_waiver', complianceDocId: w.compliance_doc_id, documentId: s.doc, signer: { name: s.name.trim(), email: s.email.trim() } }, 'Sent the waiver for signature')}>Send to sign</Button>
                    </ButtonRow>
                  )}</td></tr>
              );
            })}</tbody></table>
        )}
      </Section>
      <Section title="Package" meta="In the lender's read order">
        <ol className="ops-checks">{d.package.sections.map((s) => <li key={s.key}><span className={s.present ? 'ok' : 'no'}>{s.present ? 'In' : s.required ? 'Missing' : 'Optional'}</span> {s.label}</li>)}</ol>
        <table className="ops-mini" aria-label="Continuation sheet" style={{ marginTop: 12 }}>
          <thead><tr><th>Line</th><th>Description</th><th className="n">Scheduled</th><th className="n">Previous</th><th className="n">This period</th><th className="n">To date</th><th className="n">%</th><th className="n">Balance</th><th className="n">Retainage</th></tr></thead>
          <tbody>{cont.rows.map((r) => <tr key={r.line_no}><td>{r.line_no}</td><td>{r.description}</td><td className="n">{money(r.scheduled_cents)}</td><td className="n">{money(r.previous_cents)}</td><td className="n"><b>{money(r.this_period_cents)}</b></td><td className="n">{money(r.completed_cents)}</td><td className="n">{pctText(r.pct_complete, 0)}</td><td className="n">{money(r.balance_cents)}</td><td className="n">{money(r.retainage_cents)}</td></tr>)}</tbody>
          <tfoot><tr><td /><td>Total</td><td className="n">{money(cont.totals.scheduled_cents)}</td><td className="n">{money(cont.totals.previous_cents)}</td><td className="n"><b>{money(cont.totals.this_period_cents)}</b></td><td className="n">{money(cont.totals.completed_cents)}</td><td className="n">{pctText(cont.totals.pct_complete, 0)}</td><td className="n">{money(cont.totals.balance_cents)}</td><td className="n">{money(cont.totals.retainage_cents)}</td></tr></tfoot>
        </table>
        {d.package.summary.this_period_cents != null && cont.totals.this_period_cents !== d.package.summary.this_period_cents && <p className="t-cap neg">The continuation sheet does not tie to the summary ({money(d.package.summary.this_period_cents)}). Rebuild the draw.</p>}
        {!readOnly && <p className="t-cap" style={{ marginTop: 8 }}>The lender's section order is set per loan; ask the lender for their checklist and set it on the schedule.</p>}
      </Section>
    </div>
  );
}
