import React from 'react';
import { Document, Font, Page, Text, View, Image, Link, Svg, Path, Rect, StyleSheet } from '@react-pdf/renderer';
import type { InvoiceDoc } from './invoice-doc';
import { buildLineTable, columnWidths, type LineTable } from './templates/columns';
import type { InvoiceFont, InvoiceLayout } from './templates/types';
import { encodeQr, qrSvgPath } from '@/lib/qr/qr-code';

/**
 * Customer invoice PDF (FPB-invoices §2 + §4 Slice 1B), driven entirely by the
 * resolved design template:
 *   - layout variant  MODERN · CLASSIC · MINIMAL · BOLD · COMPACT (masthead + rhythm)
 *   - font            SANS (Helvetica) · SERIF (Times) — built-in faces, no network,
 *                     so the same invoice + template renders identical bytes
 *   - brand colour, logo, remit-to, footer
 *   - visible line columns + custom line fields (templates/columns.ts)
 *   - header / footer custom fields, terms, payment instructions
 *   - pay URL + QR code ONLY when the invoice can really be paid online (pay-link.ts);
 *     otherwise the payment instructions print instead — never a dead link
 *   - PAID / VOID stamp by status
 * NO internal GL account numbers or names print (AC-1B.1).
 */

// Never hyphenate on a customer document ("Cabi- netry"): wrap whole words only.
Font.registerHyphenationCallback((word) => [word]);

