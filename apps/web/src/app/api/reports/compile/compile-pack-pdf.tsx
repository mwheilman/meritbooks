import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { formatMoney } from '@meritbooks/shared';
import type { StatementModel, StmtColumn, StmtRow } from '@/lib/reports/export/statement-model';
import type { CompiledPack, CompiledSection } from '@/lib/reports/compiler/run';

/**
 * The NL Report Compiler's combined, branded, multi-page PDF. A cover page lists
 * everything in the pack (report + basis + period), then each requested report
 * renders as its own section/page(s). Same white-document, emerald-accent,
 * Helvetica-UI / Courier-numerics styling as the single-statement export and the
 * board package (statement-pdf.tsx / board-package-pdf.tsx) so the pack is
 * indistinguishable from a hand-assembled binder — and every figure ties out to
 * the on-screen reports because it is produced by the same engines.
 */

const ACCENT = '#10b981';

function fmtCell(col: StmtColumn, value: number | string | null): string {
  if (value === null || value === undefined || value === '') return '';
  if (col.money && typeof value === 'number') return formatMoney(value);
  return String(value);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function CompilePackPdf({ pack }: { pack: CompiledPack }) {
  const s = StyleSheet.create({
    page: { paddingHorizontal: 48, paddingTop: 44, paddingBottom: 56, fontSize: 9.5, color: '#1f2328', fontFamily: 'Helvetica' },
    // Cover
    coverWrap: { flexGrow: 1, justifyContent: 'center' },
    coverKicker: { fontSize: 9, textTransform: 'uppercase', letterSpacing: 1.5, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    coverEntity: { fontSize: 26, fontFamily: 'Helvetica-Bold', color: '#111', marginTop: 8 },
    coverTitle: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: ACCENT, marginTop: 4 },
    coverRule: { height: 3, width: 90, backgroundColor: ACCENT, marginTop: 16, marginBottom: 16 },
    coverMeta: { fontSize: 10, color: '#374151', marginTop: 3 },
    tocTitle: { fontSize: 8.5, textTransform: 'uppercase', letterSpacing: 0.8, color: '#6b7178', fontFamily: 'Helvetica-Bold', marginTop: 28, marginBottom: 6 },
    tocRow: { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: '#e3e6e9', alignItems: 'flex-start' },
    tocNum: { width: 22, fontFamily: 'Courier', color: ACCENT, fontSize: 9 },
    tocMain: { flexGrow: 1 },
    tocLabel: { fontSize: 10, color: '#1f2328', fontFamily: 'Helvetica-Bold' },
    tocSub: { fontSize: 8.5, color: '#6b7178', marginTop: 1 },
    tocBasis: { fontSize: 8, color: '#8a9096', textAlign: 'right', width: 120 },
    // Section headings
    header: { marginBottom: 14 },
    entity: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#111' },
    sectionTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: ACCENT, marginTop: 2, letterSpacing: 0.3 },
    metaRow: { flexDirection: 'row', marginTop: 4, flexWrap: 'wrap' },
    meta: { fontSize: 8.5, color: '#6b7178', marginRight: 14 },
    rule: { height: 2, backgroundColor: ACCENT, marginTop: 9, marginBottom: 2 },
    warn: { fontSize: 8.5, color: '#b45309', fontFamily: 'Helvetica-Oblique', marginTop: 6, backgroundColor: '#fef3c7', padding: 5, borderRadius: 3 },
    // Table rows (mirrors statement-pdf.tsx)
    thead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1f2328', paddingBottom: 4, marginBottom: 2, paddingTop: 4 },
    th: { fontSize: 7.5, textTransform: 'uppercase', letterSpacing: 0.6, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 15, paddingVertical: 2 },
    descCell: { flexDirection: 'row', paddingRight: 8 },
    code: { fontFamily: 'Courier', fontSize: 8, color: '#9aa0a6', marginRight: 6, minWidth: 34 },
    label: { flexShrink: 1 },
    valCell: { fontFamily: 'Courier', fontSize: 9, textAlign: 'right', color: '#1f2328' },
    sectionRow: { flexDirection: 'row', backgroundColor: '#f2f4f5', paddingVertical: 3.5, paddingHorizontal: 4, marginTop: 6, borderRadius: 2 },
    sectionLabel: { fontFamily: 'Helvetica-Bold', fontSize: 9, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 },
    sectionVal: { fontFamily: 'Courier-Bold', fontSize: 9, textAlign: 'right', color: '#374151' },
    subtotalRow: { flexDirection: 'row', borderTopWidth: 0.75, borderTopColor: '#c9ced4', paddingVertical: 3, marginTop: 1 },
    subtotalLabel: { fontFamily: 'Helvetica-Bold', fontSize: 9, color: '#1f2328' },
    subtotalVal: { fontFamily: 'Courier-Bold', fontSize: 9, textAlign: 'right', color: '#1f2328' },
    totalRow: { flexDirection: 'row', borderTopWidth: 1.5, borderTopColor: '#1f2328', paddingVertical: 5, marginTop: 3 },
    totalLabel: { fontFamily: 'Helvetica-Bold', fontSize: 10.5, color: '#111' },
    totalVal: { fontFamily: 'Courier-Bold', fontSize: 10.5, textAlign: 'right', color: ACCENT },
    note: { fontSize: 8.5, color: '#8a9096', fontFamily: 'Helvetica-Oblique', marginTop: 6 },
    spacer: { height: 6 },
    // Footer
    footer: { position: 'absolute', bottom: 26, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: '#e3e6e9', paddingTop: 6 },
    footerText: { fontSize: 7.5, color: '#aab0b6' },
  });

  const gen = new Date(pack.meta.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const Footer = () => (
    <View style={s.footer} fixed>
      <Text style={s.footerText}>{pack.meta.entityLabel} · Financial Report Pack</Text>
      <Text style={s.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );

  const renderRow = (model: StatementModel, row: StmtRow, i: number) => {
    const descPct = 58;
    const valPct = (100 - descPct) / model.columns.length;
    if (row.kind === 'spacer') return <View key={i} style={s.spacer} />;
    if (row.kind === 'note') return <Text key={i} style={s.note}>{row.label}</Text>;
    const cells = model.columns.map((col, ci) => fmtCell(col, row.values[ci] ?? null));

    if (row.kind === 'section') {
      return (
        <View key={i} style={s.sectionRow} wrap={false}>
          <Text style={[s.sectionLabel, { width: `${descPct}%` }]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.sectionVal, { width: `${valPct}%` }]}>{c}</Text>)}
        </View>
      );
    }
    if (row.kind === 'subtotal') {
      return (
        <View key={i} style={s.subtotalRow} wrap={false}>
          <Text style={[s.subtotalLabel, { width: `${descPct}%` }]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.subtotalVal, { width: `${valPct}%` }]}>{c}</Text>)}
        </View>
      );
    }
    if (row.kind === 'total') {
      return (
        <View key={i} style={s.totalRow} wrap={false}>
          <Text style={[s.totalLabel, { width: `${descPct}%` }]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.totalVal, { width: `${valPct}%` }]}>{c}</Text>)}
        </View>
      );
    }
    const indent = (row.indent ?? 0) * 12;
    return (
      <View key={i} style={s.row} wrap={false}>
        <View style={[s.descCell, { width: `${descPct}%` }]}>
          <View style={{ width: indent }} />
          {row.code ? <Text style={s.code}>{row.code}</Text> : null}
          <Text style={s.label}>{row.label}</Text>
        </View>
        {cells.map((c, ci) => <Text key={ci} style={[s.valCell, { width: `${valPct}%` }]}>{c}</Text>)}
      </View>
    );
  };

  const SectionPage = ({ section }: { section: CompiledSection }) => {
    const model = section.model;
    const descPct = 58;
    const valPct = (100 - descPct) / model.columns.length;
    return (
      <Page size="LETTER" style={s.page}>
        <View style={s.header}>
          <Text style={s.entity}>{pack.meta.entityLabel}</Text>
          <Text style={s.sectionTitle}>{model.title}</Text>
          <View style={s.metaRow}>
            <Text style={s.meta}>{model.periodLabel}</Text>
            {model.basisLabel ? <Text style={s.meta}>{model.basisLabel}</Text> : null}
          </View>
          <View style={s.rule} />
        </View>
        {section.warning ? <Text style={s.warn}>{section.warning}</Text> : null}
        <View style={s.thead} fixed>
          <Text style={[s.th, { width: `${descPct}%` }]}>Description</Text>
          {model.columns.map((col, ci) => (
            <Text key={ci} style={[s.th, { width: `${valPct}%`, textAlign: 'right' }]}>{col.label}</Text>
          ))}
        </View>
        {model.rows.map((r, i) => renderRow(model, r, i))}
        <Footer />
      </Page>
    );
  };

  return (
    <Document title={`Financial Report Pack — ${pack.meta.entityLabel}`}>
      {/* ── Cover ── */}
      <Page size="LETTER" style={s.page}>
        <View style={s.coverWrap}>
          <Text style={s.coverKicker}>Financial Report Pack</Text>
          <Text style={s.coverEntity}>{pack.meta.entityLabel}</Text>
          <Text style={s.coverTitle}>{pack.cover.title}</Text>
          <View style={s.coverRule} />
          <Text style={s.coverMeta}>Reports included: {pack.sections.length}</Text>
          <Text style={s.coverMeta}>Generated: {gen}</Text>

          <Text style={s.tocTitle}>Contents</Text>
          {pack.cover.contents.map((c, i) => (
            <View key={i} style={s.tocRow}>
              <Text style={s.tocNum}>{pad(i + 1)}</Text>
              <View style={s.tocMain}>
                <Text style={s.tocLabel}>{c.report}</Text>
                <Text style={s.tocSub}>{c.periodLabel}</Text>
              </View>
              {c.basisLabel ? <Text style={s.tocBasis}>{c.basisLabel}</Text> : <Text style={s.tocBasis} />}
            </View>
          ))}
        </View>
        <Footer />
      </Page>

      {/* ── One page (section) per report × period ── */}
      {pack.sections.map((section, i) => <SectionPage key={i} section={section} />)}
    </Document>
  );
}
