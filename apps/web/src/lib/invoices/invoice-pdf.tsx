import React from 'react';
import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';
import type { InvoiceDoc } from './invoice-doc';

/**
 * Branded invoice PDF (FPB §3) with selectable visual styles. Tenants choose a
 * style + accent color + logo at setup (invoice_templates.style); this renderer
 * honors all three. Light-themed white documents — a counterparty expects a
 * white invoice. Deterministic (built-in fonts only, no network fetch): same
 * invoice + style + accent renders identical bytes. Totals tie to the GL.
 *
 *   MODERN   — contemporary, Helvetica, accent header band, filled balance block
 *   CLASSIC  — formal, Times serif, centered masthead under a double rule
 *   MINIMAL  — technical, Courier figures, hairline rules, maximal whitespace
 *
 * Retainage only renders when actually withheld (retainage_cents > 0), which the
 * data layer now only does when the governing customer/job has retainage enabled.
 */

export type InvoiceStyle = 'MODERN' | 'CLASSIC' | 'MINIMAL' | 'BOLD' | 'COMPACT';

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const fmtAddress = (a: Record<string, unknown> | null): string[] => {
  if (!a) return [];
  const out: string[] = [];
  for (const k of ['line1', 'line2', 'city_state_zip', 'city', 'state', 'zip', 'country']) if (a[k]) out.push(String(a[k]));
  return out;
};

interface TotalRow { label: string; value: string; muted?: boolean }
function totalRows(doc: InvoiceDoc): TotalRow[] {
  const rows: TotalRow[] = [{ label: 'Subtotal', value: money(doc.subtotal_cents), muted: true }];
  if (doc.discount_cents > 0) rows.push({ label: 'Discount', value: `-${money(doc.discount_cents)}`, muted: true });
  if (doc.tax_cents > 0) rows.push({ label: 'Tax', value: money(doc.tax_cents), muted: true });
  if (doc.retainage_cents > 0) rows.push({ label: 'Retainage withheld', value: `-${money(doc.retainage_cents)}`, muted: true });
  return rows;
}

