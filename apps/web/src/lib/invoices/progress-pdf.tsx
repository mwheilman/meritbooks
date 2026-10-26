import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { formatMoney } from '@meritbooks/shared';
import type { InvoiceDoc } from './invoice-doc';
import type { ContinuationRow, ProgressApplication } from './progress-application';

/**
 * Progress billing PDF — "Application and Certificate for Payment (AIA G702/G703 style)".
 * Page 1: the application summary (G702 lines 1–9) tied to this invoice; page 2+: the
 * continuation sheet (schedule of values: scheduled value, previous, this period, materials
 * stored, completed to date, %, balance to finish, retainage). Customer-facing: no GL
 * account numbers or names. Money is integer cents through the shared formatter. Labels use
 * ASCII '-' — the built-in Helvetica (WinAnsi) has no U+2212 minus glyph.
 */

const INK = '#0A1628';
const INK_2 = '#3D4F65';
const MUTED = '#8494A7';
const RULE = '#E3E1DC';

const money = (c: number | null) => (c === null ? '—' : formatMoney(c));
const pct = (p: number | null) => (p === null ? '—' : `${p.toFixed(1)}%`);
const fmtDate = (d: string) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

/** G702 summary lines + the tie-out to this invoice's amount due. */
export function applicationLines(p: ProgressApplication, doc: Pick<InvoiceDoc, 'tax_cents' | 'total_cents'>): Array<{ no: string; label: string; value: number | null; strong?: boolean }> {
  const s = p.summary;
  const out: Array<{ no: string; label: string; value: number | null; strong?: boolean }> = [
    { no: '1', label: 'Original contract sum', value: s.originalContractCents },
    { no: '2', label: 'Net change by change orders', value: s.netChangeOrdersCents },
    { no: '3', label: 'Contract sum to date (line 1 ± 2)', value: s.contractSumToDateCents },
    { no: '4', label: 'Total completed and stored to date', value: s.completedToDateCents },
    { no: '5', label: 'Retainage', value: s.retainageToDateCents },
    { no: '6', label: 'Total earned less retainage (line 4 - 5)', value: s.earnedLessRetainageCents },
    { no: '7', label: 'Less previous certificates for payment', value: s.previousCertificatesCents },
    { no: '8', label: 'Current payment due (line 6 - 7)', value: s.currentPaymentDueCents, strong: true },
    { no: '9', label: 'Balance to finish, including retainage (line 3 - 6)', value: s.balanceToFinishCents },
  ];
  if (doc.tax_cents > 0) out.push({ no: '', label: 'Plus sales tax', value: doc.tax_cents });
  const other = doc.total_cents - s.currentPaymentDueCents - doc.tax_cents;
  if (other !== 0) out.push({ no: '', label: 'Other adjustments on this invoice', value: other });
  out.push({ no: '', label: 'Amount due on this invoice', value: doc.total_cents, strong: true });
  return out;
}

const COLS: Array<{ key: keyof ContinuationRow | 'pct'; label: string; w: string; right?: boolean }> = [
  { key: 'itemNo', label: 'Item', w: '5%' },
  { key: 'description', label: 'Description of work', w: '21%' },
  { key: 'scheduledValueCents', label: 'Scheduled value', w: '10%', right: true },
  { key: 'previousCents', label: 'From previous application', w: '10%', right: true },
  { key: 'thisPeriodCents', label: 'This period', w: '10%', right: true },
  { key: 'materialsStoredCents', label: 'Materials presently stored', w: '9%', right: true },
  { key: 'completedToDateCents', label: 'Completed & stored to date', w: '10%', right: true },
  { key: 'pct', label: '%', w: '5%', right: true },
  { key: 'balanceToFinishCents', label: 'Balance to finish', w: '10%', right: true },
  { key: 'retainageCents', label: 'Retainage', w: '10%', right: true },
];

function cell(r: ContinuationRow, key: (typeof COLS)[number]['key']): string {
  switch (key) {
    case 'itemNo':
    case 'description':
      return r[key];
    case 'pct':
      return pct(r.percentComplete);
    case 'percentComplete':
      return pct(r.percentComplete);
    default:
      return money(r[key] as number | null);
  }
}

