'use client';

/**
 * The selected document: what it is, where it went, and the person's decisions
 * (FPB-document-intelligence §8): open a proposal in its module, change the type, set the
 * company, link to an existing record, re-read, dismiss — plus view / download / delete.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  ButtonLink,
  ConfirmDialog,
  Conf,
  Field,
  InlineNotice,
  KV,
  Panel,
  PanelSection,
  Select,
  Status,
  Tag,
  api,
  money,
  toast,
} from '@meritbooks/merit-ui';
import { entityRecordHref, entityTypeLabel, formatBytes } from '@/lib/documents/schema';
import { DOC_CLASSES, DOC_CLASS_LABEL, TARGETS, type DocClass, type ProposalSummaryDto } from '@/lib/documents/intelligence/types';
import { openDocument, proposalHref } from '@/components/documents/intelligence-client';
import { LinkRecordDialog } from './link-record-dialog';
import { KEY_DATE_LABEL, fmtDate, fmtTime, statusOf, typeLabel, type AnalyzeResponse, type CenterRow, type LocationOption } from './documents-types';
import s from './documents.module.css';

export interface DocumentPanelProps {
  row: CenterRow;
  locations: LocationOption[];
  onClose: () => void;
  /** Something changed — refetch the list. */
  onChanged: () => void;
  onDeleted: () => void;
}

const PROPOSAL_WORD: Record<ProposalSummaryDto['status'], string> = {
  pending: 'Waiting for review',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
  superseded: 'Replaced',
  failed: 'Failed',
};