// ── MODERN ───────────────────────────────────────────────────────────────────
function Modern({ doc, accent }: { doc: InvoiceDoc; accent: string }) {
  const s = StyleSheet.create({
    page: { paddingHorizontal: 50, paddingVertical: 46, fontSize: 9.5, color: '#1f2328', fontFamily: 'Helvetica' },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 },
    logo: { maxWidth: 150, maxHeight: 52, objectFit: 'contain' },
    entity: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: '#111' },
    title: { fontSize: 30, fontFamily: 'Helvetica-Bold', letterSpacing: 2, color: accent },
    metaWrap: { marginTop: 8, alignItems: 'flex-end' },
    metaRow: { flexDirection: 'row', marginBottom: 1.5 },
    metaK: { color: '#9aa0a6', width: 34, textAlign: 'right', marginRight: 8, fontSize: 8.5 },
    metaV: { fontFamily: 'Helvetica-Bold', fontSize: 9.5 },
    parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 26 },
    party: { width: '48%' },
    plabel: { fontSize: 7.5, color: accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5, fontFamily: 'Helvetica-Bold' },
    pname: { fontFamily: 'Helvetica-Bold', marginBottom: 2, fontSize: 10.5 },
    pline: { color: '#5f6368', marginBottom: 1 },
    thead: { flexDirection: 'row', backgroundColor: accent, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 3 },
    th: { color: '#fff', fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
    row: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 8, borderBottomWidth: 0.5, borderBottomColor: '#edeff2' },
    desc: { width: '54%', paddingRight: 8 }, qty: { width: '12%', textAlign: 'right' }, rate: { width: '17%', textAlign: 'right' }, amt: { width: '17%', textAlign: 'right' },
    acct: { fontSize: 7.5, color: '#aab0b6', marginTop: 1.5 },
    totals: { marginTop: 16, alignSelf: 'flex-end', width: '44%' },
    tline: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2.5 },
    tmuted: { color: '#6b7178' },
    grand: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5, paddingTop: 7, borderTopWidth: 1, borderTopColor: '#1f2328' },
    gl: { fontFamily: 'Helvetica-Bold', fontSize: 11 },
    pill: { marginTop: 12, backgroundColor: accent, borderRadius: 5, paddingVertical: 11, paddingHorizontal: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    plabel2: { color: '#fff', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1 },
    pval: { color: '#fff', fontSize: 16, fontFamily: 'Helvetica-Bold' },
    msg: { marginTop: 28, padding: 12, backgroundColor: '#f7f8f9', borderRadius: 4, color: '#5f6368', lineHeight: 1.45, fontSize: 9 },
    footer: { position: 'absolute', bottom: 30, left: 50, right: 50, fontSize: 8, color: '#aab0b6', textAlign: 'center', borderTopWidth: 0.5, borderTopColor: '#edeff2', paddingTop: 8 },
  });
  const bill = fmtAddress(doc.bill_to);
  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.top}>
        <View>{doc.template?.logo_url ? <Image src={doc.template.logo_url} style={s.logo} /> : <Text style={s.entity}>{doc.entity?.name || 'Invoice'}</Text>}</View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.title}>INVOICE</Text>
          <View style={s.metaWrap}>
            <View style={s.metaRow}><Text style={s.metaK}>No.</Text><Text style={s.metaV}>{doc.invoice_number}</Text></View>
            <View style={s.metaRow}><Text style={s.metaK}>Date</Text><Text style={s.metaV}>{fmtDate(doc.invoice_date)}</Text></View>
            <View style={s.metaRow}><Text style={s.metaK}>Due</Text><Text style={s.metaV}>{fmtDate(doc.due_date)}</Text></View>
            {doc.po_number ? <View style={s.metaRow}><Text style={s.metaK}>PO</Text><Text style={s.metaV}>{doc.po_number}</Text></View> : null}
          </View>
        </View>
      </View>
      <View style={s.parties}>
        <View style={s.party}><Text style={s.plabel}>Bill To</Text><Text style={s.pname}>{doc.customer?.name || '—'}</Text>{bill.map((l, i) => <Text key={i} style={s.pline}>{l}</Text>)}{doc.customer?.email ? <Text style={s.pline}>{doc.customer.email}</Text> : null}</View>
        <View style={s.party}><Text style={s.plabel}>From</Text><Text style={s.pname}>{doc.entity?.name || ''}</Text>{doc.template?.remit_to ? doc.template.remit_to.split('\n').map((l, i) => <Text key={i} style={s.pline}>{l}</Text>) : null}</View>
      </View>
      <View style={s.thead}>
        <Text style={[s.th, s.desc]}>Description</Text><Text style={[s.th, s.qty]}>Qty</Text><Text style={[s.th, s.rate]}>Rate</Text><Text style={[s.th, s.amt]}>Amount</Text>
      </View>
      {doc.lines.map((l, i) => (
        <View key={i} style={s.row}>
          <View style={s.desc}><Text>{l.description}</Text>{l.account ? <Text style={s.acct}>{l.account.account_number} · {l.account.name}</Text> : null}</View>
          <Text style={s.qty}>{l.quantity}</Text><Text style={s.rate}>{money(l.unit_price_cents)}</Text><Text style={s.amt}>{money(l.amount_cents)}</Text>
        </View>
      ))}
      <View style={s.totals}>
        {totalRows(doc).map((r, i) => <View key={i} style={s.tline}><Text style={s.tmuted}>{r.label}</Text><Text>{r.value}</Text></View>)}
        <View style={s.grand}><Text style={s.gl}>Total</Text><Text style={s.gl}>{money(doc.total_cents)}</Text></View>
        {doc.amount_paid_cents > 0 ? <View style={s.tline}><Text style={s.tmuted}>Paid</Text><Text>-{money(doc.amount_paid_cents)}</Text></View> : null}
        <View style={s.pill}><Text style={s.plabel2}>Balance Due</Text><Text style={s.pval}>{money(doc.balance_cents)}</Text></View>
      </View>
      {doc.customer_message ? <Text style={s.msg}>{doc.customer_message}</Text> : null}
      <Text style={s.footer} fixed>{doc.template?.footer_text || `${doc.entity?.name ?? ''} · Invoice ${doc.invoice_number}`}</Text>
    </Page>
  );
}

