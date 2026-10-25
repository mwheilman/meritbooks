'use client';

import { useState } from 'react';
import { Button, ButtonRow, Field, InlineNotice, Status, Textarea } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, useBoard, useDo } from '@/components/dealer/common/depth';

interface Gate { key: string; ok: boolean; required?: boolean; owner: string; detail?: string | null; short?: Array<{ key: string; description: string | null; short_qty: number }> }
interface Check { work_order_id: string; number: string; status: string; ready: boolean; gates: Gate[] }

const GATE_WORD: Record<string, string> = {
  drawings_approved: 'Shop drawings approved', bom_present: 'Bill of materials', operations_present: 'Routing on the order', selections_approved: 'Client selections approved',
  has_budget: 'Approved budget', deposit_received: 'Deposit paid (Merit Books)', material_ready: 'Material on hand or on order', cad_reconciled: 'CAD import applied',
};
const HARD = new Set(['drawings_approved', 'bom_present', 'operations_present', 'selections_approved', 'has_budget']);

/** Release to shop: every gate, who owns it, and an override with a reason for the soft ones. */
export function ReleaseView({ woId }: { woId: string }) {
  const { readOnly } = useShell();
  const b = useBoard<Check>(`/api/mfg/release/${woId}`);
  const { run, busy, error } = useDo(b.reload);
  const [reason, setReason] = useState('');
  const state = <BoardState b={b} what="The release check" />;
  if (!b.data) return state;
  const d = b.data;
  const failing = d.gates.filter((g) => !g.ok && g.required !== false);
  const hardFail = failing.some((g) => HARD.has(g.key));
  const released = ['RELEASED', 'IN_PROGRESS', 'COMPLETE', 'CLOSED'].includes(d.status);
  return (
    <div className="stack">
      {released ? <InlineNotice tone="info" title={`${d.number} is released.`}>It is on the shop floor.</InlineNotice>
        : d.ready ? <InlineNotice tone="info" title="Every gate passes.">Release it to the shop.</InlineNotice>
          : <InlineNotice tone="warn" title={`${failing.length} gate${failing.length === 1 ? '' : 's'} open.`}>{hardFail ? 'Close the hard gates first; they cannot be overridden.' : 'The open gates can be overridden with a reason by someone who holds job financials.'}</InlineNotice>}
      {error && <Failure text={error} />}
      <Section title="Gates" meta={d.number}>
        <ul className="ops-checks">
          {d.gates.map((g) => (
            <li key={g.key}>
              <span className={g.ok ? 'ok' : 'no'}>{g.ok ? 'Done' : g.required === false ? 'Off' : HARD.has(g.key) ? 'Blocks' : 'Open'}</span>{' '}
              <b>{GATE_WORD[g.key] ?? g.key.replace(/_/g, ' ')}</b> <span className="t-cap">· {g.owner}</span>
              {!g.ok && g.detail && <div className="t-cap">{g.detail}</div>}
              {!g.ok && g.short && g.short.length > 0 && <div className="t-cap">Short: {g.short.slice(0, 6).map((s) => `${s.description ?? s.key} (${s.short_qty})`).join(', ')}</div>}
            </li>
          ))}
        </ul>
      </Section>
      {!readOnly && !released && (
        <Section title="Release">
          {!d.ready && !hardFail && <Field label="Override reason" help="Recorded on the order. Needed for the open soft gates."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          <ButtonRow>
            <Button variant="primary" disabled={busy === 'rel' || hardFail || (!d.ready && reason.trim().length < 5)} onClick={() => void run('rel', `/api/mfg/release/${woId}`, { op: 'release', overrideReason: d.ready ? null : reason.trim() }, `Released ${d.number} to the shop`)}>{d.ready ? 'Release to shop' : 'Release with override'}</Button>
            <Button variant="quiet" disabled={busy === 'std'} onClick={() => void run('std', `/api/mfg/release/${woId}`, { op: 'restandard' }, (r: { operations: number }) => `Re-standarded ${r.operations} operations from the BOM`)}>Re-standard the routing</Button>
          </ButtonRow>
          <p className="t-cap" style={{ marginTop: 8 }}><Status kind="track" pip="open">Status</Status> {d.status.toLowerCase().replace(/_/g, ' ')}</p>
        </Section>
      )}
    </div>
  );
}