export function ProgressInvoicePdf({ doc }: { doc: InvoiceDoc & { progress: ProgressApplication } }) {
  const p = doc.progress;
  const accent = doc.template.accent_color || '#2563EB';
  const st = StyleSheet.create({
    page: { padding: 40, paddingBottom: 56, fontSize: 9, color: INK, fontFamily: 'Helvetica' },
    title: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: accent },
    sub: { fontSize: 8, color: MUTED, marginTop: 2 },
    head: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16, borderBottomWidth: 1.5, borderBottomColor: accent, paddingBottom: 10 },
    meta: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 1.5 },
    metaK: { color: MUTED, width: 92, textAlign: 'right', marginRight: 8 },
    metaV: { fontFamily: 'Helvetica-Bold', minWidth: 80, textAlign: 'right' },
    parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
    party: { width: '31%' },
    plabel: { fontSize: 7, color: accent, textTransform: 'uppercase', letterSpacing: 1, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
    pname: { fontFamily: 'Helvetica-Bold', marginBottom: 2 },
    pline: { color: INK_2 },
    lineRow: { flexDirection: 'row', paddingVertical: 4.5, borderBottomWidth: 0.5, borderBottomColor: RULE },
    lineNo: { width: 22, color: MUTED },
    lineLabel: { flexGrow: 1 },
    lineVal: { width: 120, textAlign: 'right' },
    strong: { fontFamily: 'Helvetica-Bold' },
    note: { marginTop: 14, color: INK_2, lineHeight: 1.4, fontSize: 8 },
    sign: { marginTop: 22, flexDirection: 'row', justifyContent: 'space-between' },
    signBox: { width: '47%', borderTopWidth: 0.75, borderTopColor: INK, paddingTop: 4, color: INK_2, fontSize: 8 },
    th: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: INK, paddingBottom: 4, marginBottom: 2 },
    thText: { fontSize: 6.5, textTransform: 'uppercase', color: INK_2, fontFamily: 'Helvetica-Bold', paddingRight: 4 },
    tr: { flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: RULE },
    total: { flexDirection: 'row', paddingVertical: 5, borderTopWidth: 1, borderTopColor: INK, marginTop: 2 },
    footer: { position: 'absolute', bottom: 22, left: 40, right: 40, fontSize: 7, color: MUTED, textAlign: 'center', borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 6 },
  });

  const header = (sheet: string) => (
    <View style={st.head}>
      <View style={{ maxWidth: '55%' }}>
        <Text style={st.title}>Application and Certificate for Payment</Text>
        <Text style={st.sub}>AIA G702/G703 style · {sheet}</Text>
        <Text style={{ marginTop: 6, fontFamily: 'Helvetica-Bold' }}>{doc.entity?.name ?? ''}</Text>
      </View>
      <View>
        {(
          [
            ['Application no.', String(p.summary.applicationNumber)],
            ['Invoice no.', doc.invoice_number],
            ['Application date', fmtDate(doc.invoice_date)],
            ['Due', fmtDate(doc.due_date)],
            ...(doc.po_number ? [['PO', doc.po_number]] : []),
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <View key={k} style={st.meta}><Text style={st.metaK}>{k}</Text><Text style={st.metaV}>{v}</Text></View>
        ))}
      </View>
    </View>
  );

  const lines = applicationLines(p, doc);
  const footer = `${doc.entity?.name ?? ''} · Application ${p.summary.applicationNumber} · Invoice ${doc.invoice_number}`;

  return (
    <Document title={`Application ${p.summary.applicationNumber} · Invoice ${doc.invoice_number}`} author={doc.entity?.name ?? undefined}>
      <Page size="LETTER" style={st.page}>
        {header('Application summary')}
        <View style={st.parties}>
          <View style={st.party}>
            <Text style={st.plabel}>To owner</Text>
            <Text style={st.pname}>{doc.customer?.name || '—'}</Text>
            {doc.customer?.email ? <Text style={st.pline}>{doc.customer.email}</Text> : null}
          </View>
          <View style={st.party}>
            <Text style={st.plabel}>From contractor</Text>
            <Text style={st.pname}>{doc.entity?.name || '—'}</Text>
            {doc.template.remit_to ? doc.template.remit_to.split('\n').map((l, i) => <Text key={i} style={st.pline}>{l}</Text>) : null}
          </View>
          <View style={st.party}>
            <Text style={st.plabel}>Project</Text>
            <Text style={st.pname}>{doc.job_label || '—'}</Text>
            <Text style={st.pline}>Period to {fmtDate(doc.invoice_date)}</Text>
            {p.summary.percentComplete !== null ? <Text style={st.pline}>{pct(p.summary.percentComplete)} complete</Text> : null}
          </View>
        </View>

        {lines.map((l, i) => (
          <View key={i} style={[st.lineRow, l.no === '' ? { borderBottomWidth: 0 } : {}]} wrap={false}>
            <Text style={st.lineNo}>{l.no}</Text>
            <Text style={[st.lineLabel, l.strong ? st.strong : {}]}>{l.label}</Text>
            <Text style={[st.lineVal, l.strong ? st.strong : {}]}>{money(l.value)}</Text>
          </View>
        ))}

        <Text style={st.note}>
          {p.previousBills.length
            ? `Previous certificates: ${p.previousBills.map((b) => `${b.invoiceNumber} (${fmtDate(b.invoiceDate)})`).join(', ')}.`
            : 'This is the first application for payment on this contract.'}
          {p.summary.contractSumToDateCents === null ? ' The contract sum is not on file, so lines 1–3 and 9 are left blank.' : ''}
          {' '}Materials stored off site are not tracked separately and are included in work completed.
        </Text>

        <View style={st.sign}>
          <Text style={st.signBox}>Contractor · signature and date</Text>
          <Text style={st.signBox}>Architect / owner certification · amount certified and date</Text>
        </View>

        <Text style={st.footer} fixed>{footer}</Text>
      </Page>

      <Page size="LETTER" orientation="landscape" style={st.page}>
        {header('Continuation sheet')}
        <View style={st.th} fixed>
          {COLS.map((c) => (
            <Text key={c.key} style={[st.thText, { width: c.w, textAlign: c.right ? 'right' : 'left' }]}>{c.label}</Text>
          ))}
        </View>
        {p.rows.map((r, i) => (
          <View key={i} style={st.tr} wrap={false}>
            {COLS.map((c) => (
              <Text key={c.key} style={{ width: c.w, textAlign: c.right ? 'right' : 'left', paddingRight: 4, color: c.key === 'description' ? INK : INK_2 }}>{cell(r, c.key)}</Text>
            ))}
          </View>
        ))}
        <View style={st.total} wrap={false}>
          {COLS.map((c) => (
            <Text key={c.key} style={{ width: c.w, textAlign: c.right ? 'right' : 'left', paddingRight: 4, fontFamily: 'Helvetica-Bold' }}>{cell(p.totals, c.key)}</Text>
          ))}
        </View>
        {p.rows.length > 1 ? (
          <Text style={st.note}>Scheduled values by line are not on file; the contract sum to date is shown on the total.</Text>
        ) : null}
        <Text style={st.footer} fixed>{footer}</Text>
      </Page>
    </Document>
  );
}