/** @deprecated use InvoiceLayout */
export type InvoiceStyle = InvoiceLayout;

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: string) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const fmtAddress = (a: Record<string, unknown> | null): string[] => {
  if (!a) return [];
  const out: string[] = [];
  for (const k of ['attn', 'line1', 'line2', 'street', 'city_state_zip', 'city', 'state', 'zip', 'country']) {
    const v = a[k];
    if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
};

/** Black or white text, whichever reads on the brand colour. */
function onColor(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#0A1628' : '#FFFFFF';
}

interface Faces { regular: string; bold: string; italic: string }
const FACES: Record<InvoiceFont, Faces> = {
  SANS: { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' },
  SERIF: { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic' },
};

interface Look {
  pad: number;
  base: number;        // body font size
  rowPad: number;      // table row vertical padding
  headFill: boolean;   // table header filled with the brand colour
}
const LOOK: Record<InvoiceLayout, Look> = {
  MODERN: { pad: 48, base: 9.5, rowPad: 7, headFill: true },
  CLASSIC: { pad: 54, base: 10, rowPad: 7, headFill: false },
  MINIMAL: { pad: 54, base: 9, rowPad: 8, headFill: false },
  BOLD: { pad: 48, base: 9.5, rowPad: 7, headFill: false },
  COMPACT: { pad: 40, base: 8.5, rowPad: 4, headFill: false },
};

const INK = '#0A1628';
const INK_2 = '#3D4F65';
const MUTED = '#8494A7';
const RULE = '#E3E1DC';

interface TotalRow { label: string; value: string }
function totalRows(doc: InvoiceDoc): TotalRow[] {
  const rows: TotalRow[] = [{ label: 'Subtotal', value: money(doc.subtotal_cents) }];
  if (doc.discount_cents > 0) rows.push({ label: 'Discount', value: `-${money(doc.discount_cents)}` });
  if (doc.tax_cents > 0) rows.push({ label: 'Sales tax', value: money(doc.tax_cents) });
  if (doc.retainage_cents > 0) rows.push({ label: 'Retainage withheld', value: `-${money(doc.retainage_cents)}` });
  return rows;
}

/** The QR code as vector squares (crisp at any print size). */
function QrCode({ url, size }: { url: string; size: number }) {
  const { viewBox, d } = qrSvgPath(encodeQr(url, { ecc: 'M' }), { quiet: 2 });
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${viewBox} ${viewBox}`}>
      <Rect x={0} y={0} width={viewBox} height={viewBox} fill="#FFFFFF" />
      <Path d={d} fill={INK} />
    </Svg>
  );
}

function stampFor(status: string): string | null {
  if (status === 'PAID') return 'PAID';
  if (status === 'VOIDED') return 'VOID';
  if (status === 'WRITTEN_OFF') return 'WRITTEN OFF';
  return null;
}

export function InvoicePdf({ doc, style }: { doc: InvoiceDoc; style?: InvoiceLayout }) {
  const t = doc.template;
  const layout: InvoiceLayout = style ?? t.style;
  const look = LOOK[layout];
  const f = FACES[t.font];
  const accent = t.accent_color;
  const onAccent = onColor(accent);
  const table: LineTable = buildLineTable(doc.lines, t, { jobLabel: doc.job_label });
  const widths = columnWidths(table.columns);
  const bill = fmtAddress(doc.bill_to);
  const headerFields = t.custom_fields.filter((x) => x.placement === 'HEADER' && x.value.trim());
  const footerFields = t.custom_fields.filter((x) => x.placement === 'FOOTER' && x.value.trim());
  // Belt and braces: even if a caller hands in a stale pay state, a paid / voided /
  // written-off invoice (or one with no balance) never prints a pay link.
  const open = doc.balance_cents > 0 && !['PAID', 'VOIDED', 'WRITTEN_OFF'].includes(doc.status);
  const showPay = open && doc.pay.payable && (t.show_qr || t.show_pay_button) && !!doc.pay.url;
  const stamp = stampFor(doc.status);
  const bandHeader = layout === 'BOLD';

  const st = StyleSheet.create({
    page: {
      paddingHorizontal: look.pad, paddingTop: bandHeader ? 0 : look.pad, paddingBottom: look.pad + 24,
      fontSize: look.base, color: INK, fontFamily: f.regular,
    },
    band: { marginHorizontal: -look.pad, paddingHorizontal: look.pad, paddingTop: 40, paddingBottom: 26, backgroundColor: accent, marginBottom: 24 },
    logo: { maxWidth: 160, maxHeight: 50, objectFit: 'contain' },
    entity: { fontSize: layout === 'COMPACT' ? 13 : 16, fontFamily: f.bold },
    title: { fontSize: layout === 'COMPACT' ? 13 : layout === 'MINIMAL' ? 9 : 26, fontFamily: f.bold, letterSpacing: layout === 'MINIMAL' ? 3 : 1.5, color: bandHeader ? onAccent : accent },
    metaRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 1.5 },
    metaK: { color: bandHeader ? onAccent : MUTED, width: 70, textAlign: 'right', marginRight: 8, fontSize: look.base - 1 },
    metaV: { fontFamily: f.bold, color: bandHeader ? onAccent : INK, minWidth: 70, textAlign: 'right' },
    parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
    party: { width: '48%' },
    plabel: { fontSize: 7.5, color: layout === 'CLASSIC' ? INK_2 : accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4, fontFamily: f.bold },
    pname: { fontFamily: f.bold, marginBottom: 2, fontSize: look.base + 1 },
    pline: { color: INK_2, marginBottom: 1 },
    thead: {
      flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 6,
      ...(look.headFill ? { backgroundColor: accent } : { borderBottomWidth: layout === 'BOLD' ? 2 : 1, borderBottomColor: layout === 'BOLD' ? accent : INK }),
      ...(layout === 'CLASSIC' ? { borderTopWidth: 1, borderTopColor: INK } : {}),
    },
    th: { fontSize: 7.5, textTransform: 'uppercase', letterSpacing: 0.6, fontFamily: f.bold, color: look.headFill ? onAccent : INK_2 },
    row: { flexDirection: 'row', paddingVertical: look.rowPad, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: RULE },
    totals: { marginTop: 12, alignSelf: 'flex-end', width: '44%' },
    tline: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2.5 },
    tmuted: { color: INK_2 },
    grand: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4, paddingTop: 6, borderTopWidth: 1, borderTopColor: INK },
    gl: { fontFamily: f.bold, fontSize: look.base + 1.5 },
    balance: { marginTop: 10, backgroundColor: accent, paddingVertical: 10, paddingHorizontal: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    balK: { color: onAccent, fontSize: 8.5, textTransform: 'uppercase', letterSpacing: 1 },
    balV: { color: onAccent, fontSize: 15, fontFamily: f.bold },
    payBox: { marginTop: 22, borderWidth: 1, borderColor: accent, padding: 12, flexDirection: 'row', alignItems: 'center' },
    payText: { flexGrow: 1, flexShrink: 1, paddingRight: 12 },
    payTitle: { fontFamily: f.bold, fontSize: look.base + 2, marginBottom: 3 },
    payLine: { color: INK_2, lineHeight: 1.4 },
    payUrl: { color: accent, fontFamily: f.bold, marginTop: 4, textDecoration: 'none' },
    block: { marginTop: 16 },
    blockK: { fontSize: 7.5, color: MUTED, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 3, fontFamily: f.bold },
    blockV: { color: INK_2, lineHeight: 1.45 },
    msg: { marginTop: 18, color: INK_2, lineHeight: 1.45, ...(layout === 'CLASSIC' ? { fontFamily: f.italic, textAlign: 'center' } : {}) },
    footer: { position: 'absolute', bottom: 26, left: look.pad, right: look.pad, fontSize: 7.5, color: MUTED, textAlign: 'center', borderTopWidth: 0.5, borderTopColor: RULE, paddingTop: 7 },
    stamp: { position: 'absolute', top: 300, left: 0, right: 0, textAlign: 'center', fontSize: 96, fontFamily: f.bold, color: stamp === 'PAID' ? '#2E7D5B' : '#B42318', opacity: 0.12, transform: 'rotate(-20deg)' },
    leftRule: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: accent },
  });

  const meta: Array<[string, string]> = [
    ['Invoice no.', doc.invoice_number],
    ['Date', fmtDate(doc.invoice_date)],
    ['Due', fmtDate(doc.due_date)],
  ];
  if (doc.terms_label) meta.push(['Terms', doc.terms_label]);
  if (doc.po_number) meta.push(['PO', doc.po_number]);
  for (const h of headerFields) meta.push([h.label, h.value]);

  const brand = t.logo_url
    ? <Image src={t.logo_url} style={st.logo} />
    : <Text style={[st.entity, bandHeader ? { color: onAccent } : {}]}>{doc.entity?.name || 'Invoice'}</Text>;

  const Masthead = (
    <View style={bandHeader ? st.band : { marginBottom: 26, ...(layout === 'CLASSIC' ? { borderTopWidth: 2.5, borderBottomWidth: 0.75, borderColor: INK, paddingVertical: 12 } : {}), ...(layout === 'COMPACT' ? { borderBottomWidth: 2, borderBottomColor: accent, paddingBottom: 8 } : {}) }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ maxWidth: '50%' }}>
          {brand}
          {t.logo_url ? <Text style={{ marginTop: 6, fontFamily: f.bold, color: bandHeader ? onAccent : INK }}>{doc.entity?.name ?? ''}</Text> : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={st.title}>{layout === 'COMPACT' ? `INVOICE ${doc.invoice_number}` : 'INVOICE'}</Text>
          <View style={{ marginTop: 8 }}>
            {meta.map(([k, v], i) => (
              <View key={i} style={st.metaRow}><Text style={st.metaK}>{k}</Text><Text style={st.metaV}>{v}</Text></View>
            ))}
          </View>
        </View>
      </View>
    </View>
  );

  return (
    <Document title={`Invoice ${doc.invoice_number}`} author={doc.entity?.name ?? undefined}>
      <Page size="LETTER" style={st.page}>
        {layout === 'MINIMAL' ? <View style={st.leftRule} fixed /> : null}
        {stamp ? <Text style={st.stamp} fixed>{stamp}</Text> : null}
        {Masthead}

        <View style={st.parties}>
          <View style={st.party}>
            <Text style={st.plabel}>Bill to</Text>
            <Text style={st.pname}>{doc.customer?.name || '—'}</Text>
            {bill.map((l, i) => <Text key={i} style={st.pline}>{l}</Text>)}
            {doc.customer?.email ? <Text style={st.pline}>{doc.customer.email}</Text> : null}
          </View>
          <View style={st.party}>
            <Text style={st.plabel}>{layout === 'CLASSIC' ? 'Remit to' : 'From'}</Text>
            <Text style={st.pname}>{doc.entity?.name || ''}</Text>
            {t.remit_to ? t.remit_to.split('\n').map((l, i) => <Text key={i} style={st.pline}>{l}</Text>) : null}
          </View>
        </View>

        <View style={st.thead} fixed>
          {table.columns.map((c, i) => (
            <Text key={c.key} style={[st.th, { width: widths[i], textAlign: c.align, paddingRight: c.align === 'left' ? 6 : 0 }]}>{c.label}</Text>
          ))}
        </View>
        {table.rows.map((r, ri) => (
          <View key={ri} style={st.row} wrap={false}>
            {table.columns.map((c, i) => (
              <Text key={c.key} style={{ width: widths[i], textAlign: c.align, paddingRight: c.align === 'left' ? 6 : 0, color: c.key === 'description' || c.key === 'amount' ? INK : INK_2 }}>
                {r.cells[c.key]}
              </Text>
            ))}
          </View>
        ))}

        <View style={st.totals} wrap={false}>
          {totalRows(doc).map((r, i) => <View key={i} style={st.tline}><Text style={st.tmuted}>{r.label}</Text><Text>{r.value}</Text></View>)}
          <View style={st.grand}><Text style={st.gl}>Total</Text><Text style={st.gl}>{money(doc.total_cents)}</Text></View>
          {doc.amount_paid_cents > 0 ? <View style={st.tline}><Text style={st.tmuted}>Paid</Text><Text>-{money(doc.amount_paid_cents)}</Text></View> : null}
          <View style={st.balance}><Text style={st.balK}>Balance due</Text><Text style={st.balV}>{money(doc.balance_cents)}</Text></View>
        </View>

        {showPay ? (
          <View style={st.payBox} wrap={false}>
            <View style={st.payText}>
              <Text style={st.payTitle}>Pay online</Text>
              <Text style={st.payLine}>
                {doc.pay.methods.includes('CARD') && doc.pay.methods.includes('ACH')
                  ? 'Pay by bank transfer or card.'
                  : doc.pay.methods.includes('CARD') ? 'Pay by card.' : 'Pay by bank transfer.'}
                {t.show_qr ? ' Scan the code with your phone camera, or go to:' : ' Go to:'}
              </Text>
              <Link src={doc.pay.url} style={st.payUrl}>{doc.pay.url}</Link>
              {t.payment_instructions ? <Text style={[st.payLine, { marginTop: 8 }]}>Other ways to pay: {t.payment_instructions}</Text> : null}
            </View>
            {t.show_qr ? <QrCode url={doc.pay.url} size={84} /> : null}
          </View>
        ) : t.payment_instructions ? (
          <View style={st.block} wrap={false}>
            <Text style={st.blockK}>How to pay</Text>
            <Text style={st.blockV}>{t.payment_instructions}</Text>
          </View>
        ) : null}

        {t.terms_text ? (
          <View style={st.block} wrap={false}>
            <Text style={st.blockK}>Terms</Text>
            <Text style={st.blockV}>{t.terms_text}</Text>
          </View>
        ) : null}

        {doc.customer_message ? <Text style={st.msg}>{doc.customer_message}</Text> : null}

        <View style={st.footer} fixed>
          {footerFields.length ? (
            <Text>{footerFields.map((x) => `${x.label}: ${x.value}`).join('   ·   ')}</Text>
          ) : null}
          <Text>{t.footer_text || `${doc.entity?.name ?? ''} · Invoice ${doc.invoice_number}`}</Text>
        </View>
      </Page>
    </Document>
  );
}
