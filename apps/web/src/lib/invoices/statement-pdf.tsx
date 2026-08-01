import React from 'react';
import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';
import { AGING_BUCKETS, AGING_BUCKET_LABELS, type StatementDoc } from './statement';

/**
 * Branded AR customer statement PDF (FPB-invoices §7). Light-themed white
 * document — a counterparty expects white paper, not the app's dark chrome. The
 * tenant's logo, accent color, remit-to, and footer are honored, matching the
 * invoice PDF so an invoice and a statement read as one system.
 *
 * Deterministic: built-in fonts only (Helvetica for text, Courier for the
 * monospace figure treatment — the same figures style the invoice PDF's MINIMAL
 * variant uses; a registered JetBrains Mono would add a network/file dependency
 * the invoice PDF deliberately avoids). Same doc + accent renders identical bytes.
 * All money is cents formatted here — never re-derived.
 */

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

const STATUS_LABEL: Record<string, string> = {
  SENT: 'Open',
  OVERDUE: 'Overdue',
  PARTIALLY_PAID: 'Partial',
  PAID: 'Paid',
  DRAFT: 'Draft',
  WRITTEN_OFF: 'Written off',
};

function StatementBody({ doc, accent }: { doc: StatementDoc; accent: string }) {
  const s = StyleSheet.create({
    page: { paddingHorizontal: 46, paddingVertical: 42, fontSize: 9, color: '#1f2328', fontFamily: 'Helvetica' },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 26 },
    logo: { maxWidth: 150, maxHeight: 50, objectFit: 'contain' },
    entity: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: '#111' },
    title: { fontSize: 26, fontFamily: 'Helvetica-Bold', letterSpacing: 1.5, color: accent },
    metaWrap: { marginTop: 8, alignItems: 'flex-end' },
    metaRow: { flexDirection: 'row', marginBottom: 1.5 },
    metaK: { color: '#9aa0a6', textAlign: 'right', marginRight: 8, fontSize: 8 },
    metaV: { fontFamily: 'Courier-Bold', fontSize: 9 },
    parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
    party: { width: '48%' },
    plabel: { fontSize: 7.5, color: accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5, fontFamily: 'Helvetica-Bold' },
    pname: { fontFamily: 'Helvetica-Bold', marginBottom: 2, fontSize: 10.5 },
    pline: { color: '#5f6368', marginBottom: 1 },
    // Aging summary strip
    aging: { flexDirection: 'row', borderWidth: 0.75, borderColor: '#e2e5e9', borderRadius: 4, marginBottom: 22, overflow: 'hidden' },
    agCell: { flex: 1, paddingVertical: 8, paddingHorizontal: 6, borderRightWidth: 0.75, borderRightColor: '#e2e5e9' },
    agCellLast: { flex: 1.15, paddingVertical: 8, paddingHorizontal: 8, backgroundColor: accent },
    agK: { fontSize: 7, color: '#9aa0a6', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 3 },
    agKLast: { fontSize: 7, color: '#ffffff', opacity: 0.9, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 3 },
    agV: { fontFamily: 'Courier-Bold', fontSize: 9.5 },
    agVLast: { fontFamily: 'Courier-Bold', fontSize: 11, color: '#ffffff' },
    // Lines table
    thead: { flexDirection: 'row', backgroundColor: '#f2f4f5', paddingVertical: 5, paddingHorizontal: 6 },
    th: { fontSize: 7.5, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    row: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: '#edeff2' },
    cDate: { width: '13%' }, cNum: { width: '20%' }, cDue: { width: '13%' },
    cAmt: { width: '15%', textAlign: 'right' }, cPaid: { width: '15%', textAlign: 'right' },
    cBal: { width: '16%', textAlign: 'right' }, cStat: { width: '8%', textAlign: 'right' },
    mono: { fontFamily: 'Courier', fontSize: 8.5 },
    stat: { fontSize: 7 },
    totalRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 14 },
    pill: { backgroundColor: accent, borderRadius: 5, paddingVertical: 11, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minWidth: '46%' },
    pillK: { color: '#fff', fontSize: 9, textTransform: 'uppercase', letterSpacing: 1 },
    pillV: { color: '#fff', fontSize: 16, fontFamily: 'Courier-Bold', marginLeft: 20 },
    remit: { marginTop: 26, padding: 12, backgroundColor: '#f7f8f9', borderRadius: 4 },
    remitK: { fontSize: 7.5, color: '#9aa0a6', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4, fontFamily: 'Helvetica-Bold' },
    remitL: { color: '#5f6368', marginBottom: 1, lineHeight: 1.4 },
    empty: { marginTop: 30, textAlign: 'center', color: '#9aa0a6', fontSize: 10 },
    footer: { position: 'absolute', bottom: 28, left: 46, right: 46, fontSize: 8, color: '#aab0b6', textAlign: 'center', borderTopWidth: 0.5, borderTopColor: '#edeff2', paddingTop: 8 },
  });

  const periodLabel =
    doc.mode === 'activity'
      ? `Activity ${doc.periodFrom ? fmtDate(doc.periodFrom) : 'start'} – ${doc.periodTo ? fmtDate(doc.periodTo) : fmtDate(doc.asOf)}`
      : 'Open items';

  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.top}>
        <View>
          {doc.template.logoUrl ? <Image src={doc.template.logoUrl} style={s.logo} /> : <Text style={s.entity}>{doc.entity?.name || 'Statement'}</Text>}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.title}>STATEMENT</Text>
          <View style={s.metaWrap}>
            <View style={s.metaRow}><Text style={s.metaK}>As of</Text><Text style={s.metaV}>{fmtDate(doc.asOf)}</Text></View>
            <View style={s.metaRow}><Text style={s.metaK}>Scope</Text><Text style={[s.metaV, { fontFamily: 'Helvetica-Bold', fontSize: 8.5 }]}>{periodLabel}</Text></View>
          </View>
        </View>
      </View>

      <View style={s.parties}>
        <View style={s.party}>
          <Text style={s.plabel}>Statement For</Text>
          <Text style={s.pname}>{doc.customer.name || '—'}</Text>
          {doc.customer.addressLines.map((l, i) => <Text key={i} style={s.pline}>{l}</Text>)}
          {doc.customer.email ? <Text style={s.pline}>{doc.customer.email}</Text> : null}
        </View>
        <View style={s.party}>
          <Text style={s.plabel}>From</Text>
          <Text style={s.pname}>{doc.entity?.name || ''}</Text>
          {doc.template.remitTo ? doc.template.remitTo.split('\n').map((l, i) => <Text key={i} style={s.pline}>{l}</Text>) : null}
        </View>
      </View>

      {/* Aging summary */}
      <View style={s.aging}>
        {AGING_BUCKETS.map((b) => (
          <View key={b} style={s.agCell}>
            <Text style={s.agK}>{AGING_BUCKET_LABELS[b]}</Text>
            <Text style={s.agV}>{money(doc.aging[b])}</Text>
          </View>
        ))}
        <View style={s.agCellLast}>
          <Text style={s.agKLast}>Balance Due</Text>
          <Text style={s.agVLast}>{money(doc.totalBalanceCents)}</Text>
        </View>
      </View>

      {/* Lines */}
      {doc.lines.length > 0 ? (
        <>
          <View style={s.thead}>
            <Text style={[s.th, s.cDate]}>Date</Text>
            <Text style={[s.th, s.cNum]}>Invoice</Text>
            <Text style={[s.th, s.cDue]}>Due</Text>
            <Text style={[s.th, s.cAmt]}>Amount</Text>
            <Text style={[s.th, s.cPaid]}>Paid</Text>
            <Text style={[s.th, s.cBal]}>Balance</Text>
            <Text style={[s.th, s.cStat]}>Status</Text>
          </View>
          {doc.lines.map((l) => (
            <View key={l.id} style={s.row} wrap={false}>
              <Text style={[s.mono, s.cDate]}>{fmtDate(l.invoiceDate)}</Text>
              <Text style={[s.cNum, { fontFamily: 'Courier-Bold', fontSize: 8.5 }]}>{l.invoiceNumber}</Text>
              <Text style={[s.mono, s.cDue]}>{fmtDate(l.dueDate)}</Text>
              <Text style={[s.mono, s.cAmt]}>{money(l.totalCents)}</Text>
              <Text style={[s.mono, s.cPaid]}>{l.paidCents > 0 ? `-${money(l.paidCents)}` : money(0)}</Text>
              <Text style={[s.mono, s.cBal, { color: l.balanceCents > 0 ? '#1f2328' : '#9aa0a6' }]}>{money(l.balanceCents)}</Text>
              <Text style={[s.stat, s.cStat, { color: l.status === 'OVERDUE' ? '#dc2626' : l.status === 'PAID' ? '#16a34a' : '#6b7178' }]}>{STATUS_LABEL[l.status] ?? l.status}</Text>
            </View>
          ))}
          <View style={s.totalRow}>
            <View style={s.pill}>
              <Text style={s.pillK}>Total Balance Due</Text>
              <Text style={s.pillV}>{money(doc.totalBalanceCents)}</Text>
            </View>
          </View>
        </>
      ) : (
        <Text style={s.empty}>
          {doc.mode === 'open' ? 'No open invoices — this account has a zero balance.' : 'No invoice activity in this period.'}
        </Text>
      )}

      {doc.template.remitTo ? (
        <View style={s.remit}>
          <Text style={s.remitK}>Remit Payment To</Text>
          {doc.template.remitTo.split('\n').map((l, i) => <Text key={i} style={s.remitL}>{l}</Text>)}
        </View>
      ) : null}

      <Text style={s.footer} fixed>
        {doc.template.footerText || `${doc.entity?.name ?? ''}${doc.entity?.name ? ' · ' : ''}Statement for ${doc.customer.name} · as of ${fmtDate(doc.asOf)}`}
      </Text>
    </Page>
  );
}

export function StatementPdf({ doc }: { doc: StatementDoc }) {
  const accent = doc.template.accentColor || '#10b981';
  return (
    <Document title={`Statement — ${doc.customer.name}`}>
      <StatementBody doc={doc} accent={accent} />
    </Document>
  );
}