export function DocumentPanel({ row, locations, onClose, onChanged, onDeleted }: DocumentPanelProps) {
  const { doc, intel, proposals, links } = row;
  const [docClass, setDocClass] = useState<DocClass>(intel?.doc_class ?? 'other');
  const [locationId, setLocationId] = useState<string>(intel?.location_id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState<null | { proposal: ProposalSummaryDto | null; fixedType: string | null }>(null);
  const [confirm, setConfirm] = useState<null | 'dismiss' | 'delete'>(null);

  useEffect(() => {
    setDocClass(intel?.doc_class ?? 'other');
    setLocationId(intel?.location_id ?? '');
  }, [intel?.doc_class, intel?.location_id, doc.id]);

  const locName = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);
  const st = statusOf(row);
  const live = proposals.filter((p) => p.status !== 'superseded');

  const run = useCallback(
    async (key: string, fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => {
      setBusy(key);
      try {
        const r = await fn();
        if (r.ok) {
          if (r.message) toast(r.message);
          onChanged();
        } else toast.error(r.error ?? 'Something went wrong.');
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  const update = (body: Record<string, unknown>) => async () => {
    const r = await api.post<{ message?: string }>('/api/documents/intelligence/update', { document_id: doc.id, ...body });
    return r.error ? { ok: false, error: r.error.error } : { ok: true, message: r.data?.message };
  };

  const reread = () =>
    run('reread', async () => {
      const r = await api.post<AnalyzeResponse>('/api/documents/intelligence/analyze', { document_id: doc.id, force: true });
      return r.error ? { ok: false, error: r.error.error } : { ok: true, message: r.data?.message };
    });

  const decide = (p: ProposalSummaryDto, body: Record<string, unknown>) =>
    run(`p:${p.id}`, async () => {
      const r = await api.post<{ message?: string }>('/api/documents/proposals/decide', { proposal_id: p.id, ...body });
      return r.error ? { ok: false, error: r.error.error } : { ok: true, message: r.data?.message };
    });

  const unlinkOne = (id: string) =>
    run(`l:${id}`, async () => {
      const r = await api.post<{ ok: boolean }>('/api/documents/links', { link_id: id });
      return r.error ? { ok: false, error: r.error.error } : { ok: true, message: 'Link removed.' };
    });

  const remove = async () => {
    const r = await api.delete<{ ok: boolean }>(`/api/documents/${doc.id}`);
    if (r.error) {
      toast.error(r.error.error);
      return;
    }
    toast(`Deleted ${doc.file_name}.`);
    setConfirm(null);
    onDeleted();
  };

  const kv = [
    {
      term: 'Type',
      value: (
        <span className="row" style={{ gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
          <Tag tone={intel?.class_source === 'ai' ? 'ai' : 'default'}>{typeLabel(row)}</Tag>
          <span className="t-cap">{intel ? (intel.class_source === 'ai' ? 'AI' : intel.class_source === 'user' ? 'You' : 'Rules') : '—'}</span>
        </span>
      ),
    },
    ...(intel && intel.class_source !== 'user' ? [{ term: 'Confidence', value: <Conf score={Math.round(Number(intel.confidence) * 100)} /> }] : []),
    { term: 'Company', value: intel?.location_id ? (locName.get(intel.location_id) ?? 'Company') : 'Not set' },
    ...(intel?.counterparty ? [{ term: 'Other party', value: intel.counterparty }] : []),
    ...Object.entries(intel?.key_dates ?? {}).map(([k, v]) => ({ term: KEY_DATE_LABEL[k] ?? k, value: fmtDate(v) })),
    ...(intel?.amount_cents != null ? [{ term: 'Amount', value: money(intel.amount_cents) }] : []),
  ];

  const needsVendor = (p: ProposalSummaryDto) => (p.target_kind === 'vendor_w9' || p.target_kind === 'vendor_coi') && !p.native_id && p.status === 'pending';
  const needsCompany = (p: ProposalSummaryDto) => p.target_kind === 'bill' && !p.native_id && p.status === 'pending' && !intel?.location_id;

  return (
    <Panel
      aria-label={`Document ${doc.file_name}`}
      eyebrow={['Document', typeLabel(row)]}
      title={<span className={s.name}>{doc.file_name}</span>}
      meta={`${formatBytes(doc.size_bytes)} // uploaded ${fmtDate(doc.created_at)}`}
      onClose={onClose}
      foot={
        <span className="btn-row">
          <Button icon="eye" onClick={() => void openDocument(doc.id, 'view').then((e) => e && toast.error(e))}>
            View
          </Button>
          <Button icon="down" onClick={() => void openDocument(doc.id, 'download').then((e) => e && toast.error(e))}>
            Download
          </Button>
          <Button variant="danger" onClick={() => setConfirm('delete')}>
            Delete
          </Button>
        </span>
      }
    >
      <PanelSection title="What it is" meta={<Status kind={st.kind}>{st.word}</Status>}>
        {!intel ? (
          <InlineNotice title="Not analyzed yet.">
            {doc.entity_type && doc.entity_type !== 'location'
              ? `Filed by ${entityTypeLabel(doc.entity_type)} when it was uploaded there.`
              : 'Read it to find out what it is and where it belongs.'}
          </InlineNotice>
        ) : (
          <>
            <KV items={kv} />
            {intel.summary && <p className="t-body" style={{ marginTop: 8 }}>{intel.summary}</p>}
            {!intel.summary && intel.reason && <p className="t-cap" style={{ marginTop: 8 }}>{intel.reason}</p>}
            {intel.status === 'duplicate' && intel.duplicate_of && (
              <InlineNotice title="Same file as one already in Documents.">Nothing new was proposed for it.</InlineNotice>
            )}
            {intel.next_retry_at && (
              <p className="t-cap" style={{ marginTop: 8 }}>
                AI couldn’t read it yet ({intel.ai_status.replace('_', ' ')}). It will try again {fmtTime(intel.next_retry_at) ? `at ${fmtTime(intel.next_retry_at)}` : 'shortly'} — or pick the type below.
              </p>
            )}
          </>
        )}
        <div className="btn-row" style={{ marginTop: 10 }}>
          <Button icon="history" onClick={reread} disabled={busy !== null} aria-busy={busy === 'reread'}>
            {intel ? 'Read again' : 'Read it now'}
          </Button>
          {intel && intel.status !== 'dismissed' && (
            <Button variant="quiet" onClick={() => setConfirm('dismiss')} disabled={busy !== null}>
              Not something to file
            </Button>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Correct it">
        <div className={s.inline}>
          <Field label="Type">
            <Select value={docClass} onChange={(e) => setDocClass(e.target.value as DocClass)}>
              {DOC_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {DOC_CLASS_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={busy !== null || (intel?.doc_class === docClass && intel?.class_source === 'user')}
            aria-busy={busy === 'type'}
            onClick={() => run('type', update({ action: 'change_type', doc_class: docClass }))}
          >
            Set type
          </Button>
        </div>
        <div className={s.inline} style={{ marginTop: 8 }}>
          <Field label="Company">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Choose a company…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={busy !== null || !locationId || locationId === intel?.location_id || !intel}
            aria-busy={busy === 'company'}
            onClick={() => run('company', update({ action: 'set_company', location_id: locationId }))}
          >
            Set company
          </Button>
        </div>
      </PanelSection>

      <PanelSection title="Proposals" meta={live.length ? <span className="t-cap tnum">{live.length}</span> : undefined}>
        {live.length === 0 ? (
          <p className="t-cap">
            {intel?.status === 'routed' ? 'Filed — nothing for a module to set up.' : 'None yet. When we know what this is, the module it belongs to gets a proposal to review.'}
          </p>
        ) : (
          <ul className={s.list}>
            {live.map((p) => {
              const t = TARGETS[p.target_kind];
              return (
                <li key={p.id}>
                  <div style={{ minWidth: 0 }}>
                    <b className="t-body">{p.title ?? t.noun}</b>
                    <p className="t-cap" style={{ margin: '2px 0 0' }}>
                      {t.moduleLabel} // {PROPOSAL_WORD[p.status]}
                      {p.summary ? ` // ${p.summary}` : ''}
                    </p>
                    {p.status === 'pending' && p.last_error && <p className="t-cap" style={{ margin: '2px 0 0' }}>{p.last_error}</p>}
                  </div>
                  {p.status === 'pending' && (
                    <span className="btn-row">
                      <Button variant="quiet" disabled={busy !== null} onClick={() => decide(p, { action: 'dismiss' })}>
                        Dismiss
                      </Button>
                      {needsVendor(p) ? (
                        <Button variant="primary" onClick={() => setLinkOpen({ proposal: p, fixedType: 'vendor' })}>
                          Choose vendor
                        </Button>
                      ) : needsCompany(p) ? (
                        <span className="t-cap">Set the company above</span>
                      ) : p.mode === 'route' ? (
                        <ButtonLink href={proposalHref(p)} iconAfter="right">
                          Open {t.moduleLabel}
                        </ButtonLink>
                      ) : (
                        <ButtonLink variant="primary" href={proposalHref(p)} iconAfter="right">
                          {p.mode === 'native' ? `Open ${t.moduleLabel}` : `Review in ${t.moduleLabel}`}
                        </ButtonLink>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>

      <PanelSection title="Linked records">
        {links.length === 0 && !(doc.entity_type && doc.entity_id) ? (
          <p className="t-cap">Not linked to any record yet.</p>
        ) : (
          <ul className={s.list}>
            {links.map((l) => {
              const href = entityRecordHref(l.target_type, l.target_id);
              return (
                <li key={l.id}>
                  <span className="t-body">
                    {href ? <a href={href}>{l.label ?? entityTypeLabel(l.target_type)}</a> : l.label ?? entityTypeLabel(l.target_type)}
                    <span className="t-cap"> // {l.created_via === 'ai' ? 'from an AI proposal' : l.created_via === 'module' ? 'filed by the module' : 'linked by a person'}</span>
                  </span>
                  <Button variant="quiet" disabled={busy !== null} onClick={() => unlinkOne(l.id)}>
                    Unlink
                  </Button>
                </li>
              );
            })}
            {links.length === 0 && doc.entity_type && doc.entity_id && (
              <li>
                <span className="t-body">{entityTypeLabel(doc.entity_type)}</span>
                <span />
              </li>
            )}
          </ul>
        )}
        <div className="btn-row" style={{ marginTop: 8 }}>
          <Button icon="plus" onClick={() => setLinkOpen({ proposal: null, fixedType: null })}>
            Link to existing record
          </Button>
        </div>
      </PanelSection>

      <LinkRecordDialog
        open={!!linkOpen}
        onClose={() => setLinkOpen(null)}
        fixedType={linkOpen?.fixedType ?? null}
        defaultType={intel ? (TARGETS[(live[0]?.target_kind ?? 'filed')].recordType || null) : null}
        locationId={linkOpen?.fixedType === 'vendor' ? null : intel?.location_id ?? null}
        title={linkOpen?.fixedType === 'vendor' ? 'Which vendor is this for?' : undefined}
        onPick={async (type, id) => {
          const p = linkOpen?.proposal ?? null;
          if (p) await decide(p, { action: 'accept', target_type: type, target_id: id });
          else await run('link', update({ action: 'link', target_type: type, target_id: id }));
          setLinkOpen(null);
        }}
      />

      <ConfirmDialog
        open={confirm === 'dismiss'}
        onClose={() => setConfirm(null)}
        onConfirm={async (reason) => {
          await run('dismiss', update({ action: 'dismiss', note: reason }));
          setConfirm(null);
        }}
        title="Not something to file?"
        confirmLabel="Dismiss document"
        reason={{ label: 'Why (optional)', minLength: 0, placeholder: 'e.g. personal file, already entered' }}
      >
        <p className="t-body">The file stays in Documents. We stop proposing it to modules and stop retrying the AI read.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        onConfirm={remove}
        title={`Delete ${doc.file_name}?`}
        confirmLabel="Delete document"
        tone="danger"
      >
        <p className="t-body">This removes the stored file and its proposals and links. Records already created from it are not changed.</p>
      </ConfirmDialog>
    </Panel>
  );
}
