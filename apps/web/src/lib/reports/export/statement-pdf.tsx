import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { formatMoney } from '@meritbooks/shared';
import type { StatementModel, StmtColumn, StmtRow } from './statement-model';

/**
 * Branded financial-statement PDF (FPB Dimension 7, AC7.1). A white document —
 * this leaves the app to a lender / board / tax preparer, who expects a clean
 * white statement, exactly like the invoice PDFs (invoice-pdf.tsx). Emerald
 * accent (design-system #10b981, overridable per model). Deterministic: uses
 * only react-pdf's built-in fonts (no network fetch) — figures are set in
 * Courier (a built-in monospace) to honor "monospaced numerics"; JetBrains Mono
 * would require registering a network/bundled font file, which we deliberately
 * avoid for offline determinism (same rationale as the invoice renderer).
 */

const DEFAULT_ACCENT = '#10b981';

function fmtCell(col: StmtColumn, value: number | string | null): string {
  if (value === null || value === undefined || value === '') return '';
  if (col.money && typeof value === 'number') return formatMoney(value);
  return String(value);
}

export function StatementPdf({ model }: { model: StatementModel }) {
  const accent = model.accent || DEFAULT_ACCENT;
  const nCols = model.columns.length;
  // Description column shrinks as more numeric columns appear.
  const descPct = nCols >= 3 ? 46 : nCols === 2 ? 54 : 62;
  const valPct = (100 - descPct) / nCols;

  const s = StyleSheet.create({
    page: { paddingHorizontal: 48, paddingTop: 44, paddingBottom: 56, fontSize: 9.5, color: '#1f2328', fontFamily: 'Helvetica' },
    header: { marginBottom: 16 },
    entity: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: '#111' },
    title: { fontSize: 22, fontFamily: 'Helvetica-Bold', color: accent, marginTop: 2, letterSpacing: 0.3 },
    metaRow: { flexDirection: 'row', marginTop: 6, flexWrap: 'wrap' },
    meta: { fontSize: 8.5, color: '#6b7178', marginRight: 14 },
    rule: { height: 2, backgroundColor: accent, marginTop: 10, marginBottom: 2 },

    thead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1f2328', paddingBottom: 4, marginBottom: 2, paddingTop: 4 },
    th: { fontSize: 7.5, textTransform: 'uppercase', letterSpacing: 0.6, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    thDesc: { fontSize: 7.5, textTransform: 'uppercase', letterSpacing: 0.6, color: '#6b7178', fontFamily: 'Helvetica-Bold' },

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
    totalVal: { fontFamily: 'Courier-Bold', fontSize: 10.5, textAlign: 'right', color: accent },

    note: { fontSize: 8.5, color: '#8a9096', fontFamily: 'Helvetica-Oblique', marginTop: 6 },
    spacer: { height: 6 },

    footer: { position: 'absolute', bottom: 26, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: '#e3e6e9', paddingTop: 6 },
    footerText: { fontSize: 7.5, color: '#aab0b6' },
  });

  const descStyle = { width: `${descPct}%` } as const;
  const valStyle = { width: `${valPct}%` } as const;

  const renderRow = (row: StmtRow, i: number) => {
    if (row.kind === 'spacer') return <View key={i} style={s.spacer} />;
    if (row.kind === 'note') return <Text key={i} style={s.note}>{row.label}</Text>;

    const cells = model.columns.map((col, ci) => fmtCell(col, row.values[ci] ?? null));

    if (row.kind === 'section') {
      return (
        <View key={i} style={s.sectionRow} wrap={false}>
          <Text style={[s.sectionLabel, descStyle]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.sectionVal, valStyle]}>{c}</Text>)}
        </View>
      );
    }
    if (row.kind === 'subtotal') {
      return (
        <View key={i} style={s.subtotalRow} wrap={false}>
          <Text style={[s.subtotalLabel, descStyle]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.subtotalVal, valStyle]}>{c}</Text>)}
        </View>
      );
    }
    if (row.kind === 'total') {
      return (
        <View key={i} style={s.totalRow} wrap={false}>
          <Text style={[s.totalLabel, descStyle]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.totalVal, valStyle]}>{c}</Text>)}
        </View>
      );
    }
    // account
    const indent = (row.indent ?? 0) * 12;
    return (
      <View key={i} style={s.row} wrap={false}>
        <View style={[s.descCell, descStyle]}>
          <View style={{ width: indent }} />
          {row.code ? <Text style={s.code}>{row.code}</Text> : null}
          <Text style={s.label}>{row.label}</Text>
        </View>
        {cells.map((c, ci) => <Text key={ci} style={[s.valCell, valStyle]}>{c}</Text>)}
      </View>
    );
  };

  return (
    <Document title={`${model.title} — ${model.entityLabel}`}>
      <Page size="LETTER" style={s.page}>
        <View style={s.header}>
          {model.entityLabel ? <Text style={s.entity}>{model.entityLabel}</Text> : null}
          <Text style={s.title}>{model.title}</Text>
          <View style={s.metaRow}>
            {model.periodLabel ? <Text style={s.meta}>{model.periodLabel}</Text> : null}
            {model.basisLabel ? <Text style={s.meta}>{model.basisLabel}</Text> : null}
            <Text style={s.meta}>Generated {new Date(model.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</Text>
          </View>
          <View style={s.rule} />
        </View>

        <View style={s.thead} fixed>
          <Text style={[s.thDesc, descStyle]}>Description</Text>
          {model.columns.map((col, ci) => <Text key={ci} style={[s.th, valStyle, { textAlign: 'right' }]}>{col.label}</Text>)}
        </View>

        {model.rows.map(renderRow)}

        <View style={s.footer} fixed>
          <Text style={s.footerText}>{model.entityLabel} · {model.title}</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
