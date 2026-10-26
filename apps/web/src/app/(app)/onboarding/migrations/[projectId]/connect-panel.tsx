'use client';

import { useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { Button, ButtonLink, InlineNotice, Tag } from '@meritbooks/merit-ui';
import { getSourceSystem, READ_ONLY_PROMISE } from '@/lib/onboarding/migration/catalog';
import { longDate } from '@/lib/onboarding/migration/format';
import type { WorkspaceData, WorkspaceSource } from '../_shared/dto';
import { uploadFile, useAction, when } from '../_shared/ui';
import s from '../migrations.module.css';

type Slot = WorkspaceSource['files'][number];

function DropSlot({ projectId, source, slot, onStaged }: { projectId: string; source: WorkspaceSource; slot: Slot; onStaged: () => void }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const send = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const r = await uploadFile<{ message?: string }>('/api/onboarding/migrations/files', { project_id: projectId, source_id: source.id, slot: slot.entity }, file);
    setBusy(false);
    if (r) onStaged();
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    void send(e.dataTransfer.files?.[0]);
  };
  const run = slot.run;
  return (
    <div className={s.slot}>
      <div className={s.between}>
        <b>{slot.label}</b>
        {slot.required ? <Tag tone={run ? 'pos' : 'warn'}>{run ? 'In' : 'Needed'}</Tag> : <Tag>{run ? 'In' : 'Optional'}</Tag>}
      </div>
      <span className={s.sub}>{slot.hint}</span>
      {run && (
        <div className={s.staged}>
          <span className={s.strong}>{run.label ?? run.file_name}</span>
          <span className={s.sub}>{run.file_name ? `${run.file_name} · ` : ''}{run.parser} · {when(run.created_at)}{run.as_of ? ` · as of ${longDate(run.as_of)}` : ''}</span>
          {run.warnings.length > 0 && <ul className={s.warnList}>{run.warnings.slice(0, 4).map((w, i) => <li key={i}>{w}</li>)}</ul>}
          <span className={s.sub}>Staged, not in your books.</span>
        </div>
      )}
      <label
        className={`${s.drop} ${over ? s.dropActive : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input ref={input} type="file" accept=".xlsx,.csv,.tsv,.txt" onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ''; }} aria-label={`Drop ${slot.label}`} />
        {busy ? 'Reading the file…' : run ? 'Drop a newer export to replace it' : 'Drop the file here, or choose it'}
      </label>
    </div>
  );
}

function SourceCard({ data, source, onChanged }: { data: WorkspaceData; source: WorkspaceSource; onChanged: () => void }) {
  const sys = getSourceSystem(source.systemId);
  const { busy, run } = useAction();
  const p = data.project;
  const isQbo = source.systemId === 'quickbooks';
  const returnTo = encodeURIComponent(`/onboarding/migrations/${p.id}?stage=connect`);
  return (
    <section className={s.source} aria-label={source.systemName}>
      <div className={s.head}>
        <h3>{source.systemName}</h3>
        <span className={s.muted}>{source.role.replace('_', ' ')}</span>
        <span className={s.grow} />
        {source.pulled ? <Tag tone="pos">Pulled</Tag> : source.missingRequired > 0 ? <Tag tone="warn">{source.missingRequired} file{source.missingRequired === 1 ? '' : 's'} missing</Tag> : <Tag>Planned</Tag>}
      </div>
      <div className={s.promise}>{READ_ONLY_PROMISE(source.systemName)} {sys?.ongoingFeed ? 'It stays connected after go-live for documents dated after the cutover.' : 'It’s a one-time source — archived at sign-off. MeritBooks becomes the book of record.'}</div>

      {isQbo && (
        <div className={s.padSm}>
          {data.qbo.configured && data.qbo.connected ? (
            <div className={s.between}>
              <span>Connected{data.qbo.companyName ? ` to “${data.qbo.companyName}”` : ''}. QuickBooks connects one company at a time — make sure it is this client’s file.</span>
              <Button variant="primary" disabled={!p.cutover_date || busy === 'pull'} onClick={async () => { const r = await run<{ message?: string; warnings?: string[] }>('pull', '/api/onboarding/migrations/project', { action: 'pull_qbo', id: p.id }); if (r) onChanged(); }}>
                {busy === 'pull' ? 'Pulling read-only…' : source.pulled ? 'Pull again' : 'Pull from QuickBooks'}
              </Button>
            </div>
          ) : data.qbo.configured ? (
            <div className={s.between}>
              <span>Sign in to QuickBooks read-only. The person who owns the QuickBooks login can do this step.</span>
              <ButtonLink variant="primary" href={`/api/integrations/erp/quickbooks/connect?returnTo=${returnTo}`}>Connect QuickBooks</ButtonLink>
            </div>
          ) : (
            <InlineNotice title="QuickBooks sign-in isn’t switched on for this workspace yet.">Export the reports below and drop them — it takes a few minutes and works the same.</InlineNotice>
          )}
          {!p.cutover_date && <p className={s.small}>Set the cutover date first — the trial balance is pulled as of that day.</p>}
        </div>
      )}
      {source.systemId === 'plaid' && (
        <div className={s.padSm}>
          <div className={s.between}>
            <span>Connect the client’s bank accounts in the bank feed; balances and transactions after the cutover flow in.</span>
            <ButtonLink href="/bank-feed">Open the bank feed</ButtonLink>
          </div>
        </div>
      )}
      {sys?.bridgeViaQuickBooks && (
        <p className={`${s.padSm} ${s.small} ${s.ink2}`}>This system already syncs into QuickBooks. Until a direct connection exists, its invoices can be read through the client’s QuickBooks — QuickBooks is a pipe here, not the books, and the bridge ends at go-live.</p>
      )}

      {sys && (source.path === 'recipe' || isQbo) && (
        <>
          <div className={s.head}>
            <h3>{isQbo && source.path === 'connect' ? 'Or export and drop' : sys.recipe.summary}</h3>
            <Tag>Recipe {sys.recipe.version}{sys.recipe.status === 'draft' ? ' · draft — confirm with the client’s admin' : ''}</Tag>
          </div>
          <ol className={s.steps}>
            {sys.recipe.steps.map((st, i) => <li key={i}><b>{st.title}</b>{st.detail}</li>)}
          </ol>
          <div className={s.slots}>
            {source.files.map((f) => <DropSlot key={f.key} projectId={p.id} source={source} slot={f} onStaged={onChanged} />)}
          </div>
          <p className={`${s.padSm} ${s.small} ${s.muted}`}>After go-live: {sys.recipe.afterGoLive}</p>
        </>
      )}
    </section>
  );
}

export function ConnectPanel({ data, onChanged }: { data: WorkspaceData; onChanged: () => void }) {
  if (data.sources.length === 0) {
    return (
      <div className={`${s.surface} ${s.state}`}>
        <h3 className="t-section">No systems named yet</h3>
        <p>Name the client’s ledger and any field system, bank or payroll in Gather info. Each one gets read-only sign-in or exact export steps.</p>
        <ButtonLink href={`/onboarding/migrations/${data.project.id}?stage=plan`} variant="primary">Name the systems</ButtonLink>
      </div>
    );
  }
  return (
    <div className={s.stack}>
      <p className={s.ink2}>Loans, leases, bank reconciliations and corporate documents go to <Link href="/documents">Documents</Link>, where they are read and routed automatically.</p>
      {data.sources.map((src) => <SourceCard key={src.id} data={data} source={src} onChanged={onChanged} />)}
    </div>
  );
}