// ── CLASSIC ──────────────────────────────────────────────────────────────────
function Classic({ doc, accent }: { doc: InvoiceDoc; accent: string }) {
  const s = StyleSheet.create({
    page: { paddingHorizontal: 56, paddingVertical: 50, fontSize: 10, color: '#222', fontFamily: 'Times-Roman' },
    masthead: { alignItems: 'center', borderTopWidth: 2.5, borderBottomWidth: 0.75, borderColor: '#222', paddingVertical: 12, marginBottom: 4 },
    logo: { maxHeight: 46, maxWidth: 150, objectFit: 'contain', marginBottom: 8 },
    entity: { fontSize: 18, fontFamily: 'Times-Bold', letterSpacing: 0.5 },
    title: { fontSize: 11, letterSpacing: 6, marginTop: 6, color: accent, fontFamily: 'Times-Bold' },
    rule2: { borderBottomWidth: 2.5, borderColor: '#222', marginBottom: 22 },
    metaRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: 18, gap: 0 },
    meta: { marginHorizontal: 14, fontSize: 9.5 }, metaK: { fontFamily: 'Times-Bold' },
    parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 22 },
    party: { width: '48%' }, plabel: { fontSize: 8.5, fontFamily: 'Times-Bold', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4, color: '#555' },
    pname: { fontFamily: 'Times-Bold', fontSize: 11, marginBottom: 2 }, pline: { color: '#444', marginBottom: 1 },
    thead: { flexDirection: 'row', borderBottomWidth: 1, borderTopWidth: 1, borderColor: '#222', paddingVertical: 5 },
    th: { fontFamily: 'Times-Bold', fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5 },
    row: { flexDirection: 'row', paddingVertical: 7, borderBottomWidth: 0.5, borderBottomColor: '#ccc' },
    desc: { width: '54%', paddingRight: 8 }, qty: { width: '12%', textAlign: 'right' }, rate: { width: '17%', textAlign: 'right' }, amt: { width: '17%', textAlign: 'right' },
    acct: { fontSize: 8, color: '#999', fontFamily: 'Times-Italic', marginTop: 1 },
    totals: { marginTop: 14, alignSelf: 'flex-end', width: '42%' },
    tline: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }, tmuted: { color: '#555' },
    grand: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4, paddingTop: 7, borderTopWidth: 1.5, borderBottomWidth: 1.5, borderColor: '#222', paddingBottom: 7 },
    gl: { fontFamily: 'Times-Bold', fontSize: 12 },
    msg: { marginTop: 26, textAlign: 'center', fontFamily: 'Times-Italic', color: '#444', lineHeight: 1.5, fontSize: 10 },
    footer: { position: 'absolute', bottom: 32, left: 56, right: 56, fontSize: 8.5, color: '#888', textAlign: 'center', fontFamily: 'Times-Italic', borderTopWidth: 0.5, borderColor: '#ccc', paddingTop: 8 },
  });
  const bill = fmtAddress(doc.bill_to);
  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.masthead}>
        {doc.template?.logo_url ? <Image src={doc.template.logo_url} style={s.logo} /> : null}
        <Text style={s.entity}>{doc.entity?.name || 'Invoice'}</Text>
        <Text style={s.title}>I N V O I C E</Text>
      </View>
      <View style={s.rule2} />
      <View style={s.metaRow}>
        <Text style={s.meta}><Text style={s.metaK}>No. </Text>{doc.invoice_number}</Text>
        <Text style={s.meta}><Text style={s.metaK}>Date </Text>{fmtDate(doc.invoice_date)}</Text>
        <Text style={s.meta}><Text style={s.metaK}>Due </Text>{fmtDate(doc.due_date)}</Text>
        {doc.po_number ? <Text style={s.meta}><Text style={s.metaK}>PO </Text>{doc.po_number}</Text> : null}
      </View>
      <View style={s.parties}>
        <View style={s.party}><Text style={s.plabel}>Bill To</Text><Text style={s.pname}>{doc.customer?.name || '—'}</Text>{bill.map((l, i) => <Text key={i} style={s.pline}>{l}</Text>)}{doc.customer?.email ? <Text style={s.pline}>{doc.customer.email}</Text> : null}</View>
        <View style={s.party}><Text style={s.plabel}>Remit To</Text><Text style={s.pname}>{doc.entity?.name || ''}</Text>{doc.template?.remit_to ? doc.template.remit_to.split('\n').map((l, i) => <Text key={i} style={s.pline}>{l}</Text>) : null}</View>
      </View>
      <View style={s.thead}><Text style={[s.th, s.desc]}>Description</Text><Text style={[s.th, s.qty]}>Qty</Text><Text style={[s.th, s.rate]}>Rate</Text><Text style={[s.th, s.amt]}>Amount</Text></View>
      {doc.lines.map((l, i) => (
        <View key={i} style={s.row}>
          <View style={s.desc}><Text>{l.description}</Text>{l.account ? <Text style={s.acct}>{l.account.account_number} · {l.account.name}</Text> : null}</View>
          <Text style={s.qty}>{l.quantity}</Text><Text style={s.rate}>{money(l.unit_price_cents)}</Text><Text style={s.amt}>{money(l.amount_cents)}</Text>
        </View>
      ))}
      <View style={s.totals}>
        {totalRows(doc).map((r, i) => <View key={i} style={s.tline}><Text style={s.tmuted}>{r.label}</Text><Text>{r.value}</Text></View>)}
        <View style={s.grand}><Text style={s.gl}>Total Due</Text><Text style={s.gl}>{money(doc.balance_cents)}</Text></View>
        {doc.amount_paid_cents > 0 ? <View style={s.tline}><Text style={s.tmuted}>Less paid</Text><Text>-{money(doc.amount_paid_cents)}</Text></View> : null}
      </View>
      {doc.customer_message ? <Text style={s.msg}>{doc.customer_message}</Text> : null}
      <Text style={s.footer} fixed>{doc.template?.footer_text || `${doc.entity?.name ?? ''}`}</Text>
    </Page>
  );
}

