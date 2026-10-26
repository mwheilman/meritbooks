'use client';

import { useState, useCallback } from 'react';
import { Button, ConfirmDialog, InlineNotice, Status, Tag, type StatusKind } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { PageHeader, EmptyState, TableSkeleton } from '@/components/ui';
import { formatMoney } from '@meritbooks/shared';
import { RecurringJeBuilder, type ExistingTemplate } from './recurring-je-builder';
import s from './recurring.module.css';

// ─── Types (mirror the store's TemplateSummary / ProposedRunDetail) ─────────

interface TemplateRow {
  id: string;
  name: string;
  location_id: string;
  cadence: 'MONTHLY' | 'QUARTERLY';
  start_date: string;
  end_date: string | null;
  entry_type: string;
  memo: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  line_count: number;
  amount_per_period_cents: number;
  periods_generated: number;
  last_period: string | null;
  next_period: string | null;
  next_post_date: string | null;
  pending_count: number;
  lines: ExistingTemplate['lines'];
}
interface TemplatesResponse {
  data: TemplateRow[];
  summary: { total: number; active: number; pending: number };
}

interface ProposedRun {
  id: string;
  template_id: string;
  template_name: string;
  period: string;
  entry_date: string;
  amount_cents: number;
  lines: { account_id: string; debit_cents: number; credit_cents: number }[];
}
interface RunsResponse {
  data: ProposedRun[];
  summary: { total: number; amount_cents: number };
}

const CADENCE_LABEL: Record<string, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly' };

// Pip shape + word (never colour alone).
const STATUS_STYLE: Record<string, { label: string; kind: StatusKind; pip?: 'closed' | 'soft' }> = {
  ACTIVE: { label: 'Active', kind: 'ready' },
  PAUSED: { label: 'Paused', kind: 'track', pip: 'soft' },
  COMPLETED: { label: 'Completed', kind: 'track', pip: 'closed' },
  CANCELLED: { label: 'Cancelled', kind: 'blocked' },
};

type PendingConfirm =
  | { kind: 'cancel'; template: TemplateRow }
  | { kind: 'skip'; run: ProposedRun };

