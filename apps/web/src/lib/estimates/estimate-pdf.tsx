import React from 'react';
import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';
import type { EstimateDoc } from './estimate-doc';

/**
 * Branded ESTIMATE / QUOTE PDF. Reuses the same @react-pdf/renderer toolchain the
 * invoice PDF uses (no new dependency) and honors the entity's branding template
 * (logo + accent color). A light-themed white document — a counterparty expects a
 * white quote. Deterministic (built-in Helvetica, no network fetch). Because an
 * estimate is non-posting, there is no "Balance Due" block; instead it shows the
 * quoted Total and a "Valid until" date.
 */

const money = (cents: number, currency = 'USD') =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency });
const fmtDate = (d: string | null) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

function EstimatePage({ doc, accent }: { doc: EstimateDoc; accent: string }) {
  const s = StyleSheet.create({
    page: { paddingHorizontal: 50, paddingVertical: 46, fontSize: 9.5, color: '#1f2328', fontFamily: 'Helvetica' },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 },
    logo: { maxWidth: 150, maxHeight: 52, objectFit: 'contain' },
    entity: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: '#111' },
    title: { fontSize: 30, fontFamily: 'Helvetica-Bold', letterSpacing: 2, color: accent },
    metaWrap: { marginTop: 8, alignItems: 'flex-end' },
    metaRow: { flexDirection: 'row', marginBottom: 1.5 },
    metaK: { color: '#9aa0a6', width: 44, textAlign: 'right', marginRight: 8, fontSize: 8.5 },
    metaV: { fontFamily: 'Helvetica-Bold', fontSize: 9.5 },
    parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 26 },
    party: { width: '48%' },
    plabel: { fontSize: 7.5, color: accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5, fontFamily: 'Helvetica-Bold' },
    pname: { fontFamily: 'Helvetica-Bold', marginBottom: 2, fontSize: 10.5 },
    pline: { color: '#5f6368', marginBottom: 1 },
    thead: { flexDirection: 'row', backgroundColor: accent, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 3 },
    th: { color: '#fff', fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
    row: { flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 8, borderBottomWidth: 0.5, borderBottomColor: '#edeff2' },
    desc: { width: '54%', paddingRight: 8 },
    qty: { width: '12%', textAlign: 'right' },
    rate: { width: '17%', textAlign: 'right' },
    amt: { width: '17%', textAlign: 'right' },
    acct: { fontSize: 7.5, color: '#aab0b6', marginTop: 1.5 },
    totals: { marginTop: 16, alignSelf: 'flex-end', width: '44%' },
    tline: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2.5 },
    tmuted: { color: '#6b7178' },
    grand: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5, paddingTop: 7, borderTopWidth: 1, borderTopColor: '#1f2328' },
    gl: { fontFamily: 'Helvetica-Bold', fontSize: 12 },
    validPill: { marginTop: 12, borderWidth: 1, borderColor: accent, borderRadius: 5, paddingVertical: 9, paddingHorizontal: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    plabel2: { color: accent, fontSize: 9, textTransform: 'uppercase', letterSpacing: 1 },
    pval: { color: '#1f2328', fontSize: 11, fontFamily: 'Helvetica-Bold' },
    msg: { marginTop: 28, padding: 12, backgroundColor: '#f7f8f9', borderRadius: 4, color: '#5f6368', lineHeight: 1.45, fontSize: 9 },
    footer: { position: 'absolute', bottom: 30, left: 50, right: 50, fontSize: 8, color: '#aab0b6', textAlign: 'center', borderTopWidth: 0.5, borderTopColor: '#edeff2', paddingTop: 8 },
  });

  const totalRows: { label: string; value: string }[] = [
    { label: 'Subtotal', value: money(doc.subtotal_cents, doc.currency) },
  ];
  if (doc.tax_cents > 0) totalRows.push({ label: 'Tax', value: money(doc.tax_cents, doc.currency) });

  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.top}>
        <View>
          {doc.template?.logo_url ? (
            <Image src={doc.template.logo_url} style={s.logo} />
          ) : (
            <Text style={s.entity}>{doc.entity?.name || 'Estimate'}</Text>
          )}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.title}>ESTIMATE</Text>
          <View style={s.metaWrap}>
            <View style={s.metaRow}><Text style={s.metaK}>No.</Text><Text style={s.metaV}>{doc.estimate_number}</Text></View>
            <View style={s.metaRow}><Text style={s.metaK}>Date</Text><Text style={s.metaV}>{fmtDate(doc.estimate_date)}</Text></View>
            {doc.expiration_date ? (
              <View style={s.metaRow}><Text style={s.metaK}>Valid to</Text><Text style={s.metaV}>{fmtDate(doc.expiration_date)}</Text></View>
            ) : null}
          </View>
        </View>
      </View>

      <View style={s.parties}>
        <View style={s.party}>
          <Text style={s.plabel}>Prepared For</Text>
          <Text style={s.pname}>{doc.customer?.name || '—'}</Text>
          {doc.customer?.email ? <Text style={s.pline}>{doc.customer.email}</Text> : null}
        </View>
        <View style={s.party}>
          <Text style={s.plabel}>From</Text>
          <Text style={s.pname}>{doc.entity?.name || ''}</Text>
          {doc.template?.remit_to
            ? doc.template.remit_to.split('\n').map((l, i) => <Text key={i} style={s.pline}>{l}</Text>)
            : null}
        </View>
      </View>

      <View style={s.thead}>
        <Text style={[s.th, s.desc]}>Description</Text>
        <Text style={[s.th, s.qty]}>Qty</Text>
        <Text style={[s.th, s.rate]}>Rate</Text>
        <Text style={[s.th, s.amt]}>Amount</Text>
      </View>
      {doc.lines.map((l, i) => (
        <View key={i} style={s.row}>
          <View style={s.desc}>
            <Text>{l.description}</Text>
            {l.account ? <Text style={s.acct}>{l.account.account_number} · {l.account.name}</Text> : null}
          </View>
          <Text style={s.qty}>{l.quantity}</Text>
          <Text style={s.rate}>{money(l.unit_price_cents, doc.currency)}</Text>
          <Text style={s.amt}>{money(l.amount_cents, doc.currency)}</Text>
        </View>
      ))}

      <View style={s.totals}>
        {totalRows.map((r, i) => (
          <View key={i} style={s.tline}><Text style={s.tmuted}>{r.label}</Text><Text>{r.value}</Text></View>
        ))}
        <View style={s.grand}><Text style={s.gl}>Total</Text><Text style={s.gl}>{money(doc.total_cents, doc.currency)}</Text></View>
        {doc.expiration_date ? (
          <View style={s.validPill}>
            <Text style={s.plabel2}>Valid Until</Text>
            <Text style={s.pval}>{fmtDate(doc.expiration_date)}</Text>
          </View>
        ) : null}
      </View>

      {doc.notes ? <Text style={s.msg}>{doc.notes}</Text> : null}
      <Text style={s.footer} fixed>
        {doc.template?.footer_text || `${doc.entity?.name ?? ''} · Estimate ${doc.estimate_number}`}
      </Text>
    </Page>
  );
}

export function EstimatePdf({ doc }: { doc: EstimateDoc }) {
  const accent = doc.template?.accent_color || '#10b981';
  return (
    <Document title={`Estimate ${doc.estimate_number}`}>
      <EstimatePage doc={doc} accent={accent} />
    </Document>
  );
}