// ── MINIMAL ──────────────────────────────────────────────────────────────────
function Minimal({ doc, accent }: { doc: InvoiceDoc; accent: string }) {
  const s = StyleSheet.create({
    page: { paddingHorizontal: 54, paddingVertical: 54, fontSize: 9, color: '#111', fontFamily: 'Helvetica' },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 44 },
    logo: { maxHeight: 40, maxWidth: 130, objectFit: 'contain' },
    entity: { fontSize: 13, fontFamily: 'Helvetica-Bold' },
    kicker: { fontFamily: 'Courier', fontSize: 8, letterSpacing: 3, color: accent, marginBottom: 4 },
    num: { fontFamily: 'Courier-Bold', fontSize: 13 },
    metaRow: { flexDirection: 'row', marginTop: 3, justifyContent: 'flex-end' },
    meta: { fontFamily: 'Courier', fontSize: 8, color: '#888', marginLeft: 14 },
    parties: { flexDirection: 'row', marginBottom: 40 },
    party: { width: '50%' }, plabel: { fontFamily: 'Courier', fontSize: 7.5, letterSpacing: 1.5, color: '#999', marginBottom: 6, textTransform: 'uppercase' },
    pname: { fontFamily: 'Helvetica-Bold', fontSize: 10, marginBottom: 2 }, pline: { color: '#555', marginBottom: 1, fontSize: 9 },
    thead: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#111', paddingBottom: 5, marginBottom: 2 },
    th: { fontFamily: 'Courier', fontSize: 7.5, letterSpacing: 1, textTransform: 'uppercase', color: '#999' },
    row: { flexDirection: 'row', paddingVertical: 9, borderBottomWidth: 0.25, borderBottomColor: '#e2e2e2' },
    desc: { width: '56%', paddingRight: 8 }, qty: { width: '10%', textAlign: 'right', fontFamily: 'Courier', fontSize: 8.5 }, rate: { width: '17%', textAlign: 'right', fontFamily: 'Courier', fontSize: 8.5 }, amt: { width: '17%', textAlign: 'right', fontFamily: 'Courier', fontSize: 8.5 },
    acct: { fontSize: 7.5, color: '#aaa', fontFamily: 'Courier', marginTop: 2 },
    totals: { marginTop: 22, alignSelf: 'flex-end', width: '40%' },
    tline: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }, tk: { fontFamily: 'Courier', fontSize: 8, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }, tv: { fontFamily: 'Courier', fontSize: 8.5 },
    balWrap: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderColor: '#111', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
    balK: { fontFamily: 'Courier', fontSize: 8, letterSpacing: 1.5, textTransform: 'uppercase' },
    balV: { fontFamily: 'Courier-Bold', fontSize: 15, color: accent },
    leftRule: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: accent },
    msg: { marginTop: 40, color: '#666', lineHeight: 1.5, fontSize: 9, maxWidth: '70%' },
    footer: { position: 'absolute', bottom: 34, left: 54, right: 54, fontSize: 7.5, color: '#bbb', fontFamily: 'Courier', letterSpacing: 0.5 },
  });
  const bill = fmtAddress(doc.bill_to);
  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.leftRule} fixed />
      <View style={s.top}>
        <View>{doc.template?.logo_url ? <Image src={doc.template.logo_url} style={s.logo} /> : <Text style={s.entity}>{doc.entity?.name || 'Invoice'}</Text>}</View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.kicker}>INVOICE</Text>
          <Text style={s.num}>{doc.invoice_number}</Text>
          <View style={s.metaRow}><Text style={s.meta}>ISSUED {fmtDate(doc.invoice_date)}</Text><Text style={s.meta}>DUE {fmtDate(doc.due_date)}</Text></View>
          {doc.po_number ? <View style={s.metaRow}><Text style={s.meta}>PO {doc.po_number}</Text></View> : null}
        </View>
      </View>
      <View style={s.parties}>
        <View style={s.party}><Text style={s.plabel}>Bill To</Text><Text style={s.pname}>{doc.customer?.name || '—'}</Text>{bill.map((l, i) => <Text key={i} style={s.pline}>{l}</Text>)}{doc.customer?.email ? <Text style={s.pline}>{doc.customer.email}</Text> : null}</View>
        <View style={s.party}><Text style={s.plabel}>From</Text><Text style={s.pname}>{doc.entity?.name || ''}</Text>{doc.template?.remit_to ? doc.template.remit_to.split('\n').map((l, i) => <Text key={i} style={s.pline}>{l}</Text>) : null}</View>
      </View>
      <View style={s.thead}><Text style={[s.th, s.desc]}>Description</Text><Text style={[s.th, s.qty]}>Qty</Text><Text style={[s.th, s.rate]}>Rate</Text><Text style={[s.th, s.amt]}>Amount</Text></View>
      {doc.lines.map((l, i) => (
        <View key={i} style={s.row}>
          <View style={s.desc}><Text>{l.description}</Text>{l.account ? <Text style={s.acct}>{l.account.account_number} · {l.account.name}</Text> : null}</View>
          <Text style={s.qty}>{l.quantity}</Text><Text style={s.rate}>{money(l.unit_price_cents)}</Text><Text style={s.amt}>{money(l.amount_cents)}</Text>
        </View>
      ))}
      <View style={s.totals}>
        {totalRows(doc).map((r, i) => <View key={i} style={s.tline}><Text style={s.tk}>{r.label}</Text><Text style={s.tv}>{r.value}</Text></View>)}
        {doc.amount_paid_cents > 0 ? <View style={s.tline}><Text style={s.tk}>Paid</Text><Text style={s.tv}>-{money(doc.amount_paid_cents)}</Text></View> : null}
        <View style={s.balWrap}><Text style={s.balK}>Balance Due</Text><Text style={s.balV}>{money(doc.balance_cents)}</Text></View>
      </View>
      {doc.customer_message ? <Text style={s.msg}>{doc.customer_message}</Text> : null}
      <Text style={s.footer} fixed>{doc.template?.footer_text || `${doc.entity?.name ?? ''} — ${doc.invoice_number}`}</Text>
    </Page>
  );
}

