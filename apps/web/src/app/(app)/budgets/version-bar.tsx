'use client';

/**
 * Version picker + lifecycle actions (Wave 4B, AC-B9 / AC-B10 / AC-B11): pick a version, see its
 * status and whether it's the published budget, create a new one, and submit / return / approve /
 * lock / delete according to the caller's access.
 */
import { useState } from 'react';
import { Button, ConfirmDialog, Dialog, Field, Input, InlineNotice, Select, Tag, api, longDate, toast } from '@meritbooks/merit-ui';
import { VERSION_STATUS_LABEL, type BudgetVersion, type VersionKind } from '@/lib/budgets/types';
import { MONTH_LABELS, errText, versionTone } from './budget-format';
import { useBudgetScope } from './budget-scope';
import s from './budgets.module.css';

type Start = 'BLANK' | 'COPY' | 'PRIOR_YEAR_ACTUALS' | 'PRIOR_BUDGET' | 'REFORECAST';
type Action = 'submit' | 'return' | 'approve' | 'lock' | 'delete';

const START_LABEL: Record<Start, string> = {
  BLANK: 'Blank',
  COPY: 'Copy the selected version',
  PRIOR_YEAR_ACTUALS: 'Last year’s actuals + growth %',
  PRIOR_BUDGET: 'Last year’s budget + growth %',
  REFORECAST: 'Reforecast: actuals through a month, budget after',
};

export function versionOptionLabel(v: BudgetVersion): string {
  return `${v.label} · ${VERSION_STATUS_LABEL[v.status]}${v.isCurrent ? ' · published' : ''}`;
}

export function VersionBar() {
  const sc = useBudgetScope();
  const v = sc.version;
  const a = sc.access;
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);

  const finance = !!a && a.scope === 'ALL' && a.canEdit;
  const run = async (action: Action, note?: string) => {
    if (!v) return;
    const res = await api.post<{ version: BudgetVersion | null }>('/api/budgets/versions/transition', { version_id: v.id, action, note: note ?? null });
    if (res.error) {
      toast.error(errText(res.error));
      return;
    }
    toast(
      action === 'delete' ? `Deleted ${v.label}` : action === 'approve' ? `Approved ${v.label} · now the published budget` : `${v.label} ${action === 'submit' ? 'submitted for approval' : action === 'return' ? 'returned to draft' : 'locked'}`,
    );
    if (action === 'delete') sc.setVersionId(null);
    await sc.refetch();
  };

  if (!sc.locationId) return null;
  if (sc.loading && !v) return <div className={s.versions} aria-busy="true"><span className={s.muted}>Loading versions…</span></div>;
  if (sc.error) return <InlineNotice tone="neg" title="Couldn’t load budget versions" className={s.notice}>{sc.error}</InlineNotice>;

  return (
    <>
      <div className={s.versions} role="group" aria-label="Budget version">
        {sc.versions.length > 0 ? (
          <Field label="Version">
            <Select value={sc.versionId ?? ''} onChange={(e) => sc.setVersionId(e.target.value || null)}>
              {sc.versions.map((x) => (
                <option key={x.id} value={x.id}>{versionOptionLabel(x)}</option>
              ))}
            </Select>
          </Field>
        ) : (
          <span className={s.muted}>No budget versions for FY {sc.fiscalYear} yet.</span>
        )}
        {v && (
          <>
            <Tag tone={versionTone(v.status)}>{VERSION_STATUS_LABEL[v.status]}</Tag>
            {v.isCurrent && <span className={s.published} title="This version is the budget every report reads">● Published</span>}
            <span className={s.versionMeta}>
              {v.kind === 'REFORECAST' ? 'Reforecast' : 'Budget'} v{v.versionNumber}
              {v.dueDate ? ` · due ${longDate(v.dueDate)}` : ''}
              {v.approvedAt ? ` · approved ${longDate(v.approvedAt)}` : v.submittedAt && v.status === 'IN_REVIEW' ? ` · submitted ${longDate(v.submittedAt)}` : ''}
            </span>
          </>
        )}
        <span className={s.grow} />
        {v && finance && v.status === 'DRAFT' && <Button onClick={() => setPending('submit')}>Submit for approval</Button>}
        {v && a?.canApprove && v.status === 'IN_REVIEW' && !!v.submittedBy && v.submittedBy !== a.userId && (
          <Button variant="primary" onClick={() => setPending('approve')}>Approve</Button>
        )}
        {v && (a?.canApprove || finance) && v.status === 'IN_REVIEW' && <Button onClick={() => setPending('return')}>Return to draft</Button>}
        {v && a?.canApprove && a.scope === 'ALL' && v.status === 'APPROVED' && v.isCurrent && <Button onClick={() => setPending('lock')}>Lock</Button>}
        {v && finance && v.status === 'DRAFT' && !v.isCurrent && <Button variant="quiet" onClick={() => setPending('delete')}>Delete draft</Button>}
        {finance && (
          <Button variant={sc.versions.length === 0 ? 'primary' : 'default'} icon="plus" onClick={() => setCreating(true)}>
            New version
          </Button>
        )}
      </div>
      {v?.status === 'DRAFT' && v.returnedNote && (
        <InlineNotice tone="warn" title="Returned for changes" className={s.notice}>{v.returnedNote}</InlineNotice>
      )}
      {v && a?.canApprove && v.status === 'IN_REVIEW' && v.submittedBy === a.userId && (
        <InlineNotice tone="info" className={s.notice}>You submitted this version, so someone else has to approve it.</InlineNotice>
      )}

      <NewVersionDialog open={creating} onClose={() => setCreating(false)} />

      <ConfirmDialog
        open={pending === 'submit' || pending === 'approve' || pending === 'lock'}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          const act = pending;
          setPending(null);
          if (act) await run(act);
        }}
        title={pending === 'approve' ? `Approve ${v?.label ?? ''}?` : pending === 'lock' ? `Lock ${v?.label ?? ''}?` : `Submit ${v?.label ?? ''} for approval?`}
        confirmLabel={pending === 'approve' ? 'Approve and publish' : pending === 'lock' ? 'Lock the budget' : 'Submit for approval'}
      >
        {pending === 'approve' && <p>It becomes the published budget for FY {v?.fiscalYear}. The version it replaces is marked superseded. Its lines can’t change afterwards — changes go into a new version.</p>}
        {pending === 'lock' && <p>A locked budget is the budget of record for the year: it can’t be replaced by another budget version. Changes go into reforecasts.</p>}
        {pending === 'submit' && <p>The lines freeze while it is in review. Every department must already be approved.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={pending === 'return'}
        onClose={() => setPending(null)}
        onConfirm={async (reason) => {
          setPending(null);
          await run('return', reason);
        }}
        title={`Return ${v?.label ?? ''} to draft`}
        confirmLabel="Return to draft"
        reason={{ label: 'What needs to change', minLength: 3, placeholder: 'Trim travel in Sales; Service headcount starts in April' }}
      />
      <ConfirmDialog
        open={pending === 'delete'}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          setPending(null);
          await run('delete');
        }}
        tone="danger"
        title={`Delete ${v?.label ?? ''}?`}
        confirmLabel="Delete draft"
      >
        <p>The draft’s lines, drivers and department plans are removed. The audit trail keeps a record that it existed.</p>
      </ConfirmDialog>
    </>
  );
}

function NewVersionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sc = useBudgetScope();
  const [kind, setKind] = useState<VersionKind>('BUDGET');
  const [start, setStart] = useState<Start>(sc.versions.length ? 'COPY' : 'PRIOR_YEAR_ACTUALS');
  const [label, setLabel] = useState('');
  const [growth, setGrowth] = useState('0');
  const [closed, setClosed] = useState(String(Math.max(0, new Date().getMonth())));
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const starts: Start[] = kind === 'REFORECAST' ? ['REFORECAST', 'COPY', 'BLANK'] : ['BLANK', 'COPY', 'PRIOR_YEAR_ACTUALS', 'PRIOR_BUDGET'];
  const growthBps = Math.round(Number(growth || '0') * 100);
  const needsGrowth = start === 'PRIOR_YEAR_ACTUALS' || start === 'PRIOR_BUDGET' || start === 'COPY';

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await api.post<{ version: BudgetVersion }>('/api/budgets/versions', {
      location_id: sc.locationId,
      fiscal_year: sc.fiscalYear,
      kind,
      start,
      label: label.trim() || null,
      source_version_id: start === 'COPY' ? sc.versionId : null,
      growth_bps: needsGrowth && Number.isFinite(growthBps) ? growthBps : null,
      due_date: due || null,
      closed_through: start === 'REFORECAST' ? parseInt(closed, 10) : null,
    });
    setBusy(false);
    if (res.error || !res.data) {
      setError(errText(res.error));
      return;
    }
    toast(`Created ${res.data.version.label}`);
    onClose();
    await sc.refetch();
    sc.setVersionId(res.data.version.id);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`New FY ${sc.fiscalYear} version`}
      dismissOnScrim={false}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || (start === 'COPY' && !sc.versionId) || !Number.isFinite(growthBps)}>
            {busy ? 'Creating…' : 'Create version'}
          </Button>
        </>
      }
      footNote="A new version starts as a draft. Approving it later replaces the published budget."
    >
      {error && <InlineNotice tone="neg" className={s.notice}>{error}</InlineNotice>}
      <div className={s.formGrid}>
        <Field label="Kind">
          <Select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as VersionKind;
              setKind(k);
              setStart(k === 'REFORECAST' ? 'REFORECAST' : 'COPY');
            }}
          >
            <option value="BUDGET">Budget</option>
            <option value="REFORECAST">Reforecast</option>
          </Select>
        </Field>
        <Field label="Start from">
          <Select value={start} onChange={(e) => setStart(e.target.value as Start)}>
            {starts.map((x) => (
              <option key={x} value={x} disabled={x === 'COPY' && !sc.versionId}>{START_LABEL[x]}</option>
            ))}
          </Select>
        </Field>
        {needsGrowth && (
          <Field label="Growth %" help="Applied to every line, keeping the month shape.">
            <Input inputMode="decimal" value={growth} onChange={(e) => setGrowth(e.target.value)} />
          </Field>
        )}
        {start === 'REFORECAST' && (
          <Field label="Actuals through" help="Closed months take actuals; the rest keep the budget.">
            <Select value={closed} onChange={(e) => setClosed(e.target.value)}>
              <option value="0">No months (copy the budget)</option>
              {MONTH_LABELS.map((m, i) => (
                <option key={m} value={String(i + 1)}>{m} {sc.fiscalYear}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Name (optional)" help="Defaults to “FY Budget vN”.">
          <Input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Departments due (optional)">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
