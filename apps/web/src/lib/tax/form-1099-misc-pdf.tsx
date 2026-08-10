import React from 'react';
import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';
import { centsToAmountString, formatEin, type PayerInfo } from './form-1099';
import {
  MISC_BOX_CODES,
  miscBoxAmount,
  miscBoxLabel,
  miscBoxNumber,
  type Form1099MiscBatch,
  type Form1099MiscRecord,
} from './form-1099-misc';

/**
 * Branded 1099-MISC recipient copies (Copy B — "For Recipient"). The MISC sibling of
 * form-1099-pdf.tsx: same light-themed white document, tenant logo + accent color,
 * deterministic built-in fonts — only the boxes differ. Instead of the NEC single
 * Box-1 hero, this renders every MISC box that carries dollars (Rents, Royalties,
 * Other income, Medical, Attorney proceeds) plus Box 4 federal withholding and the
 * state lines. The recipient TIN is TRUNCATED (XXX-XX-1234); the payer EIN is shown
 * in full. This is a readable Copy B for the recipient, NOT the red-ink scannable
 * Copy A the IRS requires for paper filing — Copy A / transmittal comes from the
 * filing service or the FIRE file.
 */

const dollars = (cents: number) => `$${centsToAmountString(cents)}`;

function addressLines(a: {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}): string[] {
  const cityLine = [a.city, a.state].filter(Boolean).join(', ');
  const last = [cityLine, a.zip].filter(Boolean).join(' ');
  return [a.line1, a.line2, last || null].filter(Boolean).map((s) => String(s));
}

function payerAddressLines(p: PayerInfo): string[] {
  const cityLine = [p.city, p.state].filter(Boolean).join(', ');
  const last = [cityLine, p.zip].filter(Boolean).join(' ');
  return [p.addressLine1, p.addressLine2, last || null, p.phone].filter(Boolean).map((s) => String(s));
}