// ── BOLD ─────────────────────────────────────────────────────────────────────
// Full-bleed accent header block, brand-forward. The signature is the masthead.
function Bold({ doc, accent }: { doc: InvoiceDoc; accent: string }) {
  const s = StyleSheet.create({
    page: { fontSize: 9.5, color: '#1f2328', fontFamily: 'Helvetica' },
    band: { backgroundColor: accent, paddingHorizontal: 50, paddingTop: 44, paddingBottom: 30, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
    logo: { maxWidth: 150, maxHeight: 48, objectFit: 'contain' },
    entity: { fontSize: 19, fontFamily: 'Helvetica-Bold', color: '#fff' },
    bandSub: { color: 'rgba(255,255,255,0.85)', fontSize: 9, marginTop: 3 },
    title: { fontSize: 28, fontFamily: 'Helvetica-Bold', letterSpacing: 1.5, color: '#fff' },
    metaRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 5 },
    metaK: { color: 'rgba(255,255,255,0.7)', fontSize: 8.5, marginLeft: 12 }, metaV: { color: '#fff', fontFamily: 'Helvetica-Bold', fontSize: 8.5, marginLeft: 3 },
    body: { paddingHorizontal: 50, paddingTop: 26 },
    parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
    party: { width: '48%' }, plabel: { fontSize: 7.5, color: accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5, fontFamily: 'Helvetica-Bold' },
    pname: { fontFamily: 'Helvetica-Bold', marginBottom: 2, fontSize: 10.5 }, pline: { color: '#5f6368', marginBottom: 1 },
    thead: { flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: accent, paddingBottom: 5 },
    th: { fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.6, fontFamily: 'Helvetica-Bold', color: '#1f2328' },
    row: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: '#edeff2' },
    desc: { width: '54%', paddingRight: 8 }, qty: { width: '12%', textAlign: 'right' }, rate: { width: '17%', textAlign: 'right' }, amt: { width: '17%', textAlign: 'right' },
    acct: { fontSize: 7.5, color: '#aab0b6', marginTop: 1.5 },
    totals: { marginTop: 16, alignSelf: 'flex-end', width: '44%' },
    tline: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2.5 }, tmuted: { color: '#6b7178' },
    grand: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5, paddingTop: 7, borderTopWidth: 1, borderTopColor: '#1f2328' }, gl: { fontFamily: 'Helvetica-Bold', fontSize: 11 },
    pill: { marginTop: 12, backgroundColor: accent, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    pl2: { color: '#fff', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1 }, pv: { color: '#fff', fontSize: 17, fontFamily: 'Helvetica-Bold' },
    msg: { marginTop: 26, padding: 12, backgroundColor: '#f7f8f9', color: '#5f6368', lineHeight: 1.45, fontSize: 9 },
    footer: { position: 'absolute', bottom: 30, left: 50, right: 50, fontSize: 8, color: '#aab0b6', textAlign: 'center', borderTopWidth: 0.5, borderTopColor: '#edeff2', paddingTop: 8 },
  });
  const bill = fmtAddress(doc.bill_to);
  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.band}>
        <View>
          {doc.template?.logo_url ? <Image src={doc.template.logo_url} style={s.logo} /> : <Text style={s.entity}>{doc.entity?.name || 'Invoice'}</Text>}
          <Text style={s.bandSub}>{doc.invoice_number}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.title}>INVOICE</Text>
          <View style={s.metaRow}><Text style={s.metaK}>DATE</Text><Text style={s.metaV}>{fmtDate(doc.invoice_date)}</Text></View>
          <View style={s.metaRow}><Text style={s.metaK}>DUE</Text><Text style={s.metaV}>{fmtDate(doc.due_date)}</Text>{doc.po_number ? <><Text style={s.metaK}>PO</Text><Text style={s.metaV}>{doc.po_number}</Text></> : null}</View>
        </View>
      </View>
      <View style={s.body}>
        <View style={s.parties}>
          <View style={s.party}><Text style={s.plabel}>Bill To</Text><Text style={s.pname}>{doc.customer?.name || '—'}</Text>{bill.map((l, i) => <Text key={i} style={s.pline}>{l}</Text>)}{doc.customer?.email ? <Text style={s.pline}>{doc.customer.email}</Text> : null}</View>
          <View style={s.party}><Text style={s.plabel}>From</Text><Text style={s.pname}>{doc.entity?.name || ''}</Text>{doc.template?.remit_to ? doc.template.remit_to.split('\n').map((l, i) => <Text key={i} style={s.pline}>{l}</Text>) : null}</View>
        </View>
        <View style={s.thead}><Text style={[s.th, s.desc]}>Description</Text><Text style={[s.th, s.qty]}>Qty</Text><Text style={[s.th, s.rate]}>Rate</Text><Text style={[s.th, s.amt]}>Amount</Text></View>
        {doc.lines.map((l, i) => (
          <View key={i} style={s.row}><View style={s.desc}><Text>{l.description}</Text>{l.account ? <Text style={s.acct}>{l.account.account_number} · {l.account.name}</Text> : null}</View><Text style={s.qty}>{l.quantity}</Text><Text style={s.rate}>{money(l.unit_price_cents)}</Text><Text style={s.amt}>{money(l.amount_cents)}</Text></View>
        ))}
        <View style={s.totals}>
          {totalRows(doc).map((r, i) => <View key={i} style={s.tline}><Text style={s.tmuted}>{r.label}</Text><Text>{r.value}</Text></View>)}
          <View style={s.grand}><Text style={s.gl}>Total</Text><Text style={s.gl}>{money(doc.total_cents)}</Text></View>
          {doc.amount_paid_cents > 0 ? <View style={s.tline}><Text style={s.tmuted}>Paid</Text><Text>-{money(doc.amount_paid_cents)}</Text></View> : null}
          <View style={s.pill}><Text style={s.pl2}>Balance Due</Text><Text style={s.pv}>{money(doc.balance_cents)}</Text></View>
        </View>
        {doc.customer_message ? <Text style={s.msg}>{doc.customer_message}</Text> : null}
      </View>
      <Text style={s.footer} fixed>{doc.template?.footer_text || `${doc.entity?.name ?? ''} · Invoice ${doc.invoice_number}`}</Text>
    </Page>
  );
}

