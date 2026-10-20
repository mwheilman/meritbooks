'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Bands, Keybar, Panel, PanelSection, QueueTable, Status, Tag, WidgetState, count, money, shortDate, type QueueColumn,
} from '@meritbooks/merit-ui';
import type { ComplianceDocRow } from '@/lib/pm/money/types';
import { COMPLIANCE_DOC_LABELS, complianceMark } from '@/lib/pm/money/status';
import { useVocab } from '@/components/shell/ShellContext';
import { lower } from '@/lib/pm/vocab';
import { MarkStatus, m } from './common';

export interface VendorCommitment { id: string; number: string; jobId: string; jobLabel: string; status: string; committed: number; open: number; billed: number; held: boolean }
export interface VendorRowView {
  id: string;
  name: string;
  commitments: VendorCommitment[];
  docs: Array<ComplianceDocRow & { jobLabel: string; commitmentNumber: string | null }>;
}

type Band = 'attention' | 'expiring' | 'current';

export function SubcontractorsView({ vendors, today }: { vendors: VendorRowView[]; today: string }) {
  const v = useVocab();
  const status = (r: VendorRowView) => {
    const marks = r.docs.map((d) => ({ d, mk: complianceMark(d, today) }));
    return {
      lapsed: marks.filter((x) => x.d.required && !x.mk.ok),
      soon: marks.filter((x) => x.mk.expiringSoon).sort((a, b) => (a.d.expires_on ?? '').localeCompare(b.d.expires_on ?? '')),
      none: r.docs.length === 0,
    };
  };
  const bandOf = (r: VendorRowView): Band => { const s = status(r); return s.lapsed.length || s.none ? 'attention' : s.soon.length ? 'expiring' : 'current'; };
  const by = (b: Band) => vendors.filter((r) => bandOf(r) === b);
  const [band, setBand] = useState<Band>(by('attention').length ? 'attention' : by('expiring').length ? 'expiring' : 'current');
  const [cursorId, setCursorId] = useState<string | null>(null);
  const visible = by(band);
  const cursor = vendors.find((r) => r.id === cursorId) ?? null;

  const columns: QueueColumn<VendorRowView>[] = [
    { id: 'name', header: 'Vendor', cell: (r) => <><span className="l1">{r.name}</span><span className="l2">{count(r.commitments.filter((c) => c.status === 'APPROVED' || c.status === 'EXECUTED').length)} active · {[...new Set(r.commitments.map((c) => c.jobLabel))].slice(0, 2).join(', ')}</span></> },
    { id: 'com', header: 'Committed', numeric: true, width: 128, cell: (r) => m(r.commitments.reduce((s, c) => s + c.committed, 0)) },
    { id: 'open', header: 'Open', numeric: true, width: 120, cell: (r) => m(r.commitments.reduce((s, c) => s + c.open, 0)) },
    { id: 'bil', header: 'Billed', numeric: true, width: 120, cell: (r) => m(r.commitments.reduce((s, c) => s + c.billed, 0)) },
    {
      id: 'cmp', header: 'Compliance', width: 240, cell: (r) => {
        const s = status(r);
        if (s.none) return <Status kind="blocked" pip="open">No documents on file</Status>;
        if (s.lapsed.length) return <Status kind="overdue" pip="overdue">{count(s.lapsed.length)} not current</Status>;
        if (s.soon.length) return <Status kind="risk" pip="risk">{COMPLIANCE_DOC_LABELS[s.soon[0]!.d.doc_type]} expires {shortDate(s.soon[0]!.d.expires_on!)}</Status>;
        return <Status kind="ready" pip="ready">All current</Status>;
      },
    },
    { id: 'hold', header: 'Holds', numeric: true, width: 72, cell: (r) => { const n = r.commitments.filter((c) => c.held).length; return n ? <span className="neg b">{count(n)}</span> : '—'; } },
  ];

  if (vendors.length === 0) {
    return <div className="surface"><WidgetState state={{ kind: 'empty', title: `No ${lower(v.subcontractors)} with ${lower(v.commitments)} yet`, body: `Vendors appear here once a purchase order or subcontract is drafted for them, with their certificates of insurance and lien waivers.`, action: <Link className="link" href="/commitments">Open {lower(v.commitments)}</Link> }} /></div>;
  }

  return (
    <div className="stack">
      <div style={{ maxWidth: 840 }}>
        <Bands<Band> aria-label="Vendors by compliance" value={band} onChange={(b) => { setBand(b); setCursorId(null); }} items={[
          { value: 'attention', label: 'Needs documents', count: count(by('attention').length), caption: 'Missing, unverified or expired: payment is held' },
          { value: 'expiring', label: 'Expiring in 30 days', count: count(by('expiring').length), caption: 'Ask for renewals now' },
          { value: 'current', label: 'Current', count: count(by('current').length), caption: 'Every required document verified' },
        ]} />
      </div>
      <div className={cursor ? 'mp-split has-panel' : 'mp-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {visible.length === 0 ? (
            <WidgetState state={{ kind: 'done', title: band === 'attention' ? 'Every vendor’s documents are current' : band === 'expiring' ? 'Nothing expires in the next 30 days' : 'No vendor is fully current yet', body: 'Switch the band above to see the others.' }} />
          ) : (
            <QueueTable aria-label={`${v.subcontractors} and compliance`} columns={columns} rows={visible} getRowId={(r) => r.id} cursorId={cursorId}
              onCursorChange={(id) => setCursorId(id)} onOpen={(r) => setCursorId(r.id)} rowState={(r) => ({ attn: bandOf(r) === 'attention' })} />
          )}
        </div>
        {cursor && (
          <Panel eyebrow={[v.subcontractor, `${count(cursor.commitments.length)} ${lower(v.commitments)}`]} title={cursor.name} meta={`${money(cursor.commitments.reduce((s, c) => s + c.open, 0))} open`} onClose={() => setCursorId(null)}>
            <PanelSection title="Documents">
              {cursor.docs.length === 0 ? <p className="t-cap">Nothing on file. Add the certificate of insurance on a commitment’s Compliance tab.</p> : (
                <ul className="stack" style={{ listStyle: 'none', gap: 10 }}>
                  {cursor.docs.map((d) => (
                    <li key={d.id}>
                      <div className="row row--between"><span className="l1">{COMPLIANCE_DOC_LABELS[d.doc_type]}</span><MarkStatus mark={complianceMark(d, today)} /></div>
                      <span className="l2">{[d.jobLabel, d.commitmentNumber, d.expires_on ? `expires ${shortDate(d.expires_on)}` : null, d.required ? null : 'not required'].filter(Boolean).join(' · ')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelSection>
            <PanelSection title={v.commitments}>
              <ul className="stack" style={{ listStyle: 'none', gap: 10 }}>
                {cursor.commitments.map((c) => (
                  <li key={c.id}>
                    <Link className="nlink" href={`/jobs/${c.jobId}?tab=commitments`}><span className="code">{c.number}</span> · {c.jobLabel}</Link>
                    <span className="l2">{m(c.committed)} committed · {m(c.open)} open{c.held ? ' · ' : ''}{c.held && <Tag tone="neg">Payment held</Tag>}</span>
                  </li>
                ))}
              </ul>
            </PanelSection>
          </Panel>
        )}
      </div>
      {visible.length > 0 && <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }]} note="A required document that lapses holds payment in Merit Books until it is verified" />}
    </div>
  );
}
