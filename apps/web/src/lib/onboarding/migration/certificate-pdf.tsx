import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { CertificateTie } from './types';
import { dollars, longDate } from './format';

/**
 * The Conversion Certificate PDF (spec §10.7). A white document that leaves the app (lender,
 * partner, auditor). Merit palette: Electric #2563EB rules, Midnight #0A1628 ink. Built-in
 * Helvetica only (no network fonts — deterministic, like the statement PDFs). Prints the
 * certificate number, both signatures, the five ties, the sources with their file hashes,
 * the data-quality decisions and the content hash.
 */

export interface CertificatePdfModel {
  number: string;
  version: number;
  status: 'prepared' | 'issued' | 'voided';
  clientName: string;
  clientCode: string;
  tenantName: string;
  cutoverDate: string;
  historyDepthLabel: string;
  preparedBy: string;
  preparedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  voidReason: string | null;
  contentHash: string;
  ties: CertificateTie[];
  sources: Array<{ name: string; role: string; files: Array<{ file: string | null; sha256: string | null; parser: string | null; entity: string | null }> }>;
  dispositions: Array<{ name: string; severity: string; amountCents: number; disposition: string; note: string | null }>;
  mapping: { accounts: number; accepted: number; typeExceptions: Array<{ account: string; reason: string | null }> };
  practiceClose: string;
}

const ELECTRIC = '#2563EB';
const MIDNIGHT = '#0A1628';
const STEEL = '#3D4F65';
const LINE = '#D8DEE6';

const s = StyleSheet.create({
  page: { paddingHorizontal: 48, paddingTop: 44, paddingBottom: 56, fontSize: 9.5, color: MIDNIGHT, fontFamily: 'Helvetica' },
  eyebrow: { fontSize: 7.5, letterSpacing: 1.2, color: STEEL, textTransform: 'uppercase', fontFamily: 'Helvetica-Bold' },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', marginTop: 4 },
  sub: { fontSize: 10, color: STEEL, marginTop: 4 },
  rule: { height: 2, backgroundColor: ELECTRIC, marginTop: 12, marginBottom: 10 },
  thin: { height: 0.5, backgroundColor: LINE, marginVertical: 6 },
  kvRow: { flexDirection: 'row', marginBottom: 3 },
  k: { width: 130, color: STEEL },
  v: { flex: 1 },
  section: { marginTop: 14, fontSize: 7.5, letterSpacing: 1.2, color: ELECTRIC, textTransform: 'uppercase', fontFamily: 'Helvetica-Bold' },
  tieHead: { flexDirection: 'row', marginTop: 8, alignItems: 'baseline' },
  tieLabel: { fontFamily: 'Helvetica-Bold', fontSize: 10, width: 110 },
  tieStatus: { width: 90, fontFamily: 'Helvetica-Bold' },
  tieSummary: { flex: 1, color: STEEL },
  row: { flexDirection: 'row', paddingVertical: 1.5 },
  cellL: { flex: 1, paddingLeft: 110 },
  cellN: { width: 80, textAlign: 'right' },
  small: { fontSize: 8, color: STEEL },
  sig: { flexDirection: 'row', marginTop: 18 },
  sigBox: { flex: 1, borderTopWidth: 1, borderTopColor: MIDNIGHT, paddingTop: 4, marginRight: 24 },
  footer: { position: 'absolute', bottom: 26, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: LINE, paddingTop: 6 },
  footerText: { fontSize: 7, color: '#8494A7' },
  watermark: { position: 'absolute', top: 330, left: 40, right: 40, textAlign: 'center', fontSize: 46, fontFamily: 'Helvetica-Bold', color: '#d1d5db', opacity: 0.45, transform: 'rotate(-30deg)' },
});

const STATUS_WORD: Record<CertificateTie['status'], string> = { tied: 'Ties', difference: 'Difference', not_applicable: 'Not applicable', waiting: 'Waiting' };
const EVIDENCE_WORD: Record<CertificateTie['evidence'], string> = { evidenced: 'Evidenced', internal_only: 'Internal only', not_applicable: '' };
const DISPO: Record<string, string> = {
  open: 'Open',
  fixed_in_source: 'Fixed in the old system',
  carry_as_reconciling_item: 'Carried as one reconciling item',
  accepted_with_note: 'Accepted',
  not_applicable: 'Not applicable',
};

const paren = (c: number) => (c < 0 ? `(${dollars(-c).slice(1)})` : dollars(c).slice(1));
const when = (iso: string | null) => (iso ? `${longDate(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC` : '—');

