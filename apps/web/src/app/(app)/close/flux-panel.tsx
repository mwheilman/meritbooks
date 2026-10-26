'use client';

import { useState } from 'react';
import {
  AiPaused,
  Button,
  Field,
  InlineNotice,
  KV,
  Panel,
  PanelSection,
  Select,
  Tag,
  Textarea,
  api,
  money,
  toast,
} from '@meritbooks/merit-ui';
import { AttachmentsPanel } from '@/components/documents/attachments-panel';
import {
  BASIS_LABEL,
  CATEGORY_LABEL,
  EXPLANATION_CATEGORIES,
  type ExplanationCategory,
  type FluxBoard,
  type FluxBoardLine,
  type FluxExplanation,
} from '@/lib/close/flux/types';
import { STATUS, TAG_LABEL, pctText, shortDate, who } from './flux-format';
import s from './flux.module.css';

interface DraftResponse {
  draft?: { explanation: string; category: ExplanationCategory | null; citations: string[]; decisionId: string | null; model: string | null };
  unavailable?: boolean;
  message?: string;
  refused?: boolean;
  problems?: string[];
  summary: string;
}

interface GlDetail {
  data: { id: string; entryNumber: string; entryDate: string; entryMemo: string | null; lineMemo: string | null; debitCents: number; creditCents: number }[];
  pagination: { total: number };
}

type AiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'drafted'; citations: string[] }
  | { kind: 'paused'; summary: string; message: string }
  | { kind: 'refused'; summary: string; problems: string[] };

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

export interface FluxPanelProps {
  board: FluxBoard;
  line: FluxBoardLine | null;
  userId: string | null;
  canReview: boolean;
  onChanged: () => void;
}