export function RecurringJeView() {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const {
    data: tData,
    isLoading: tLoading,
    error: tError,
  } = useQuery<TemplatesResponse>('/api/recurring-journal-entries', undefined, { key: String(refreshKey) });
  const {
    data: rData,
    isLoading: rLoading,
    error: rError,
  } = useQuery<RunsResponse>('/api/recurring-journal-entries/runs', undefined, { key: String(refreshKey) });

  const templates = tData?.data ?? [];
  const runs = rData?.data ?? [];
  const summary = tData?.summary;

  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<ExistingTemplate | null>(null);
  const [generating, setGenerating] = useState(false);
  const [busyRun, setBusyRun] = useState<string | null>(null);
  const [busyTemplate, setBusyTemplate] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);

  const openNew = () => { setEditing(null); setBuilderOpen(true); };
  const openEdit = (t: TemplateRow) => {
    setEditing({
      id: t.id, name: t.name, location_id: t.location_id, cadence: t.cadence,
      start_date: t.start_date, end_date: t.end_date, entry_type: t.entry_type,
      memo: t.memo, lines: t.lines,
    });
    setBuilderOpen(true);
  };

  async function generateDue() {
    setGenerating(true);
    const res = await api.post<{ result: { proposed: unknown[]; skipped_existing: number; errors: unknown[] } }>(
      '/api/recurring-journal-entries/generate',
      {},
    );
    setGenerating(false);
    if (res.error) { addToast('error', res.error.error || 'Generate failed'); return; }
    const r = res.data?.result;
    const proposed = r?.proposed.length ?? 0;
    if (proposed === 0) addToast('info', 'No new entries due — everything is already proposed or posted');
    else addToast('success', `Proposed ${proposed} entr${proposed === 1 ? 'y' : 'ies'} for review`);
    if ((r?.errors.length ?? 0) > 0) addToast('error', `${r?.errors.length} template(s) had issues`);
    bump();
  }

  async function setStatus(t: TemplateRow, status: 'ACTIVE' | 'PAUSED') {
    setBusyTemplate(t.id);
    const res = await api.patch(`/api/recurring-journal-entries/${t.id}`, { status });
    setBusyTemplate(null);
    if (res.error) { addToast('error', res.error.error || 'Update failed'); return; }
    addToast('success', status === 'PAUSED' ? 'Template paused' : 'Template resumed');
    bump();
  }

  // Confirmed in a kit dialog (was a browser confirm()).
  async function cancelTemplate(t: TemplateRow) {
    setBusyTemplate(t.id);
    const res = await api.delete(`/api/recurring-journal-entries/${t.id}`);
    setBusyTemplate(null);
    if (res.error) { addToast('error', res.error.error || 'Cancel failed'); return; }
    addToast('success', 'Template cancelled');
    bump();
  }

  async function reviewRun(run: ProposedRun, action: 'approve' | 'reject') {
    setBusyRun(run.id);
    const res = await api.post<{ entry_number?: string }>('/api/recurring-journal-entries/approve', {
      run_id: run.id, action,
    });
    setBusyRun(null);
    if (res.error) { addToast('error', res.error.error || 'Action failed'); return; }
    if (action === 'approve') addToast('success', `Posted ${res.data?.entry_number ?? 'entry'} to the GL`);
    else addToast('info', 'Entry skipped');
    bump();
  }

  const errorAll = tError && rError;

  return (
    <div className={s.stack}>
      <PageHeader
        title="Recurring journal entries"
        description={
          summary
            ? `${summary.active} active · ${summary.total} template${summary.total === 1 ? '' : 's'} · ${runs.length} awaiting approval`
            : 'Scheduled entries that post a balanced journal each period'
        }
        actions={
          <>
            <Button icon="calendar" onClick={generateDue} disabled={generating} aria-busy={generating || undefined}>
              {generating ? 'Generating…' : 'Generate due'}
            </Button>
            <Button variant="primary" icon="plus" onClick={openNew}>
              New template
            </Button>
          </>
        }
      />

      {errorAll && (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Couldn&apos;t load recurring entries.</p>
          <p className="ink-2">{tError || rError}</p>
          <Button onClick={bump}>Try again</Button>
        </div>
      )}

      {/* ── Review & post queue ─────────────────────────────────────────── */}
      {rError && !errorAll && (
        <InlineNotice tone="neg" title="The approval queue didn't load.">
          {rError} <Button variant="quiet" onClick={bump}>Try again</Button>
        </InlineNotice>
      )}
      {!rLoading && runs.length > 0 && (
        <section className={`${s.section} ${s.sectionAttn}`} aria-label="Awaiting approval">
          <div className={s.sectionHead}>
            <div className={s.sectionTitle}>
              <h2>Awaiting approval</h2>
              <span className="t-cap tnum">
                {runs.length} entr{runs.length === 1 ? 'y' : 'ies'} · {formatMoney(rData?.summary.amount_cents ?? 0)}
              </span>
            </div>
            <Status kind="risk">Needs review</Status>
          </div>
          <div className={s.scroll}>
            <table className="tbl tbl-q tbl-q--compact">
              <colgroup>
                <col />
                <col style={{ width: 112 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 144 }} />
                <col style={{ width: 232 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Template</th>
                  <th scope="col">Period</th>
                  <th scope="col">Post date</th>
                  <th scope="col" className="n">Lines</th>
                  <th scope="col" className="n">Amount</th>
                  <th scope="col" className="n">Review</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="q-row">
                    <td><span className="l1">{run.template_name}</span></td>
                    <td className="tnum">{run.period}</td>
                    <td className="tnum ink-2">{run.entry_date}</td>
                    <td className="n ink-2">{run.lines.length}</td>
                    <td className="n">{formatMoney(run.amount_cents)}</td>
                    <td className="n">
                      <span className="mb-row-acts">
                        <Button
                          variant="quiet"
                          onClick={() => setConfirming({ kind: 'skip', run })}
                          disabled={busyRun === run.id}
                        >
                          Skip
                        </Button>
                        <Button
                          variant="primary"
                          icon="check"
                          onClick={() => reviewRun(run, 'approve')}
                          disabled={busyRun === run.id}
                          aria-busy={busyRun === run.id || undefined}
                        >
                          {busyRun === run.id ? 'Posting…' : 'Approve & post'}
                        </Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Templates ───────────────────────────────────────────────────── */}
      {tLoading ? (
        <TableSkeleton rows={4} cols={7} />
      ) : tError && !errorAll ? (
        <div className={s.state} role="alert">
          <Tag tone="neg">Not loaded</Tag>
          <p className="t-head">Templates didn&apos;t load.</p>
          <p className="ink-2">{tError}</p>
          <Button onClick={bump}>Try again</Button>
        </div>
      ) : templates.length === 0 && !tError ? (
        <EmptyState
          title="No recurring journal entries yet"
          description="Create a template for a fixed accrual (rent, insurance, depreciation) or a straight-line allocation across departments. Each period generates a balanced entry you approve before it posts."
          action={{ label: 'New template', onClick: openNew }}
        />
      ) : templates.length > 0 ? (
        <section className={s.section} aria-label="Templates">
          <div className={s.scroll}>
            <table className="tbl tbl-q">
              <colgroup>
                <col />
                <col style={{ width: 112 }} />
                <col style={{ width: 144 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 128 }} />
                <col style={{ width: 248 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Template</th>
                  <th scope="col">Cadence</th>
                  <th scope="col" className="n">Per period</th>
                  <th scope="col" className="n">Lines</th>
                  <th scope="col">Next run</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="n">Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => {
                  const st = STATUS_STYLE[t.status] ?? STATUS_STYLE.ACTIVE;
                  const busy = busyTemplate === t.id;
                  return (
                    <tr key={t.id} className="q-row">
                      <td>
                        <div className={s.cellRow}>
                          <span className="l1">{t.name}</span>
                          {t.pending_count > 0 && (
                            <Tag tone="warn"><span className="tnum">{t.pending_count}</span> pending</Tag>
                          )}
                        </div>
                        {t.memo && <span className="l2">{t.memo}</span>}
                      </td>
                      <td className="ink-2">{CADENCE_LABEL[t.cadence] ?? t.cadence}</td>
                      <td className="n">{formatMoney(t.amount_per_period_cents)}</td>
                      <td className="n ink-2">{t.line_count}</td>
                      <td className="tnum">{t.next_post_date ?? <span className="ink-3">—</span>}</td>
                      <td><Status kind={st.kind} pip={st.pip}>{st.label}</Status></td>
                      <td className="n">
                        {(t.status === 'ACTIVE' || t.status === 'PAUSED') && (
                          <span className="mb-row-acts">
                            <Button variant="quiet" onClick={() => openEdit(t)} disabled={busy}>Edit</Button>
                            {t.status === 'ACTIVE' ? (
                              <Button variant="quiet" onClick={() => setStatus(t, 'PAUSED')} disabled={busy}>Pause</Button>
                            ) : (
                              <Button variant="quiet" onClick={() => setStatus(t, 'ACTIVE')} disabled={busy}>Resume</Button>
                            )}
                            <Button variant="quiet" onClick={() => setConfirming({ kind: 'cancel', template: t })} disabled={busy} aria-busy={busy || undefined}>
                              {busy ? 'Working…' : 'Cancel'}
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── How it works ────────────────────────────────────────────────── */}
      {templates.length > 0 && (
        <InlineNotice title="How it works." className={s.how}>
          Generate due stages a balanced entry for each period that has come due → it lands in Awaiting approval → you
          review it and Approve &amp; post it to the GL. Nothing posts automatically.
        </InlineNotice>
      )}

      <ConfirmDialog
        open={confirming?.kind === 'cancel'}
        onClose={() => setConfirming(null)}
        onConfirm={async () => { if (confirming?.kind === 'cancel') await cancelTemplate(confirming.template); }}
        title={confirming?.kind === 'cancel' ? `Cancel "${confirming.template.name}"?` : 'Cancel template?'}
        confirmLabel="Cancel template"
        cancelLabel="Keep it"
        tone="danger"
      >
        Posted periods stay; no future entries will be proposed.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming?.kind === 'skip'}
        onClose={() => setConfirming(null)}
        onConfirm={async () => { if (confirming?.kind === 'skip') await reviewRun(confirming.run, 'reject'); }}
        title={confirming?.kind === 'skip' ? `Skip the ${confirming.run.period} entry?` : 'Skip entry?'}
        confirmLabel="Skip entry"
        cancelLabel="Keep it"
        tone="danger"
      >
        {confirming?.kind === 'skip' ? `"${confirming.run.template_name}" for ${confirming.run.period} won't be re-proposed.` : null}
      </ConfirmDialog>

      {builderOpen && (
        <RecurringJeBuilder
          existing={editing}
          onClose={() => setBuilderOpen(false)}
          onSaved={() => { setBuilderOpen(false); bump(); }}
        />
      )}
    </div>
  );
}
