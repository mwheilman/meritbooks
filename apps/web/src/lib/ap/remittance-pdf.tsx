import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { RemittanceDoc } from './remittance-doc';

/**
 * Remittance advice PDF — the courtesy statement that accompanies an AP payment,
 * telling the vendor exactly which invoices this disbursement covers. White-label
 * (no product/tenant branding hardcoded; the payer name is data-driven). Light,
 * professional document a counterparty expects. Deterministic: built-in fonts
 * only, no network fetch, so the same batch renders identical bytes.
 *
 * Banking detail is shown MASKED only (last-4) — this document never carries a
 * full account or routing number, matching how MeritBooks stores it.
 */

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

const ACCENT = '#0f766e'; // teal-700 — neutral, print-safe, not tied to app chrome

const s = StyleSheet.create({
  page: { paddingHorizontal: 52, paddingVertical: 48, fontSize: 9.5, color: '#1f2328', fontFamily: 'Helvetica' },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 },
  payer: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: '#111', maxWidth: 300 },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', letterSpacing: 1.5, color: ACCENT },
  metaWrap: { marginTop: 8, alignItems: 'flex-end' },
  metaRow: { flexDirection: 'row', marginBottom: 1.5 },
  metaK: { color: '#9aa0a6', width: 52, textAlign: 'right', marginRight: 8, fontSize: 8.5 },
  metaV: { fontFamily: 'Helvetica-Bold', fontSize: 9.5 },
  parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  party: { width: '48%' },
  plabel: { fontSize: 7.5, color: ACCENT, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5, fontFamily: 'Helvetica-Bold' },
  pname: { fontFamily: 'Helvetica-Bold', marginBottom: 2, fontSize: 10.5 },
  pline: { color: '#5f6368', marginBottom: 1 },
  payBox: { marginBottom: 22, padding: 12, backgroundColor: '#f4f7f7', borderRadius: 4, flexDirection: 'row', justifyContent: 'space-between' },
  payK: { fontSize: 7.5, color: '#7a8388', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  payV: { fontFamily: 'Helvetica-Bold', fontSize: 9.5 },
  thead: { flexDirection: 'row', backgroundColor: ACCENT, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 3 },
  th: { color: '#fff', fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.6 },
  row: { flexDirection: 'row', paddingVertical: 7, paddingHorizontal: 8, borderBottomWidth: 0.5, borderBottomColor: '#edeff2' },
  cInv: { width: '34%', paddingRight: 8 },
  cDate: { width: '22%' },
  cChk: { width: '22%' },
  cAmt: { width: '22%', textAlign: 'right' },
  totals: { marginTop: 16, alignSelf: 'flex-end', width: '46%' },
  grand: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#1f2328' },
  gl: { fontFamily: 'Helvetica-Bold', fontSize: 13 },
  note: { marginTop: 30, padding: 11, backgroundColor: '#f7f8f9', borderRadius: 4, color: '#5f6368', lineHeight: 1.45, fontSize: 8.5 },
  footer: { position: 'absolute', bottom: 30, left: 52, right: 52, fontSize: 8, color: '#aab0b6', textAlign: 'center', borderTopWidth: 0.5, borderTopColor: '#edeff2', paddingTop: 8 },
});

export function RemittancePdf({ doc }: { doc: RemittanceDoc }) {
  const bankDetail =
    doc.paymentMethod === 'CHECK'
      ? doc.profile?.notes || 'Check'
      : [doc.profile?.bankName, doc.profile?.accountMask ? `acct ${doc.profile.accountMask}` : null]
          .filter(Boolean)
          .join(' · ') || 'ACH transfer';

  return (
    <Document title={`Remittance advice — ${doc.vendorName}`}>
      <Page size="LETTER" style={s.page}>
        <View style={s.top}>
          <View>
            <Text style={s.payer}>{doc.payerName}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.title}>REMITTANCE</Text>
            <View style={s.metaWrap}>
              <View style={s.metaRow}><Text style={s.metaK}>Ref</Text><Text style={s.metaV}>{doc.reference}</Text></View>
              <View style={s.metaRow}><Text style={s.metaK}>Date</Text><Text style={s.metaV}>{fmtDate(doc.generatedDate)}</Text></View>
              <View style={s.metaRow}><Text style={s.metaK}>Method</Text><Text style={s.metaV}>{doc.paymentMethod}</Text></View>
            </View>
          </View>
        </View>

        <View style={s.parties}>
          <View style={s.party}>
            <Text style={s.plabel}>Payment To</Text>
            <Text style={s.pname}>{doc.vendorName}</Text>
            {doc.vendorAddress.map((l, i) => <Text key={i} style={s.pline}>{l}</Text>)}
            {doc.vendorEmail ? <Text style={s.pline}>{doc.vendorEmail}</Text> : null}
          </View>
          <View style={s.party}>
            <Text style={s.plabel}>From</Text>
            <Text style={s.pname}>{doc.payerName}</Text>
          </View>
        </View>

        <View style={s.payBox}>
          <View>
            <Text style={s.payK}>Payment method</Text>
            <Text style={s.payV}>{doc.paymentMethod === 'ACH' ? 'ACH / bank transfer' : 'Check'}</Text>
          </View>
          <View>
            <Text style={s.payK}>Account</Text>
            <Text style={s.payV}>{bankDetail}</Text>
          </View>
          <View>
            <Text style={s.payK}>Invoices paid</Text>
            <Text style={s.payV}>{doc.lines.length}</Text>
          </View>
        </View>

        <View style={s.thead}>
          <Text style={[s.th, s.cInv]}>Invoice</Text>
          <Text style={[s.th, s.cDate]}>Date</Text>
          <Text style={[s.th, s.cChk]}>Check / Ref</Text>
          <Text style={[s.th, s.cAmt]}>Amount</Text>
        </View>
        {doc.lines.map((l, i) => (
          <View key={i} style={s.row}>
            <Text style={s.cInv}>{l.invoiceRef || '—'}</Text>
            <Text style={s.cDate}>{fmtDate(l.paymentDate)}</Text>
            <Text style={s.cChk}>{l.checkNumber ? `#${l.checkNumber}` : l.method}</Text>
            <Text style={s.cAmt}>{money(l.amountCents)}</Text>
          </View>
        ))}

        <View style={s.totals}>
          <View style={s.grand}>
            <Text style={s.gl}>Total paid</Text>
            <Text style={s.gl}>{money(doc.totalCents)}</Text>
          </View>
        </View>

        <Text style={s.note}>
          This remittance advice details the invoices covered by the referenced payment. Bank details, where shown,
          are masked to the last four digits. Please apply this payment to the invoices listed above and contact us if
          anything appears incorrect.
        </Text>
        <Text style={s.footer} fixed>
          {doc.payerName} · Remittance {doc.reference}
        </Text>
      </Page>
    </Document>
  );
}