function RecordPage({
  record,
  payer,
  taxYear,
  accent,
  logoUrl,
}: {
  record: Form1099MiscRecord;
  payer: PayerInfo;
  taxYear: number;
  accent: string;
  logoUrl: string | null;
}) {
  const s = StyleSheet.create({
    page: { paddingHorizontal: 46, paddingVertical: 40, fontSize: 9, color: '#1f2328', fontFamily: 'Helvetica' },
    top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 },
    logo: { maxWidth: 150, maxHeight: 48, objectFit: 'contain' },
    entity: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: '#111' },
    title: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: accent, textAlign: 'right' },
    subtitle: { fontSize: 8.5, color: '#6b7178', textAlign: 'right', marginTop: 2 },
    yearPill: { marginTop: 6, alignSelf: 'flex-end', backgroundColor: accent, borderRadius: 4, paddingVertical: 3, paddingHorizontal: 10 },
    yearPillText: { color: '#fff', fontFamily: 'Courier-Bold', fontSize: 11 },
    parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 18 },
    party: { width: '48%' },
    plabel: { fontSize: 7.5, color: accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5, fontFamily: 'Helvetica-Bold' },
    pname: { fontFamily: 'Helvetica-Bold', marginBottom: 2, fontSize: 10.5 },
    pline: { color: '#5f6368', marginBottom: 1 },
    tinRow: { marginTop: 4, flexDirection: 'row' },
    tinK: { fontSize: 7.5, color: '#9aa0a6', marginRight: 6 },
    tinV: { fontFamily: 'Courier-Bold', fontSize: 9 },
    // MISC boxes — a bordered stack of box rows.
    boxWrap: { marginTop: 4, marginBottom: 18, borderWidth: 0.75, borderColor: '#e2e5e9', borderRadius: 5, overflow: 'hidden' },
    boxRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12, borderTopWidth: 0.75, borderTopColor: '#e2e5e9' },
    boxRowFirst: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12 },
    boxKey: { flexDirection: 'row', alignItems: 'center' },
    boxNum: { fontSize: 7.5, color: '#9aa0a6', fontFamily: 'Helvetica-Bold', marginRight: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
    boxLabel: { fontSize: 10, color: '#1f2328' },
    boxAmt: { fontFamily: 'Courier-Bold', fontSize: 13, color: accent },
    grid: { flexDirection: 'row', borderWidth: 0.75, borderColor: '#e2e5e9', borderRadius: 5, overflow: 'hidden', marginBottom: 20 },
    cell: { flex: 1, paddingVertical: 9, paddingHorizontal: 10, borderRightWidth: 0.75, borderRightColor: '#e2e5e9' },
    cellLast: { flex: 1, paddingVertical: 9, paddingHorizontal: 10 },
    cellK: { fontSize: 7, color: '#9aa0a6', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
    cellV: { fontFamily: 'Courier-Bold', fontSize: 10 },
    note: { marginTop: 8, padding: 11, backgroundColor: '#f7f8f9', borderRadius: 4 },
    noteText: { color: '#5f6368', fontSize: 7.5, lineHeight: 1.5 },
    footer: { position: 'absolute', bottom: 26, left: 46, right: 46, fontSize: 7.5, color: '#aab0b6', textAlign: 'center', borderTopWidth: 0.5, borderTopColor: '#edeff2', paddingTop: 8 },
  });

  const state = record.stateLines[0];
  const boxRows = MISC_BOX_CODES.map((code) => ({ code, cents: miscBoxAmount(record.boxAmounts, code) })).filter(
    (b) => b.cents > 0,
  );

  return (
    <Page size="LETTER" style={s.page}>
      <View style={s.top}>
        <View>
          {logoUrl ? <Image src={logoUrl} style={s.logo} /> : <Text style={s.entity}>{payer.name}</Text>}
        </View>
        <View>
          <Text style={s.title}>FORM 1099-MISC</Text>
          <Text style={s.subtitle}>Miscellaneous Information · Copy B — For Recipient</Text>
          <View style={s.yearPill}>
            <Text style={s.yearPillText}>{taxYear}</Text>
          </View>
        </View>
      </View>

      <View style={s.parties}>
        <View style={s.party}>
          <Text style={s.plabel}>Payer</Text>
          <Text style={s.pname}>{payer.name}</Text>
          {payerAddressLines(payer).map((l, i) => (
            <Text key={i} style={s.pline}>{l}</Text>
          ))}
          <View style={s.tinRow}>
            <Text style={s.tinK}>Payer TIN</Text>
            <Text style={s.tinV}>{formatEin(payer.tin)}</Text>
          </View>
        </View>
        <View style={s.party}>
          <Text style={s.plabel}>Recipient</Text>
          <Text style={s.pname}>{record.recipientName}</Text>
          {addressLines(record.address).map((l, i) => (
            <Text key={i} style={s.pline}>{l}</Text>
          ))}
          <View style={s.tinRow}>
            <Text style={s.tinK}>Recipient TIN</Text>
            <Text style={s.tinV}>{record.recipientTinMasked}</Text>
          </View>
        </View>
      </View>

      <View style={s.boxWrap}>
        {boxRows.map((b, i) => (
          <View key={b.code} style={i === 0 ? s.boxRowFirst : s.boxRow}>
            <View style={s.boxKey}>
              <Text style={s.boxNum}>Box {miscBoxNumber(b.code)}</Text>
              <Text style={s.boxLabel}>{miscBoxLabel(b.code)}</Text>
            </View>
            <Text style={s.boxAmt}>{dollars(b.cents)}</Text>
          </View>
        ))}
      </View>

      <View style={s.grid}>
        <View style={s.cell}>
          <Text style={s.cellK}>Box 4 · Federal tax withheld</Text>
          <Text style={s.cellV}>{dollars(record.box4FederalTaxWithheldCents)}</Text>
        </View>
        <View style={s.cell}>
          <Text style={s.cellK}>Box 16 · State tax withheld</Text>
          <Text style={s.cellV}>{state ? dollars(state.box5StateTaxWithheldCents) : '$0.00'}</Text>
        </View>
        <View style={s.cell}>
          <Text style={s.cellK}>Box 17 · State / Payer no.</Text>
          <Text style={s.cellV}>
            {state ? state.box6State + (state.box6PayerStateNo ? ` / ${state.box6PayerStateNo}` : '') : '—'}
          </Text>
        </View>
        <View style={s.cellLast}>
          <Text style={s.cellK}>Box 18 · State income</Text>
          <Text style={s.cellV}>{state ? dollars(state.box7StateIncomeCents) : '—'}</Text>
        </View>
      </View>

      <View style={s.note}>
        <Text style={s.noteText}>
          This is important tax information and is being furnished to the IRS. If you are required to file
          a return, a negligence penalty or other sanction may be imposed on you if this income is taxable
          and the IRS determines that it has not been reported. This copy is provided for your records —
          review the box amounts and report them on the appropriate schedule of your return.
        </Text>
      </View>

      <Text style={s.footer} fixed>
        {payer.name} · {taxYear} Form 1099-MISC (Copy B) · generated by MeritBooks — review with your tax advisor before filing
      </Text>
    </Page>
  );
}

export function Form1099MiscPdf({
  batch,
  accentColor,
  logoUrl,
}: {
  batch: Form1099MiscBatch;
  accentColor?: string | null;
  logoUrl?: string | null;
}) {
  const accent = accentColor || '#10b981';
  return (
    <Document title={`1099-MISC ${batch.summary.taxYear} — ${batch.payer.name}`}>
      {batch.records.map((r) => (
        <RecordPage
          key={r.vendorId}
          record={r}
          payer={batch.payer}
          taxYear={batch.summary.taxYear}
          accent={accent}
          logoUrl={logoUrl ?? null}
        />
      ))}
    </Document>
  );
}