/** The side panel: figures, drivers (drill to the JE), GL detail, the explanation editor with AI draft, and review. */
export function FluxPanel({ board, line, userId, canReview, onChanged }: FluxPanelProps) {
  const e: FluxExplanation | null = line?.explanation ?? null;
  const [text, setText] = useState(e?.explanation ?? '');
  const [category, setCategory] = useState<ExplanationCategory | ''>(e?.category ?? '');
  const [aiDecisionId, setAiDecisionId] = useState<string | null>(null);
  const [citations, setCitations] = useState<string[]>([]);
  const [carriedFromId, setCarriedFromId] = useState<string | null>(e?.carriedFromId ?? null);
  const [ai, setAi] = useState<AiState>(board.aiConfigured ? { kind: 'idle' } : { kind: 'paused', summary: '', message: 'AI is not configured.' });
  const [saving, setSaving] = useState<null | 'draft' | 'submit' | 'approve' | 'send_back'>(null);
  const [sendBackNote, setSendBackNote] = useState('');
  const [showSendBack, setShowSendBack] = useState(false);
  const [gl, setGl] = useState<GlDetail | null>(null);
  const [glLoading, setGlLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!line) {
    return (
      <Panel aria-label="Flux line">
        <div className={s.panelEmpty}>Select a line to see what moved it, write the explanation, and review it.</div>
      </Panel>
    );
  }

  const editable = board.editable;
  const st = STATUS[line.status];
  const basis = BASIS_LABEL[line.basisUsed];
  const periodArgs = { location_id: board.location.id, year: board.period.year, month: board.period.month, line_key: line.lineKey };
  const isPreparer = !!e?.preparedBy && e.preparedBy === userId;
  const driverSummaryText = ai.kind === 'paused' || ai.kind === 'refused' ? ai.summary : '';

  const draftWithAi = async () => {
    setAi({ kind: 'loading' });
    const res = await api.post<DraftResponse>('/api/close/flux/ai-draft', periodArgs);
    if (res.error || !res.data) {
      setAi({ kind: 'paused', summary: '', message: res.error?.error ?? 'AI is temporarily unavailable.' });
      return;
    }
    const d = res.data;
    if (d.draft) {
      setText(d.draft.explanation);
      if (d.draft.category) setCategory(d.draft.category);
      setAiDecisionId(d.draft.decisionId);
      setCitations(d.draft.citations);
      setAi({ kind: 'drafted', citations: d.draft.citations });
    } else if (d.refused) {
      setAi({ kind: 'refused', summary: d.summary, problems: d.problems ?? [] });
    } else {
      setAi({ kind: 'paused', summary: d.summary, message: d.message ?? 'AI is temporarily unavailable.' });
    }
  };

  const loadSummaryOnly = async () => {
    // AI not configured: the draft route still returns the deterministic driver summary.
    const res = await api.post<DraftResponse>('/api/close/flux/ai-draft', periodArgs);
    if (res.data?.summary) {
      setText(res.data.summary);
      setAi({ kind: 'paused', summary: res.data.summary, message: res.data.message ?? 'AI is not configured.' });
    } else toast.error(res.error?.error ?? 'Could not load the driver summary.');
  };

  const save = async (submit: boolean) => {
    setError(null);
    setSaving(submit ? 'submit' : 'draft');
    // AI provenance is decided server-side: we only name the draft we started from; the
    // server verifies it (this line, text derived from it) and sets drafted_by_ai / citations.
    const res = await api.post<{ explanation: FluxExplanation }>('/api/close/flux/explanations', {
      ...periodArgs,
      explanation: text,
      category: category || null,
      submit,
      ai_decision_id: aiDecisionId,
      carried_from_id: carriedFromId,
    });
    setSaving(null);
    if (res.error) { setError(res.error.error); return; }
    toast(submit ? 'Explanation submitted for review.' : 'Draft saved.');
    onChanged();
  };

  const review = async (action: 'approve' | 'send_back') => {
    if (!e) return;
    setError(null);
    setSaving(action);
    const res = await api.patch<{ explanation: FluxExplanation }>('/api/close/flux/explanations', {
      explanation_id: e.id,
      action,
      note: action === 'send_back' ? sendBackNote : null,
      // Pins the approval to the exact text shown here (server returns 409 STALE if it changed).
      explanation_hash: e.explanationHash,
    });
    setSaving(null);
    if (res.error) {
      setError(res.error.error);
      // The text or numbers moved under the reviewer — reload so they review what is there now.
      if (res.error.code === 'STALE' || res.error.code === 'CONFLICT') onChanged();
      return;
    }
    toast(action === 'approve' ? 'Reviewed.' : 'Sent back to the preparer.');
    onChanged();
  };

  const loadGl = async () => {
    setGlLoading(true);
    const res = await api.get<GlDetail>('/api/reports/gl-detail', {
      account_id: line.accountId,
      location_id: board.location.id,
      start_date: board.period.start,
      end_date: board.period.end,
      per_page: '100',
    });
    setGlLoading(false);
    if (res.error) { toast.error(res.error.error); return; }
    setGl(res.data);
  };

  const applySuggestion = () => {
    if (!line.suggestion) return;
    setText(line.suggestion.explanation);
    setCategory(line.suggestion.category);
    setCarriedFromId(line.suggestion.fromId);
    setAiDecisionId(null);
  };

  const showEditor = editable && (line.material || !!e) && e?.status !== 'REVIEWED';
  const foot =
    showEditor ? (
      <div className={s.row}>
        <Button variant="primary" onClick={() => void save(true)} disabled={!!saving || text.trim().length < 10 || !category}>
          {saving === 'submit' ? 'Submitting…' : e?.status === 'EXPLAINED' ? 'Resubmit' : 'Submit for review'}
        </Button>
        <Button onClick={() => void save(false)} disabled={!!saving}>{saving === 'draft' ? 'Saving…' : 'Save draft'}</Button>
      </div>
    ) : e?.status === 'EXPLAINED' && editable && canReview && !isPreparer ? (
      <div className={s.row}>
        <Button variant="primary" onClick={() => void review('approve')} disabled={!!saving || line.status === 'STALE'}>{saving === 'approve' ? 'Approving…' : 'Approve'}</Button>
        <Button onClick={() => setShowSendBack((v) => !v)} disabled={!!saving}>Send back</Button>
      </div>
    ) : null;

  return (
    <Panel
      aria-label={`Flux line ${line.accountNumber} ${line.accountName}`}
      eyebrow={['Flux', line.material ? st.word : 'Below threshold']}
      title={`${line.accountName}${line.dimensionLabel ? ` — ${line.dimensionLabel}` : ''}`}
      meta={`${line.accountNumber} · vs ${basis.toLowerCase()}${line.basisUsed !== board.policy.comparisonBasis ? ' (budget n/a for this line)' : ''}`}
      figure={money(line.changeCents)}
      foot={foot}
    >
      <PanelSection title="The change">
        <div className={s.figs}>
          <div className={s.fig}><span className={s.figL}>This month</span><span className={s.figV}>{money(line.currentCents)}</span></div>
          <div className={s.fig}><span className={s.figL}>{basis}</span><span className={s.figV}>{money(line.comparisonCents)}</span></div>
          <div className={s.fig}><span className={s.figL}>Change</span><span className={s.figV}>{pctText(line)}</span></div>
        </div>
        <p className="t-cap" style={{ marginTop: 8 }}>
          {line.threshold.excluded
            ? 'Excluded from flux review by the materiality policy.'
            : line.material
              ? `Material: ${line.breaches.map((b) => (b === 'ABS' ? `over ${money(line.threshold.absThresholdCents, { decimals: 0 })}` : `over ${(line.threshold.pctThresholdBps / 100).toFixed(1)}%`)).join(' and ')} (${line.threshold.source.toLowerCase()}).`
              : `Below the threshold (${line.threshold.source.toLowerCase()}).`}
          {line.statement === 'BS' ? ' Balance-sheet lines compare ending balances.' : ' P&L lines compare the month’s activity.'}
        </p>
      </PanelSection>

      <PanelSection title="What moved it" meta={<span className="t-cap">{line.drivers.lineCount} line{line.drivers.lineCount === 1 ? '' : 's'} this month</span>}>
        {line.drivers.lines.length === 0 ? (
          <p className={s.muted}>No posted lines this month{line.statement === 'BS' ? ' — the balance moved through an earlier month' : ''}.</p>
        ) : (
          <ol className={s.drivers}>
            {line.drivers.lines.map((d) => (
              <li key={d.glLineId} className={s.driver} style={citations.includes(d.ref) ? { background: 'var(--sky)' } : undefined}>
                <span className={s.ref}>{d.ref}</span>
                <span className={s.driverMain}>
                  <a href={`/journal-entries?id=${d.glEntryId}`}>{d.counterparty ?? d.memo ?? d.entryNumber ?? 'Journal entry'}</a>
                  <span className={s.driverSub}>{shortDate(d.entryDate)}{d.entryNumber ? ` · ${d.entryNumber}` : ''}{d.memo && d.counterparty ? ` · ${d.memo}` : ''}{d.sourceModule ? ` · ${d.sourceModule.toLowerCase().replace(/_/g, ' ')}` : ''}</span>
                  {d.tags.length > 0 && (
                    <span className={s.tags}>{d.tags.map((t) => <Tag key={t} tone={t === 'RECLASS' || t === 'ONE_OFF' ? 'warn' : 'default'}>{TAG_LABEL[t]}</Tag>)}</span>
                  )}
                </span>
                <span className={s.amt}>{money(d.amountCents)}</span>
              </li>
            ))}
          </ol>
        )}
        {line.drivers.counterparties.length > 0 && (
          <table className={s.cpTable} style={{ marginTop: 12 }}>
            <thead>
              <tr><th>By counterparty</th><th className={s.n}>{monthLabel(line.driverComparisonPeriod)}</th><th className={s.n}>{monthLabel(board.period.key)}</th><th className={s.n}>Change</th></tr>
            </thead>
            <tbody>
              {line.drivers.counterparties.map((c) => (
                <tr key={c.counterparty}>
                  <td>{c.counterparty}{c.isNew ? <> <Tag tone="ai">New</Tag></> : null}</td>
                  <td className={s.n}>{money(c.comparisonCents)}</td>
                  <td className={s.n}>{money(c.currentCents)}</td>
                  <td className={s.n}>{money(c.changeCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 8 }}>
          {gl ? (
            <>
              <span className="t-cap">{gl.pagination.total} GL line{gl.pagination.total === 1 ? '' : 's'} on {line.accountNumber} in {board.period.label}</span>
              <ul className={s.glList}>
                {gl.data.map((g) => (
                  <li key={g.id}><span>{shortDate(g.entryDate)} · {g.entryNumber} · {g.lineMemo ?? g.entryMemo ?? ''}</span><span className={s.amt}>{money(g.debitCents - g.creditCents)}</span></li>
                ))}
              </ul>
            </>
          ) : (
            <Button variant="quiet" onClick={() => void loadGl()} disabled={glLoading}>{glLoading ? 'Loading…' : 'Show all GL lines'}</Button>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Explanation" meta={e ? <span className="t-cap">{e.draftedByAi ? 'AI-assisted · ' : ''}{e.category ? CATEGORY_LABEL[e.category] : 'Draft'}</span> : null}>
        {error && <InlineNotice tone="neg" className={s.notice} title="That didn’t go through.">{error}</InlineNotice>}
        {line.status === 'STALE' && (
          <InlineNotice tone="warn" className={s.notice} title="The numbers moved since this was explained.">
            Explained at a change of {money(e?.changeCents ?? 0)}; it is now {money(line.changeCents)}. Update and resubmit — it no longer counts toward the close.
          </InlineNotice>
        )}
        {e?.reviewNote && e.status === 'DRAFT' && (
          <div className={`${s.review} ${s.reviewNeg}`}><b>Sent back by {who(board.names, e.reviewedBy, userId)}:</b> {e.reviewNote}</div>
        )}

        {e?.status === 'REVIEWED' || (!showEditor && e) ? (
          <div>
            <p style={{ margin: '0 0 8px' }}>{e.explanation ?? <span className={s.muted}>No text yet.</span>}</p>
            <KV items={[
              { term: 'Category', value: e.category ? CATEGORY_LABEL[e.category] : '—' },
              { term: 'Prepared', value: `${who(board.names, e.preparedBy, userId)} · ${shortDate(e.preparedAt)}` },
              { term: 'Reviewed', value: e.reviewedAt ? `${who(board.names, e.reviewedBy, userId)} · ${shortDate(e.reviewedAt)}` : 'Not yet' },
            ]} />
            {e.status === 'REVIEWED' && editable && (
              <p className="t-cap" style={{ marginTop: 8 }}>Reviewed explanations are locked. If the numbers move, this line reopens on its own.</p>
            )}
          </div>
        ) : !showEditor ? (
          <p className={s.muted}>{editable ? 'Below the materiality threshold — no explanation needed.' : 'No explanation was recorded.'}</p>
        ) : (
          <div className={s.editor}>
            {line.suggestion && !text && (
              <div className={s.suggest}>
                <span className="t-cap">{line.suggestion.reason} · {monthLabel(line.suggestion.periodKey)}</span>
                <p>{line.suggestion.explanation}</p>
                <Button variant="quiet" onClick={applySuggestion}>Use as a starting point</Button>
              </div>
            )}

            {ai.kind === 'idle' && (
              <div className={s.row} style={{ marginBottom: 12 }}>
                <Button onClick={() => void draftWithAi()}>Draft with AI</Button>
                <span className="t-cap">Drafts from the lines above and cites them. You edit and submit.</span>
              </div>
            )}
            {ai.kind === 'loading' && <p className="t-cap" aria-live="polite">Drafting from the driving lines…</p>}
            {ai.kind === 'drafted' && (
              <div className={s.row} style={{ marginBottom: 8 }}>
                <Tag tone="ai">AI draft</Tag>
                <span className="t-cap">Cites {ai.citations.join(', ') || 'no lines'} · every figure checked against the ledger. Edit before you submit.</span>
              </div>
            )}
            {ai.kind === 'paused' && (
              <div className={s.notice}>
                <AiPaused
                  title="AI assist paused"
                  action={
                    driverSummaryText
                      ? <Button variant="quiet" onClick={() => setText(driverSummaryText)}>Start from the driver summary</Button>
                      : <Button variant="quiet" onClick={() => void loadSummaryOnly()}>Start from the driver summary</Button>
                  }
                >
                  The drivers above still rank what moved this line. Write the explanation yourself.
                </AiPaused>
              </div>
            )}
            {ai.kind === 'refused' && (
              <InlineNotice tone="warn" className={s.notice} title="The AI draft didn’t tie to the ledger, so it was set aside.">
                {ai.problems[0] ?? ''} <Button variant="quiet" onClick={() => setText(ai.summary)}>Start from the driver summary</Button>
              </InlineNotice>
            )}

            <Field label="Category">
              <Select value={category} onChange={(ev) => setCategory((ev.target.value || '') as ExplanationCategory | '')}>
                <option value="">Choose…</option>
                {EXPLANATION_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </Select>
            </Field>
            <Field label="Why did it move?" help={`${text.trim().length} / 4000 · at least 10 characters to submit`}>
              <Textarea rows={5} value={text} maxLength={4000} onChange={(ev) => setText(ev.target.value)} placeholder="e.g. Annual insurance renewal billed in October; prepaid and amortizing from November." />
            </Field>
          </div>
        )}

        {e && e.status === 'EXPLAINED' && !showEditor && (
          <p className="t-cap" style={{ marginTop: 8 }}>
            {isPreparer ? 'You prepared this — a different person must review it.' : canReview ? 'Approve, or send it back with a note.' : 'Waiting for a reviewer.'}
          </p>
        )}
        {showSendBack && (
          <div style={{ marginTop: 12 }}>
            <Field label="What needs changing?">
              <Textarea rows={3} value={sendBackNote} onChange={(ev) => setSendBackNote(ev.target.value)} />
            </Field>
            <Button onClick={() => void review('send_back')} disabled={!!saving || sendBackNote.trim().length < 4}>{saving === 'send_back' ? 'Sending…' : 'Send back to preparer'}</Button>
          </div>
        )}
        {e?.status === 'REVIEWED' && editable && canReview && !isPreparer && (
          <div style={{ marginTop: 8 }}>
            {!showSendBack && <Button variant="quiet" onClick={() => setShowSendBack(true)}>Reopen (send back)</Button>}
          </div>
        )}
      </PanelSection>

      {e && (
        <PanelSection title="Support">
          <AttachmentsPanel entityType="FLUX_EXPLANATION" entityId={e.id} title="Supporting documents" />
        </PanelSection>
      )}
    </Panel>
  );
}
