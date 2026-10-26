'use client';

/**
 * Cash-application building blocks, extracted so they can be reused across the merged
 * Banking & Cash screens:
 *   • <ApplyDepositsQueue /> — the AI deposit→invoice proposal queue, mounted as the
 *     "Apply deposits" tab of the Bank feed (was the standalone /cash-application page).
 *   • <TieOutCard /> — the AR subledger ↔ GL control tie-out, a section/tab on
 *     Reconciliation (moved off the standalone page).
 *
 * All logic rides the existing API routes (/api/cash-application/{proposals,apply,tie-out});
 * nothing here re-implements cash application. Presentation is merit-ui kit classes only.
 */

import { useId, useMemo, useState, type CSSProperties } from 'react';
import { Button, Check, Conf, Eyebrow, Icon, InlineNotice, Input, Status, Tag } from '@meritbooks/merit-ui';
import { formatMoney, dollarsToCents, centsToDollars } from '@meritbooks/shared';
import { EmptyState } from '@/components/ui';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';

// ── Types (mirror the API routes) ──────────────────────────────────────────────

interface InvoiceCandidate {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  balanceCents: number;
}

export interface Proposal {
  id: string;
  confidence: number | null;
  reasoning: string | null;
  title: string | null;
  kind: 'single' | 'sum_to_total';
  customerId: string | null;
  customerName: string;
  deposit: { id: string; date: string; amountCents: number; description: string | null; posted: boolean } | null;
  proposedInvoiceIds: string[];
  candidateInvoices: InvoiceCandidate[];
  createdAt: string;
}

interface ProposalsResponse {
  data: Proposal[];
  counts: { total: number };
}

interface TieOut {
  subledgerCents: number;
  glControlCents: number | null;
  varianceCents: number | null;
  tiesOut: boolean;
  arAccountNumber: string | null;
  note?: string;
  reconcilingItem?: { label: string; amountCents: number } | null;
  asOf: string;
}

interface ApplyResult {
  appliedCents: number;
  unappliedCents: number;
  invoiceIds: string[];
}

// Layout only — every visual value is a kit token.
const S = {
  surface: { border: '1px solid var(--line)', background: 'var(--white)' } as CSSProperties,
  pad: { padding: '16px 24px' } as CSSProperties,
  figs: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginTop: 16 } as CSSProperties,
  fig: { borderTop: '1px solid var(--line)', paddingTop: 12 } as CSSProperties,
  stack: { display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
  head: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0,1fr) auto',
    alignItems: 'center',
    gap: 16,
    width: '100%',
    minHeight: 64,
    padding: '8px 24px',
    border: 0,
    background: 'none',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  } as CSSProperties,
  headTop: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } as CSSProperties,
  headRight: { display: 'flex', alignItems: 'center', gap: 16 } as CSSProperties,
  body: { borderTop: '1px solid var(--line)', padding: '16px 24px 16px' } as CSSProperties,
  sum: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginTop: 16 } as CSSProperties,
  amt: { width: 136 } as CSSProperties,
  skel: { display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 24px' } as CSSProperties,
};

function ConfTag({ confidence }: { confidence: number }) {
  return <Conf score={Math.round(confidence * 100)} label={`AI confidence ${Math.round(confidence * 100)} of 100`} />;
}

// ── AR tie-out card ─────────────────────────────────────────────────────────────

