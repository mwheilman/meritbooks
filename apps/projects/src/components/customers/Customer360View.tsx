'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button, ButtonLink, InlineNotice, Tag, WidgetState, count, money, shortDate } from '@meritbooks/merit-ui';
import type { Customer360, Section } from '@/lib/crm/customers';
import { agingBuckets, daysPastDue } from '@/lib/crm/c360';
import { CONTACT_ROLE_WORDS, contactName, siteAddress, type ContactRole, type ContactRow, type SiteRow } from '@/lib/crm/types';
import { ContactDrawer, SiteDrawer } from './ContactSiteForms';
import '@/components/crm/crm.css';

export interface Customer360Props {
  data: Customer360;
  today: string;
  canEdit: boolean;
  canCreate: boolean;
  canLeads: boolean;
  booksUrl: string | null;
  readOnly: boolean;
}

function Box({ title, meta, action, children, className }: { title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  const id = `c360-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section className={['crm-box', className].filter(Boolean).join(' ')} aria-labelledby={id}>
      <div className="crm-box-h"><h2 id={id}>{title}</h2>{meta != null && <span className="t-cap">{meta}</span>}<span className="sp" />{action}</div>
      <div className="crm-box-b">{children}</div>
    </section>
  );
}

function SectionBody<T>({ s, empty, children }: { s: Section<T[]>; empty: { title: string; body?: string; action?: ReactNode }; children: (v: T[]) => ReactNode }) {
  if (!s.ok) return <WidgetState state={{ kind: 'error', title: 'This part didn’t load', body: s.error }} />;
  if (!s.value.length) return <WidgetState state={{ kind: 'empty', ...empty }} />;
  return <>{children(s.value)}</>;
}

/**
 * The customer 360 (panel 06 BP-62..69): contacts, sites, leads, estimates, jobs, activity and
 * documents for everyone who can open the customer; Books money (AR, invoices, payments,
 * deposits) only with projects.contract_value — absent otherwise, never zeros.
 */
export function Customer360View({ data, today, canEdit, canCreate, canLeads, booksUrl, readOnly }: Customer360Props) {
  const [contact, setContact] = useState<ContactRow | null | 'new'>(null);
  const [site, setSite] = useState<SiteRow | null | 'new'>(null);
  const c = data.customer;
  const write = !readOnly;
  const m = data.money;

  return (
    <div className="stack">
      {data.duplicates ? (
        <InlineNotice tone="warn" title={`${count(data.duplicates)} possible duplicate${data.duplicates === 1 ? '' : 's'} of ${c.name}`}>
          Review them so Projects and Books keep one record. <Link className="link" href="/customers/duplicates">Review duplicates</Link>
        </InlineNotice>
      ) : null}

      <div className="c360">
        {m && (
          <Box title="Money from Merit Books" className="wide" meta={m.ok && m.value ? `Read live · last invoice ${m.value.lastInvoiceOn ? shortDate(m.value.lastInvoiceOn) : 'none'}` : undefined}
            action={booksUrl ? <ButtonLink variant="quiet" href={booksUrl}>Open in Merit Books</ButtonLink> : undefined}>
            {!m.ok ? (
              <WidgetState state={{ kind: 'error', title: 'Merit Books didn’t answer', body: m.error }} />
            ) : !m.value || (!m.value.invoices.length && !m.value.payments.length && !m.value.deposits.length && !m.value.lifetimeBilledCents) ? (
              <WidgetState state={{ kind: 'empty', title: 'Nothing billed yet', body: 'Invoices, payments and deposits appear here once Merit Books issues them for this customer.' }} />
            ) : (
              <BooksMoneyView m={m.value} today={today} />
            )}
          </Box>
        )}

        <Box title="Contacts" meta={data.contacts.ok ? count(data.contacts.value.length) : undefined}
          action={canCreate && write ? <Button variant="quiet" onClick={() => setContact('new')}>Add contact</Button> : undefined}>
          <SectionBody s={data.contacts} empty={{ title: 'No contacts yet', body: 'Add who signs, who pays and who lets the crew in.' }}>
            {(cs) => (
              <ul className="c360-list">
                {cs.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="itm" disabled={!canEdit || !write} onClick={() => setContact(p)}>
                      <span>
                        <span className="l1">{contactName(p)}{p.is_primary ? ' · primary' : ''}</span>
                        <span className="l2">{[p.title, ...(p.roles ?? []).map((r) => CONTACT_ROLE_WORDS[r as ContactRole] ?? r), p.can_sign ? 'signs' : null, p.can_pay ? 'pays' : null].filter(Boolean).join(' · ') || 'No role set'}</span>
                      </span>
                      <span className="n l2">{[p.phone, p.email].filter(Boolean).join(' · ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionBody>
        </Box>

        <Box title="Sites" meta={data.sites.ok ? count(data.sites.value.length) : undefined}
          action={canCreate && write ? <Button variant="quiet" onClick={() => setSite('new')}>Add site</Button> : undefined}>
          <SectionBody s={data.sites} empty={{ title: 'No sites yet', body: 'Add the service address; jobs, equipment and history attach to it.' }}>
            {(ss) => (
              <ul className="c360-list">
                {ss.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="itm" disabled={!canEdit || !write} onClick={() => setSite(s)}>
                      <span><span className="l1">{s.name || siteAddress(s) || 'Site'}</span><span className="l2">{s.name ? siteAddress(s) : s.access_notes ?? ''}</span></span>
                      <span className="n l2">{s.tax_jurisdiction ?? ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionBody>
        </Box>

        {canLeads && (
          <Box title="Leads" className="third" meta={data.leads.ok ? count(data.leads.value.length) : undefined}
            action={write ? <ButtonLink variant="quiet" href="/leads?new=1">New lead</ButtonLink> : undefined}>
            <SectionBody s={data.leads} empty={{ title: 'No leads', body: 'Repeat work and upsells open as leads on this customer.' }}>
              {(ls) => (
                <ul className="c360-list">
                  {ls.map((l) => (
                    <li key={l.id}><Link href={`/leads/${l.id}`}><span><span className="l1">{l.title}</span><span className="l2">{l.stage} · {shortDate(l.updatedAt)}</span></span><span className="n">{l.amountCents != null ? money(l.amountCents, { decimals: 0 }) : ''}</span></Link></li>
                  ))}
                </ul>
              )}
            </SectionBody>
          </Box>
        )}

        <Box title="Estimates" className="third" meta={data.estimates.ok ? count(data.estimates.value.length) : undefined}>
          <SectionBody s={data.estimates} empty={{ title: 'No estimates', body: 'Estimates priced on this customer’s jobs appear here.' }}>
            {(es) => (
              <ul className="c360-list">
                {es.map((e) => (
                  <li key={e.id}><Link href={`/jobs/${e.jobId}?tab=estimates`}><span><span className="l1">{e.number} v{e.version} · {e.title}</span><span className="l2">{e.status.toLowerCase()} · {shortDate(e.date)}</span></span><span className="n">{e.totalCents != null ? money(e.totalCents, { decimals: 0 }) : ''}</span></Link></li>
                ))}
              </ul>
            )}
          </SectionBody>
        </Box>

        <Box title="Jobs" className="third" meta={data.jobs.ok ? count(data.jobs.value.length) : undefined}>
          <SectionBody s={data.jobs} empty={{ title: 'No jobs yet', body: 'Jobs for this customer appear here, active first.' }}>
            {(js) => (
              <ul className="c360-list">
                {js.map((j) => (
                  <li key={j.id}><Link href={`/jobs/${j.id}`}><span><span className="l1">{j.label}</span><span className="l2">{j.stage}</span></span><span className="n">{j.contractCents != null ? money(j.contractCents, { decimals: 0 }) : ''}</span></Link></li>
                ))}
              </ul>
            )}
          </SectionBody>
        </Box>

        <Box title="Activity" meta={data.activity.ok ? count(data.activity.value.length) : undefined}>
          <SectionBody s={data.activity} empty={{ title: 'Nothing logged yet', body: 'Calls, texts, emails, visits and notes on this customer and its leads appear here.' }}>
            {(as) => (
              <ol className="crm-tl">
                {as.slice(0, 30).map((a) => (
                  <li key={a.id}>
                    <span className="when">{shortDate(a.at)}</span>
                    <span className="what">
                      <span className="k">{a.word}</span>
                      {a.leadId ? <Link className="s link" href={`/leads/${a.leadId}`}>{a.subject ?? 'On a lead'}</Link> : a.subject && <span className="s">{a.subject}</span>}
                      {a.body && <span className="b">{a.body.length > 240 ? `${a.body.slice(0, 240)}…` : a.body}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </SectionBody>
        </Box>

        <Box title="Documents" meta={data.documents.ok ? count(data.documents.value.length) : undefined}>
          <SectionBody s={data.documents} empty={{ title: 'No documents', body: 'Contracts, signed change orders and photos on this customer’s jobs appear here.' }}>
            {(ds) => (
              <ul className="c360-list">
                {ds.map((d) => (
                  <li key={d.id}>
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer"><span><span className="l1">{d.name}</span><span className="l2">{[d.type?.toLowerCase(), shortDate(d.at)].filter(Boolean).join(' · ')}</span></span><span className="n l2">Open</span></a>
                    ) : (
                      <span className="itm"><span><span className="l1">{d.name}</span><span className="l2">{shortDate(d.at)}</span></span><span /></span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SectionBody>
        </Box>
      </div>

      <ContactDrawer open={contact !== null} onClose={() => setContact(null)} customerId={c.id} contact={contact === 'new' ? null : contact} />
      <SiteDrawer open={site !== null} onClose={() => setSite(null)} customerId={c.id} site={site === 'new' ? null : site} companyId={c.companyId} />
    </div>
  );
}

function BooksMoneyView({ m, today }: { m: NonNullable<Extract<NonNullable<Customer360['money']>, { ok: true }>['value']>; today: string }) {
  const open = m.invoices.filter((i) => (i.balanceCents ?? 0) > 0);
  const buckets = agingBuckets(m.invoices, today);
  const total = buckets.reduce((s, b) => s + b.cents, 0);
  const fig = (label: string, v: number | null, sub: string) => (
    <div className="fig">
      <span className="fig-l">{label}</span>
      <span className="fig-v fig-v--dense tnum">{v != null ? money(v) : '—'}</span>
      <span className="fig-vs">{sub}</span>
    </div>
  );
  return (
    <div className="stack">
      <div className="grid-12" style={{ rowGap: 16 }}>
        <div style={{ gridColumn: 'span 3' }}>{fig('Open AR', m.openArCents, `${count(open.length)} open invoices`)}</div>
        <div style={{ gridColumn: 'span 3' }}>{fig('Past due', m.overdueArCents, m.lastPaymentOn ? `Last paid ${shortDate(m.lastPaymentOn)}` : 'No payments yet')}</div>
        <div style={{ gridColumn: 'span 3' }}>{fig('Deposits held', m.depositsHeldCents, `${count(m.deposits.length)} deposits`)}</div>
        <div style={{ gridColumn: 'span 3' }}>{fig('Billed to date', m.lifetimeBilledCents, `${count(m.invoices.length)} invoices`)}</div>
      </div>
      {total > 0 && (
        <table className="crm-mini" aria-label="AR aging">
          <thead><tr>{buckets.map((b) => <th key={b.label} className="n">{b.label}</th>)}<th className="n">Total</th></tr></thead>
          <tbody><tr>{buckets.map((b) => <td key={b.label} className="n">{money(b.cents)}</td>)}<td className="n b">{money(total)}</td></tr></tbody>
        </table>
      )}
      <div className="grid-12" style={{ columnGap: 24 }}>
        <div style={{ gridColumn: 'span 6' }}>
          <h3 className="t-cap" style={{ marginBottom: 6 }}>Invoices</h3>
          {m.invoices.length === 0 ? <p className="t-cap">None issued.</p> : (
            <table className="crm-mini">
              <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th className="n">Total</th><th className="n">Balance</th></tr></thead>
              <tbody>
                {m.invoices.slice(0, 12).map((i) => {
                  const late = daysPastDue(i, today);
                  return (
                    <tr key={i.id}>
                      <td>{i.number ?? '—'}</td>
                      <td>{i.date ? shortDate(i.date) : '—'}</td>
                      <td>{late ? <Tag tone="neg">{count(late)}d past due</Tag> : (i.status ?? '').toLowerCase().replace(/_/g, ' ')}</td>
                      <td className="n">{i.totalCents != null ? money(i.totalCents) : '—'}</td>
                      <td className="n">{i.balanceCents != null ? money(i.balanceCents) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ gridColumn: 'span 3' }}>
          <h3 className="t-cap" style={{ marginBottom: 6 }}>Payments</h3>
          {m.payments.length === 0 ? <p className="t-cap">None received.</p> : (
            <table className="crm-mini">
              <thead><tr><th>Date</th><th>Method</th><th className="n">Amount</th></tr></thead>
              <tbody>{m.payments.slice(0, 10).map((p) => <tr key={p.id}><td>{p.date ? shortDate(p.date) : '—'}</td><td>{p.method ?? '—'}</td><td className="n">{p.amountCents != null ? money(p.amountCents) : '—'}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div style={{ gridColumn: 'span 3' }}>
          <h3 className="t-cap" style={{ marginBottom: 6 }}>Deposits</h3>
          {m.deposits.length === 0 ? <p className="t-cap">None held.</p> : (
            <table className="crm-mini">
              <thead><tr><th>Date</th><th className="n">Held</th><th className="n">Applied</th></tr></thead>
              <tbody>{m.deposits.slice(0, 10).map((d) => <tr key={d.id}><td>{d.date ? shortDate(d.date) : '—'}</td><td className="n">{d.amountCents != null ? money(d.amountCents) : '—'}</td><td className="n">{d.appliedCents != null ? money(d.appliedCents) : '—'}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