// ── COMPACT ──────────────────────────────────────────────────────────────────
// Dense, businesslike — fits many line items, tight rows, smaller type.
function Compact({ doc, accent }: { doc: InvoiceDoc; accent: string }) {
  const s = StyleSheet.create({
    page: { paddingHorizontal: 44, paddingVertical: 40, fontSize: 8.5, color: '#222', fontFamily: 'Helvetica' },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 2, borderBottomColor: accent, paddingBottom: 8, marginBottom: 14 },
    logo: { maxHeight: 34, maxWidth: 120, objectFit: 'contain' }, entity: { fontSize: 13, fontFamily: 'Helvetica-Bold' },
    title: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: accent }, sub: { fontSize: 8, color: '#888', textAlign: 'right', marginTop: 1 },
    grid: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
    cell: { width: '32%' }, clabel: { fontSize: 6.5, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
    cname: { fontFamily: 'Helvetica-Bold', fontSize: 9 }, cline: { color: '#555', fontSize: 8 },
    thead: { flexDirection: 'row', backgroundColor: '#f2f4f5', paddingVertical: 4, paddingHorizontal: 6 },
    th: { fontSize: 7, textTransform: 'uppercase', letterSpacing: 0.4, color: '#666', fontFamily: 'Helvetica-Bold' },
    row: { flexDirection: 'row', paddingVertical: 4.5, paddingHorizontal: 6, borderBottomWidth: 0.25, borderBottomColor: '#eee' },
    desc: { width: '58%', paddingRight: 6 }, qty: { width: '10%', textAlign: 'right' }, rate: { width: '16%', textAlign: 'right' }, amt: { width: '16%', textAlign: 'right' },
    acct: { fontSize: 6.5, color: '#aaa' },
    totals: { marginTop: 10, alignSelf: 'flex-end', width: '38%' },
    tline: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5 }, tmuted: { color: '#666' },
    grand: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 3, paddingTop: 4, borderTopWidth: 1, borderTopColor: '#222', borderBottomWidth: 2.5, borderBottomColor: accent, paddingBottom: 4 },
    gl: { fontFamily: 'Helvetica-Bold', fontSize: 10.5 },
    msg: { marginTop: 14, fontSize: 8, color: '#666', lineHeight: 1.4 },
    footer: { position: 'absolute', bottom: 26, left: 44, right: 44, fontSize: 7, color: '#aaa', textAlign: 'center', borderTopWidth: 0.5, borderColor: '#eee', paddingTop: 6 },
  });
  const bill = fmtAddress(doc.bill_to);
  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.top}>
        <View>{doc.template?.logo_url ? <Image src={doc.template.logo_url} style={s.logo} /> : <Text style={s.entity}>{doc.entity?.name || 'Invoice'}</Text>}</View>
        <View><Text style={s.title}>INVOICE {doc.invoice_number}</Text><Text style={s.sub}>{fmtDate(doc.invoice_date)} · due {fmtDate(doc.due_date)}{doc.po_number ? ` · PO ${doc.po_number}` : ''}</Text></View>
      </View>
      <View style={s.grid}>
        <View style={s.cell}><Text style={s.clabel}>Bill To</Text><Text style={s.cname}>{doc.customer?.name || '—'}</Text>{bill.map((l, i) => <Text key={i} style={s.cline}>{l}</Text>)}</View>
        <View style={s.cell}><Text style={s.clabel}>From</Text><Text style={s.cname}>{doc.entity?.name || ''}</Text>{doc.template?.remit_to ? doc.template.remit_to.split('\n').map((l, i) => <Text key={i} style={s.cline}>{l}</Text>) : null}</View>
        <View style={s.cell}><Text style={s.clabel}>Balance Due</Text><Text style={{ fontSize: 15, fontFamily: 'Helvetica-Bold', color: accent }}>{money(doc.balance_cents)}</Text></View>
      </View>
      <View style={s.thead}><Text style={[s.th, s.desc]}>Description</Text><Text style={[s.th, s.qty]}>Qty</Text><Text style={[s.th, s.rate]}>Rate</Text><Text style={[s.th, s.amt]}>Amount</Text></View>
      {doc.lines.map((l, i) => (
        <View key={i} style={s.row}><View style={s.desc}><Text>{l.description}</Text>{l.account ? <Text style={s.acct}>{l.account.account_number} · {l.account.name}</Text> : null}</View><Text style={s.qty}>{l.quantity}</Text><Text style={s.rate}>{money(l.unit_price_cents)}</Text><Text style={s.amt}>{money(l.amount_cents)}</Text></View>
      ))}
      <View style={s.totals}>
        {totalRows(doc).map((r, i) => <View key={i} style={s.tline}><Text style={s.tmuted}>{r.label}</Text><Text>{r.value}</Text></View>)}
        <View style={s.grand}><Text style={s.gl}>Total Due</Text><Text style={s.gl}>{money(doc.balance_cents)}</Text></View>
        {doc.amount_paid_cents > 0 ? <View style={s.tline}><Text style={s.tmuted}>Paid</Text><Text>-{money(doc.amount_paid_cents)}</Text></View> : null}
      </View>
      {doc.customer_message ? <Text style={s.msg}>{doc.customer_message}</Text> : null}
      <Text style={s.footer} fixed>{doc.template?.footer_text || `${doc.entity?.name ?? ''} · ${doc.invoice_number}`}</Text>
    </Page>
  );
}

export function InvoicePdf({ doc, style }: { doc: InvoiceDoc; style?: InvoiceStyle }) {
  const accent = doc.template?.accent_color || '#10b981';
  const chosen: InvoiceStyle = style || (doc.template?.style as InvoiceStyle) || 'MODERN';
  return (
    <Document title={`Invoice ${doc.invoice_number}`}>
      {chosen === 'CLASSIC' ? <Classic doc={doc} accent={accent} />
        : chosen === 'MINIMAL' ? <Minimal doc={doc} accent={accent} />
        : chosen === 'BOLD' ? <Bold doc={doc} accent={accent} />
        : chosen === 'COMPACT' ? <Compact doc={doc} accent={accent} />
        : <Modern doc={doc} accent={accent} />}
    </Document>
  );
}