export function TieOutCard() {
  const { data, isLoading, error, refetch } = useQuery<{ data: TieOut }>('/api/cash-application/tie-out');
  const tie = data?.data;

  return (
    <section style={{ ...S.surface, ...S.pad }} aria-label="AR tie-out">
      <Eyebrow>{['AR', 'Tie-out']}</Eyebrow>
      <h2 className="t-head" style={{ marginTop: 4 }}>AR subledger to GL control</h2>
      <p className="t-cap" style={{ marginTop: 4 }}>
        The sum of open invoice balances should equal the AR control account in the general ledger.
      </p>

      {isLoading ? (
        <div style={S.figs} aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} style={{ ...S.fig, ...S.stack }}>
              <span className="mb-skel" style={{ width: 96, height: 12 }} aria-hidden="true" />
              <span className="mb-skel" style={{ width: 128, height: 20 }} aria-hidden="true" />
            </div>
          ))}
          <span className="sr" role="status">Loading the tie-out</span>
        </div>
      ) : error ? (
        <div style={{ marginTop: 16 }}>
          <InlineNotice tone="neg" title="The tie-out didn't load.">
            {error}{' '}
            <button type="button" className="link" onClick={() => void refetch()}>
              Try again
            </button>
          </InlineNotice>
        </div>
      ) : !tie ? (
        <p className="t-cap" style={{ marginTop: 16 }}>No tie-out yet. It appears once invoices or AR postings exist.</p>
      ) : (
        <div style={S.figs}>
          <div className="fig" style={S.fig}>
            <span className="fig-l">AR subledger</span>
            <span className="fig-v fig-v--dense tnum">{formatMoney(tie.subledgerCents)}</span>
            <span className="fig-vs">Sum of open invoice balances</span>
          </div>
          <div className="fig" style={S.fig}>
            <span className="fig-l">GL control{tie.arAccountNumber ? ` · ${tie.arAccountNumber}` : ''}</span>
            <span className="fig-v fig-v--dense tnum">{tie.glControlCents === null ? '—' : formatMoney(tie.glControlCents)}</span>
            <span className="fig-vs">AR account balance in the GL</span>
          </div>
          <div className="fig" style={S.fig}>
            <span className="fig-l">Variance</span>
            <span className="fig-v fig-v--dense tnum">{tie.varianceCents === null ? '—' : formatMoney(tie.varianceCents)}</span>
            <span className="fig-vs">
              {tie.tiesOut ? (
                <Status kind="ready">Ties out · no reconciling items</Status>
              ) : (
                <Status kind="risk">{tie.note ?? tie.reconcilingItem?.label ?? 'Reconciling item'}</Status>
              )}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

// ── One proposal (approve / adjust / apply) ──────────────────────────────────────

interface LineState {
  selected: boolean;
  amountDollars: string;
}

export function ProposalCard({ proposal, onApplied }: { proposal: Proposal; onApplied: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [applying, setApplying] = useState(false);
  const [touched, setTouched] = useState(false);
  const bodyId = useId();

  const proposedSet = useMemo(() => new Set(proposal.proposedInvoiceIds), [proposal.proposedInvoiceIds]);

  const [lines, setLines] = useState<Record<string, LineState>>(() => {
    const init: Record<string, LineState> = {};
    for (const inv of proposal.candidateInvoices) {
      const selected = proposedSet.has(inv.id);
      init[inv.id] = { selected, amountDollars: selected ? String(centsToDollars(inv.balanceCents)) : '' };
    }
    return init;
  });

  const depositCents = proposal.deposit?.amountCents ?? 0;

  const appliedCents = useMemo(() => {
    let total = 0;
    for (const inv of proposal.candidateInvoices) {
      const st = lines[inv.id];
      if (st?.selected && st.amountDollars.trim() !== '') {
        const c = dollarsToCents(st.amountDollars);
        if (Number.isFinite(c) && c > 0) total += c;
      }
    }
    return total;
  }, [lines, proposal.candidateInvoices]);

  const remainderCents = depositCents - appliedCents;
  const overApplied = remainderCents < 0;

  function toggle(inv: InvoiceCandidate) {
    setTouched(true);
    setLines((prev) => {
      const cur = prev[inv.id] ?? { selected: false, amountDollars: '' };
      const nowSelected = !cur.selected;
      return {
        ...prev,
        [inv.id]: {
          selected: nowSelected,
          amountDollars: nowSelected && cur.amountDollars.trim() === '' ? String(centsToDollars(inv.balanceCents)) : cur.amountDollars,
        },
      };
    });
  }

  function setAmount(id: string, value: string) {
    setTouched(true);
    setLines((prev) => ({ ...prev, [id]: { selected: true, amountDollars: value } }));
  }

  async function apply() {
    const selected = proposal.candidateInvoices.filter((inv) => lines[inv.id]?.selected);
    if (selected.length === 0) {
      addToast('error', 'Select at least one invoice to apply.');
      return;
    }
    if (overApplied) {
      addToast('error', 'Applied total exceeds the deposit.');
      return;
    }

    setApplying(true);
    // Send explicit applications only when the human adjusted the proposal; otherwise
    // apply as proposed (server applies each proposed invoice at its full balance).
    const isDefault =
      !touched &&
      selected.length === proposal.proposedInvoiceIds.length &&
      selected.every((inv) => proposedSet.has(inv.id));

    const body = isDefault
      ? { proposal_id: proposal.id }
      : {
          proposal_id: proposal.id,
          applications: selected.map((inv) => ({
            invoice_id: inv.id,
            amount_cents: dollarsToCents(lines[inv.id].amountDollars || '0'),
          })),
        };

    const res = await api.post<{ data: ApplyResult }>('/api/cash-application/apply', body);
    setApplying(false);

    if (res.error) {
      addToast('error', res.error.error || 'Could not apply payment');
      return;
    }
    const applied = res.data?.data.appliedCents ?? appliedCents;
    addToast('success', `Applied ${formatMoney(applied)} — DR Cash / CR AR posted`);
    onApplied();
  }

  return (
    <article style={S.surface} aria-label={`Deposit from ${proposal.customerName}`}>
      <button type="button" style={S.head} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} aria-controls={bodyId}>
        <span style={{ minWidth: 0 }}>
          <span style={S.headTop}>
            <span className="l1">{proposal.customerName}</span>
            <Tag>{proposal.kind === 'single' ? 'Single invoice' : 'Lump remittance'}</Tag>
            {proposal.confidence !== null && <ConfTag confidence={proposal.confidence} />}
          </span>
          <span className="l2">
            {proposal.deposit ? `${proposal.deposit.date} · ` : ''}
            {proposal.reasoning ?? proposal.title ?? 'Proposed cash application'}
          </span>
        </span>
        <span style={S.headRight}>
          <span className="tnum" style={{ fontWeight: 600 }}>{formatMoney(depositCents)}</span>
          <Icon name={expanded ? 'down' : 'right'} />
        </span>
      </button>

      {expanded && (
        <div id={bodyId} style={S.body}>
          <div className="row" style={{ gap: 8 }}>
            <Tag tone="ai">AI proposal</Tag>
            <span className="t-cap">The AI picked the invoices marked Proposed. Change the selection or amounts if the match is wrong, then apply.</span>
          </div>

          {proposal.candidateInvoices.length === 0 ? (
            <p className="t-cap" style={{ marginTop: 16 }}>No open invoices remain for this customer.</p>
          ) : (
            <table className="tbl tbl-q tbl-q--compact tbl-q--flush" style={{ marginTop: 12 }} aria-label="Open invoices for this customer">
              <colgroup>
                <col style={{ width: 48 }} />
                <col />
                <col style={{ width: 160 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col"><span className="sr">Apply</span></th>
                  <th scope="col">Invoice</th>
                  <th scope="col" className="n">Apply amount</th>
                </tr>
              </thead>
              <tbody>
                {proposal.candidateInvoices.map((inv) => {
                  const st = lines[inv.id] ?? { selected: false, amountDollars: '' };
                  const isProposed = proposedSet.has(inv.id);
                  return (
                    <tr key={inv.id} className={['q-row', st.selected && 'is-selected'].filter(Boolean).join(' ')}>
                      <td>
                        <Check checked={st.selected} onChange={() => toggle(inv)} aria-label={`Apply to invoice ${inv.invoiceNumber}`} />
                      </td>
                      <td>
                        <span className="l1">
                          <span className="code">{inv.invoiceNumber}</span>
                          {isProposed && <Tag tone="ai">Proposed</Tag>}
                        </span>
                        <span className="l2 tnum">
                          Due {inv.dueDate} · balance {formatMoney(inv.balanceCents)}
                        </span>
                      </td>
                      <td className="n">
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          inputMode="decimal"
                          className="input--money"
                          style={S.amt}
                          disabled={!st.selected}
                          value={st.amountDollars}
                          onChange={(e) => setAmount(inv.id, e.target.value)}
                          aria-label={`Amount to apply to ${inv.invoiceNumber}, in dollars`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Applied / remainder summary */}
          <div style={S.sum}>
            <div className="row" style={{ gap: 16 }}>
              <span className="t-cap">
                Applied <b className="tnum">{formatMoney(appliedCents)}</b> of <span className="tnum">{formatMoney(depositCents)}</span>
              </span>
              {overApplied ? (
                <Status kind="overdue">Over by {formatMoney(-remainderCents)}</Status>
              ) : remainderCents > 0 ? (
                <Status kind="risk">{formatMoney(remainderCents)} left on account</Status>
              ) : (
                <Status kind="ready">Fully applied</Status>
              )}
            </div>
            <Button variant="primary" icon="check" disabled={applying || overApplied} aria-busy={applying || undefined} onClick={apply}>
              {applying ? 'Applying…' : 'Approve & apply'}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

// ── Deposit application queue (the "Apply deposits" tab body) ─────────────────────

export function ApplyDepositsQueue() {
  const { data, isLoading, error, refetch } = useQuery<ProposalsResponse>('/api/cash-application/proposals');
  const proposals = useMemo(() => data?.data ?? [], [data]);

  return (
    <div style={{ marginTop: 16 }}>
      <p className="t-cap">
        Match incoming deposits to open invoices, then approve to post the receipt (DR Cash / CR AR).
        {proposals.length > 0 && <span className="tnum"> {proposals.length} waiting.</span>}
      </p>

      <div style={{ ...S.stack, gap: 12, marginTop: 16 }}>
        {isLoading ? (
          <div style={S.surface} aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} style={{ ...S.skel, borderTop: i > 0 ? '1px solid var(--line)' : undefined }}>
                <span className="mb-skel" style={{ width: 200, height: 12 }} aria-hidden="true" />
                <span className="mb-skel" style={{ width: 320, height: 12 }} aria-hidden="true" />
              </div>
            ))}
            <span className="sr" role="status">Loading deposits</span>
          </div>
        ) : error ? (
          <InlineNotice tone="neg" title="Deposits didn't load.">
            {error}{' '}
            <button type="button" className="link" onClick={() => refetch()}>
              Try again
            </button>
          </InlineNotice>
        ) : proposals.length === 0 ? (
          <div style={S.surface}>
            <EmptyState
              title="No deposits waiting to be applied"
              description="When the AI matches an unapplied deposit to open invoices, it shows up here for your approval."
            />
          </div>
        ) : (
          proposals.map((p) => <ProposalCard key={p.id} proposal={p} onApplied={refetch} />)
        )}
      </div>
    </div>
  );
}