export function ConversionCertificatePdf({ m }: { m: CertificatePdfModel }) {
  return (
    <Document title={`Conversion Certificate ${m.number} — ${m.clientName}`} author="MeritBooks">
      <Page size="LETTER" style={s.page}>
        {m.status !== 'issued' && <Text style={s.watermark}>{m.status === 'voided' ? 'VOIDED' : 'NOT YET SIGNED OFF'}</Text>}
        <Text style={s.eyebrow}>01 // Conversion certificate · {m.number}{m.version > 1 ? ` · version ${m.version}` : ''}</Text>
        <Text style={s.title}>{m.clientName}</Text>
        <Text style={s.sub}>The old books minus MeritBooks is zero at the cutover, proved account by account and signed by two people.</Text>
        <View style={s.rule} />
        <View style={s.kvRow}><Text style={s.k}>Client</Text><Text style={s.v}>{m.clientName} ({m.clientCode}) · kept by {m.tenantName}</Text></View>
        <View style={s.kvRow}><Text style={s.k}>Cutover</Text><Text style={s.v}>{longDate(m.cutoverDate)} — MeritBooks is the book of record from the next day</Text></View>
        <View style={s.kvRow}><Text style={s.k}>History</Text><Text style={s.v}>{m.historyDepthLabel}</Text></View>
        <View style={s.kvRow}><Text style={s.k}>Practice close</Text><Text style={s.v}>{m.practiceClose}</Text></View>
        <View style={s.kvRow}><Text style={s.k}>Accounts matched</Text><Text style={s.v}>{m.mapping.accepted} of {m.mapping.accounts}{m.mapping.typeExceptions.length ? ` · ${m.mapping.typeExceptions.length} across account types, with reasons` : ''}</Text></View>
        {m.voidReason && <View style={s.kvRow}><Text style={s.k}>Voided</Text><Text style={s.v}>{m.voidReason}</Text></View>}

        <Text style={s.section}>02 // The five ties</Text>
        {m.ties.map((t) => (
          <View key={t.key} wrap={false}>
            <View style={s.tieHead}>
              <Text style={s.tieLabel}>{t.label}</Text>
              <Text style={s.tieStatus}>{STATUS_WORD[t.status]}{EVIDENCE_WORD[t.evidence] ? ` · ${EVIDENCE_WORD[t.evidence]}` : ''}</Text>
              <Text style={s.tieSummary}>{t.summary}</Text>
            </View>
            {t.lines.slice(0, 8).map((l, i) => (
              <View key={i} style={s.row}>
                <Text style={[s.cellL, s.small]}>{l.label}</Text>
                <Text style={[s.cellN, s.small]}>{paren(l.sourceCents)}</Text>
                <Text style={[s.cellN, s.small]}>{paren(l.meritCents)}</Text>
                <Text style={[s.cellN, s.small]}>{l.differenceCents === 0 ? '—' : paren(l.differenceCents)}</Text>
              </View>
            ))}
          </View>
        ))}
        <Text style={[s.small, { marginTop: 4 }]}>Columns: old books · MeritBooks · difference. Negative figures in parentheses.</Text>

        <Text style={s.section}>03 // Data-quality decisions</Text>
        {m.dispositions.length === 0 ? <Text style={s.small}>Every check passed or did not apply.</Text> : m.dispositions.map((d, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Text style={{ width: 200 }}>{d.name}</Text>
            <Text style={{ width: 60, color: STEEL }}>{d.severity}</Text>
            <Text style={{ width: 80, textAlign: 'right' }}>{d.amountCents ? dollars(d.amountCents) : '—'}</Text>
            <Text style={{ flex: 1, paddingLeft: 10, color: STEEL }}>{DISPO[d.disposition] ?? d.disposition}{d.note ? ` — ${d.note}` : ''}</Text>
          </View>
        ))}
        {m.mapping.typeExceptions.map((x, i) => (
          <Text key={i} style={s.small}>Across account types: {x.account} — {x.reason ?? ''}</Text>
        ))}

        <Text style={s.section}>04 // Sources (MeritBooks only read them)</Text>
        {m.sources.map((src, i) => (
          <View key={i} wrap={false} style={{ marginTop: 3 }}>
            <Text>{src.name} <Text style={s.small}>· {src.role.replace('_', ' ')}</Text></Text>
            {src.files.map((f, j) => (
              <Text key={j} style={s.small}>  {f.file ?? 'Read-only API pull'} · {f.entity ?? ''} · {f.parser ?? ''}{f.sha256 ? ` · sha256 ${f.sha256.slice(0, 16)}…` : ''}</Text>
            ))}
          </View>
        ))}

        <View style={s.sig} wrap={false}>
          <View style={s.sigBox}>
            <Text style={s.eyebrow}>Prepared — balance proof signed</Text>
            <Text style={{ marginTop: 3 }}>{m.preparedBy}</Text>
            <Text style={s.small}>{when(m.preparedAt)}</Text>
          </View>
          <View style={s.sigBox}>
            <Text style={s.eyebrow}>Signed off — a different person</Text>
            <Text style={{ marginTop: 3 }}>{m.approvedBy ?? 'Waiting for the reviewer'}</Text>
            <Text style={s.small}>{when(m.approvedAt)}</Text>
          </View>
        </View>

        <View style={s.footer} fixed>
          <Text style={s.footerText}>{m.number} · sha256 {m.contentHash}</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
