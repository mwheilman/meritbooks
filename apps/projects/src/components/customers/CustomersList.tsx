'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Button, ButtonLink, Field, Keybar, ListPager, QueueTable, Search, Seg, Tag, WidgetState, count, shortDate, useDebounce, type QueueColumn,
} from '@meritbooks/merit-ui';
import { RELATIONSHIP_WORDS, type RelationshipStage } from '@/lib/crm/types';
import type { CustomerListRow } from '@/lib/crm/customers';
import { NewCustomerPanel } from './NewCustomerPanel';
import '@/components/crm/crm.css';

type StageFilter = 'all' | RelationshipStage;

export interface CustomersListProps {
  rows: CustomerListRow[];
  total: number;
  page: number;
  perPage: number;
  q: string;
  stage: StageFilter;
  stagesUnavailable: boolean;
  duplicates: number | null;
  canCreate: boolean;
  companies: ReadonlyArray<{ id: string; name: string }>;
  defaultCompanyId: string | null;
  showCompany: boolean;
  readOnly: boolean;
}

const STAGE_TONE: Readonly<Record<RelationshipStage, 'pos' | 'default' | 'warn'>> = { customer: 'pos', prospect: 'default', former: 'warn' };

/** The shared customer list (core.customers), searchable, by relationship stage. Every row opens the 360. */
export function CustomersList(p: CustomersListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(p.q);
  const dq = useDebounce(q, 300);
  const [adding, setAdding] = useState(false);

  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  useEffect(() => {
    if (dq !== p.q) go({ q: dq || null, page: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);

  const columns: QueueColumn<CustomerListRow>[] = [
    { id: 'name', header: 'Customer', cell: (c) => <><span className="l1">{c.name}</span><span className="l2">{[c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details'}</span></> },
    { id: 'stage', header: 'Relationship', width: 176, cell: (c) => (c.stage ? <><Tag tone={STAGE_TONE[c.stage]}>{RELATIONSHIP_WORDS[c.stage]}</Tag>{c.since ? <span className="l2">since {shortDate(c.since)}</span> : null}</> : <span className="l2">—</span>) },
    { id: 'city', header: 'City', width: 176, cell: (c) => <span className="l2">{c.city ?? '—'}</span> },
    ...(p.showCompany ? [{ id: 'co', header: 'Company', width: 176, cell: (c: CustomerListRow) => <span className="l2">{c.company ?? 'Shared'}</span> }] : []),
    { id: 'added', header: 'Added', width: 104, cell: (c) => <span className="l2">{shortDate(c.createdAt)}</span> },
  ];

  return (
    <div className="stack">
      <div className="crm-tools">
        <Field label="Search customers">
          <Search slashToFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, phone or city" aria-label="Search customers" />
        </Field>
        {!p.stagesUnavailable && (
          <Seg<StageFilter> aria-label="Relationship" value={p.stage} onChange={(v) => go({ stage: v === 'all' ? null : v, page: null })}
            items={[{ value: 'all', label: 'All' }, { value: 'prospect', label: 'Prospects' }, { value: 'customer', label: 'Customers' }, { value: 'former', label: 'Former' }]} />
        )}
        <span className="sp" />
        {p.duplicates != null && (
          <ButtonLink variant={p.duplicates ? 'default' : 'quiet'} href="/customers/duplicates">
            {p.duplicates ? `${count(p.duplicates)} possible duplicate${p.duplicates === 1 ? '' : 's'}` : 'Possible duplicates'}
          </ButtonLink>
        )}
        {p.canCreate && !p.readOnly && <Button variant="primary" chord="n" bindChord={!adding} onClick={() => setAdding(true)}>New customer</Button>}
      </div>
      <div className="mp-table">
        {p.rows.length === 0 ? (
          p.q || p.stage !== 'all' ? (
            <WidgetState state={{ kind: 'done', title: 'No customer matches', body: 'Try fewer letters, or another relationship.', action: <Button onClick={() => { setQ(''); go({ q: null, stage: null, page: null }); }}>Clear the search</Button> }} />
          ) : (
            <WidgetState state={{
              kind: 'empty', title: 'No customers yet',
              body: 'Customers are shared with Merit Books: one list for leads, jobs and invoices. Add one here, from a lead, or from a job.',
              action: p.canCreate && !p.readOnly ? <Button variant="primary" onClick={() => setAdding(true)}>New customer</Button> : undefined,
            }} />
          )
        ) : (
          <QueueTable aria-label="Customers" columns={columns} rows={p.rows} getRowId={(c) => c.id} openOnClick onOpen={(c) => router.push(`/customers/${c.id}`)} />
        )}
      </div>
      <ListPager page={p.page} perPage={p.perPage} total={p.total} onPage={(n) => go({ page: n > 1 ? String(n) : null })} noun="customers" />
      {p.rows.length > 0 && <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open' }, { chord: '/', label: 'search' }]} note="Shared with Merit Books" />}
      {p.canCreate && <NewCustomerPanel open={adding} onClose={() => setAdding(false)} companies={p.companies} defaultCompanyId={p.defaultCompanyId} />}
    </div>
  );
}
