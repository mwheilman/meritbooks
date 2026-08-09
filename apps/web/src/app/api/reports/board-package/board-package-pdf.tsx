import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { formatMoney } from '@meritbooks/shared';
import { buildIncomeStatement, buildBalanceSheet, buildCashFlow, type ExportMeta } from '@/lib/reports/export/build-model';
import type { StatementModel, StmtRow } from '@/lib/reports/export/statement-model';
import type { BoardPackage } from '@/lib/reports/board-package';

/**
 * Branded Board Package PDF (multi-page). Reuses the SAME @react-pdf branding
 * approach as the single-statement export (statement-pdf.tsx): white document,
 * emerald accent, Helvetica UI / Courier numerics, LETTER size, page footer. The
 * three core statements are converted to the shared StatementModel via the
 * EXISTING builders (build-model.ts) so the package figures tie out exactly to
 * the on-screen statements. Nothing is recomputed here — presentation only.
 */

const DEFAULT_ACCENT = '#10b981';

export function BoardPackagePdf({ pkg }: { pkg: BoardPackage }) {
  const accent = pkg.meta.accent || DEFAULT_ACCENT;

  const s = StyleSheet.create({
    page: { paddingHorizontal: 48, paddingTop: 44, paddingBottom: 56, fontSize: 9.5, color: '#1f2328', fontFamily: 'Helvetica' },
    // Cover
    coverWrap: { flexGrow: 1, justifyContent: 'center' },
    coverKicker: { fontSize: 9, textTransform: 'uppercase', letterSpacing: 1.5, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    coverEntity: { fontSize: 26, fontFamily: 'Helvetica-Bold', color: '#111', marginTop: 8 },
    coverTitle: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: accent, marginTop: 4 },
    coverRule: { height: 3, width: 90, backgroundColor: accent, marginTop: 16, marginBottom: 16 },
    coverMeta: { fontSize: 10, color: '#374151', marginTop: 3 },
    tocTitle: { fontSize: 8.5, textTransform: 'uppercase', letterSpacing: 0.8, color: '#6b7178', fontFamily: 'Helvetica-Bold', marginTop: 28, marginBottom: 6 },
    tocRow: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: '#e3e6e9' },
    tocNum: { width: 22, fontFamily: 'Courier', color: accent },
    tocLabel: { fontSize: 10, color: '#1f2328' },
    // Section headings
    header: { marginBottom: 14 },
    entity: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#111' },
    sectionTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: accent, marginTop: 2, letterSpacing: 0.3 },
    metaRow: { flexDirection: 'row', marginTop: 4, flexWrap: 'wrap' },
    meta: { fontSize: 8.5, color: '#6b7178', marginRight: 14 },
    rule: { height: 2, backgroundColor: accent, marginTop: 9, marginBottom: 2 },
    // Exec summary
    para: { fontSize: 10.5, lineHeight: 1.5, color: '#1f2328', marginBottom: 8 },
    badge: { fontSize: 7.5, color: '#6b7178', fontFamily: 'Helvetica-Oblique', marginBottom: 10 },
    // KPI grid
    kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
    kpiCard: { width: '33.33%', paddingRight: 8, paddingBottom: 10 },
    kpiCardInner: { borderWidth: 0.75, borderColor: '#e3e6e9', borderRadius: 4, padding: 8, borderLeftWidth: 3, borderLeftColor: accent },
    kpiLabel: { fontSize: 7.5, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    kpiValue: { fontSize: 13, fontFamily: 'Courier-Bold', color: '#111', marginTop: 3 },
    kpiHint: { fontSize: 7.5, color: '#8a9096', marginTop: 2 },
    // MD&A
    mdnaHeading: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#111', marginTop: 11, marginBottom: 3 },
    mdnaPara: { fontSize: 9.5, lineHeight: 1.45, color: '#374151', marginBottom: 3 },
    mdnaBullet: { flexDirection: 'row', marginBottom: 2, paddingLeft: 6 },
    mdnaBulletDot: { width: 9, fontSize: 9.5, color: accent },
    mdnaBulletText: { flex: 1, fontSize: 9.5, lineHeight: 1.4, color: '#374151' },
    mdnaLabel: { fontSize: 8, color: '#8a9096', fontFamily: 'Helvetica-Oblique', marginTop: 10 },
    // Trend table
    trendHead: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: '#c9ced4', paddingBottom: 3, marginBottom: 1 },
    trendTh: { fontSize: 7, textTransform: 'uppercase', letterSpacing: 0.3, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    trendRow: { flexDirection: 'row', paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: '#eceef0' },
    trendLabel: { fontSize: 8.5, color: '#1f2328', fontFamily: 'Helvetica-Bold' },
    trendCell: { fontSize: 8, fontFamily: 'Courier', color: '#374151', textAlign: 'right' },
    // Generic statement rows (mirrors statement-pdf.tsx)
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
    totalVal: { fontFamily: 'Courier-Bold', fontSize: 10.5, textAlign: 'right', color: accent },
    note: { fontSize: 8.5, color: '#8a9096', fontFamily: 'Helvetica-Oblique', marginTop: 6 },
    spacer: { height: 6 },
    // Notes
    noteTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#111', marginTop: 12, marginBottom: 4 },
    notePara: { fontSize: 9.5, lineHeight: 1.45, color: '#374151', marginBottom: 4 },
    notePlaceholder: { fontSize: 9.5, lineHeight: 1.45, color: '#9aa0a6', fontFamily: 'Helvetica-Oblique', marginBottom: 4 },
    ntHead: { flexDirection: 'row', backgroundColor: '#f2f4f5', paddingVertical: 3, paddingHorizontal: 4, marginTop: 4 },
    ntCell: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#374151' },
    ntRow: { flexDirection: 'row', paddingVertical: 2.5, paddingHorizontal: 4, borderBottomWidth: 0.5, borderBottomColor: '#eceef0' },
    ntVal: { fontSize: 8.5, color: '#1f2328' },
    // Footer
    footer: { position: 'absolute', bottom: 26, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: '#e3e6e9', paddingTop: 6 },
    footerText: { fontSize: 7.5, color: '#aab0b6' },
  });

  const gen = new Date(pkg.meta.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const exportMeta = (reportLabel: string, periodLabel: string): ExportMeta => ({
    reportLabel,
    entityLabel: pkg.meta.entityLabel,
    periodLabel,
    basisLabel: pkg.meta.basisLabel,
    accent,
  });

  const isModel = buildIncomeStatement(pkg.statements.incomeStatement, exportMeta('Statement of Operations', pkg.meta.periodLabel));
  const bsModel = buildBalanceSheet(pkg.statements.balanceSheet, exportMeta('Balance Sheet', `As of ${pkg.meta.asOfDate}`));
  const cfModel = buildCashFlow(pkg.statements.cashFlow, exportMeta('Statement of Cash Flows', pkg.meta.periodLabel));

  const Footer = () => (
    <View style={s.footer} fixed>
      <Text style={s.footerText}>{pkg.meta.entityLabel} · Board Financial Package</Text>
      <Text style={s.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );

  const renderStmtRow = (row: StmtRow, i: number) => {
    if (row.kind === 'spacer') return <View key={i} style={s.spacer} />;
    if (row.kind === 'note') return <Text key={i} style={s.note}>{row.label}</Text>;
    const cells = row.values.map((v) => (typeof v === 'number' ? formatMoney(v) : v ?? ''));
    if (row.kind === 'section') {
      return (
        <View key={i} style={s.sectionRow} wrap={false}>
          <Text style={[s.sectionLabel, { width: '60%' }]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.sectionVal, { width: `${40 / cells.length}%` }]}>{c}</Text>)}
        </View>
      );
    }
    if (row.kind === 'subtotal') {
      return (
        <View key={i} style={s.subtotalRow} wrap={false}>
          <Text style={[s.subtotalLabel, { width: '60%' }]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.subtotalVal, { width: `${40 / cells.length}%` }]}>{c}</Text>)}
        </View>
      );
    }
    if (row.kind === 'total') {
      return (
        <View key={i} style={s.totalRow} wrap={false}>
          <Text style={[s.totalLabel, { width: '60%' }]}>{row.label}</Text>
          {cells.map((c, ci) => <Text key={ci} style={[s.totalVal, { width: `${40 / cells.length}%` }]}>{c}</Text>)}
        </View>
      );
    }
    const indent = (row.indent ?? 0) * 12;
    return (
      <View key={i} style={s.row} wrap={false}>
        <View style={[s.descCell, { width: '60%' }]}>
          <View style={{ width: indent }} />
          {row.code ? <Text style={s.code}>{row.code}</Text> : null}
          <Text style={s.label}>{row.label}</Text>
        </View>
        {cells.map((c, ci) => <Text key={ci} style={[s.valCell, { width: `${40 / cells.length}%` }]}>{c}</Text>)}
      </View>
    );
  };

  const StatementPage = ({ model }: { model: StatementModel }) => (
    <Page size="LETTER" style={s.page}>
      <View style={s.header}>
        <Text style={s.entity}>{pkg.meta.entityLabel}</Text>
        <Text style={s.sectionTitle}>{model.title}</Text>
        <View style={s.metaRow}>
          <Text style={s.meta}>{model.periodLabel}</Text>
          {model.basisLabel ? <Text style={s.meta}>{model.basisLabel}</Text> : null}
        </View>
        <View style={s.rule} />
      </View>
      <View style={s.thead} fixed>
        <Text style={[s.th, { width: '60%' }]}>Description</Text>
        {model.columns.map((col, ci) => (
          <Text key={ci} style={[s.th, { width: `${40 / model.columns.length}%`, textAlign: 'right' }]}>{col.label}</Text>
        ))}
      </View>
      {model.rows.map(renderStmtRow)}
      <Footer />
    </Page>
  );

  return (
    <Document title={`Board Package — ${pkg.meta.entityLabel}`}>
      {/* ── Cover ── */}
      <Page size="LETTER" style={s.page}>
        <View style={s.coverWrap}>
          <Text style={s.coverKicker}>Confidential · Prepared for the Board of Directors</Text>
          <Text style={s.coverEntity}>{pkg.meta.entityLabel}</Text>
          <Text style={s.coverTitle}>{pkg.cover.title}</Text>
          <View style={s.coverRule} />
          <Text style={s.coverMeta}>Reporting period: {pkg.meta.periodLabel}</Text>
          <Text style={s.coverMeta}>Balance sheet as of: {pkg.meta.asOfDate}</Text>
          <Text style={s.coverMeta}>Basis of accounting: {pkg.meta.basisLabel}</Text>
          <Text style={s.coverMeta}>Generated: {gen}</Text>

          <Text style={s.tocTitle}>Contents</Text>
          {pkg.cover.sectionList.map((sec, i) => (
            <View key={sec} style={s.tocRow}>
              <Text style={s.tocNum}>{pad(i + 1)}</Text>
              <Text style={s.tocLabel}>{sec}</Text>
            </View>
          ))}
        </View>
        <Footer />
      </Page>

      {/* ── Executive Summary + KPIs ── */}
      <Page size="LETTER" style={s.page}>
        <View style={s.header}>
          <Text style={s.entity}>{pkg.meta.entityLabel}</Text>
          <Text style={s.sectionTitle}>Executive Summary</Text>
          <View style={s.metaRow}>
            <Text style={s.meta}>{pkg.meta.periodLabel}</Text>
            <Text style={s.meta}>{pkg.meta.basisLabel}</Text>
          </View>
          <View style={s.rule} />
        </View>
        <Text style={s.badge}>
          {pkg.executiveSummary.source === 'ai'
            ? `AI-drafted from computed figures${pkg.executiveSummary.model ? ` · ${pkg.executiveSummary.model}` : ''}`
            : 'Computed summary (deterministic)'}
        </Text>
        <Text style={s.para}>{pkg.executiveSummary.text}</Text>

        <Text style={[s.tocTitle, { marginTop: 14 }]}>Key Performance Indicators</Text>
        <View style={s.kpiGrid}>
          {pkg.kpis.cards.map((c) => (
            <View key={c.key} style={s.kpiCard}>
              <View style={s.kpiCardInner}>
                <Text style={s.kpiLabel}>{c.label}</Text>
                <Text style={s.kpiValue}>{c.valueText}</Text>
                <Text style={s.kpiHint}>
                  {c.deltaPct != null ? `${c.deltaPct > 0 ? '+' : ''}${c.deltaPct}% vs prior` : c.hint ?? ' '}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {pkg.trend.metrics.length > 0 ? (
          <View wrap={false}>
            <Text style={[s.tocTitle, { marginTop: 14 }]}>Trend — Last {pkg.trend.periods.length} Periods</Text>
            <View style={s.trendHead}>
              <Text style={[s.trendTh, { width: '22%' }]}>Metric</Text>
              {pkg.trend.periods.map((p, i) => (
                <Text key={i} style={[s.trendTh, { width: `${78 / pkg.trend.periods.length}%`, textAlign: 'right' }]}>{p}</Text>
              ))}
            </View>
            {pkg.trend.metrics.map((m) => (
              <View key={m.key} style={s.trendRow} wrap={false}>
                <Text style={[s.trendLabel, { width: '22%' }]}>{m.label}</Text>
                {m.points.map((pt, i) => (
                  <Text key={i} style={[s.trendCell, { width: `${78 / pkg.trend.periods.length}%` }]}>{pt.valueText}</Text>
                ))}
              </View>
            ))}
          </View>
        ) : null}
        <Footer />
      </Page>

      {/* ── Management Discussion & Analysis ── */}
      {pkg.mdna.blocks.length > 0 ? (
        <Page size="LETTER" style={s.page}>
          <View style={s.header}>
            <Text style={s.entity}>{pkg.meta.entityLabel}</Text>
            <Text style={s.sectionTitle}>Management Discussion &amp; Analysis</Text>
            <View style={s.metaRow}>
              <Text style={s.meta}>{pkg.meta.periodLabel}</Text>
              <Text style={s.meta}>{pkg.meta.basisLabel}</Text>
            </View>
            <View style={s.rule} />
          </View>
          {pkg.mdna.blocks.map((b) => (
            <View key={b.id} wrap={false}>
              <Text style={s.mdnaHeading}>{b.heading}</Text>
              {b.paragraphs.map((p, i) => <Text key={i} style={s.mdnaPara}>{p}</Text>)}
              {b.bullets.map((bl, i) => (
                <View key={i} style={s.mdnaBullet}>
                  <Text style={s.mdnaBulletDot}>•</Text>
                  <Text style={s.mdnaBulletText}>{bl}</Text>
                </View>
              ))}
            </View>
          ))}
          <Text style={s.mdnaLabel}>{pkg.mdna.label}</Text>
          <Footer />
        </Page>
      ) : null}

      {/* ── Core statements ── */}
      <StatementPage model={isModel} />
      <StatementPage model={bsModel} />
      <StatementPage model={cfModel} />

      {/* ── Notes ── */}
      <Page size="LETTER" style={s.page}>
        <View style={s.header}>
          <Text style={s.entity}>{pkg.meta.entityLabel}</Text>
          <Text style={s.sectionTitle}>Notes to Financial Statements</Text>
          <View style={s.rule} />
        </View>
        {pkg.notes.notes.map((n) => (
          <View key={n.id} wrap={false}>
            <Text style={s.noteTitle}>{n.title}</Text>
            {n.body.map((p, i) => (
              <Text key={i} style={p.startsWith('[PLACEHOLDER') ? s.notePlaceholder : s.notePara}>{p}</Text>
            ))}
            {n.table ? (
              <View>
                <View style={s.ntHead}>
                  {n.table.columns.map((col, ci) => (
                    <Text key={ci} style={[s.ntCell, { width: `${100 / n.table!.columns.length}%`, textAlign: ci === 0 ? 'left' : 'right' }]}>{col}</Text>
                  ))}
                </View>
                {n.table.rows.map((r, ri) => (
                  <View key={ri} style={s.ntRow}>
                    {r.map((cell, ci) => (
                      <Text key={ci} style={[s.ntVal, { width: `${100 / n.table!.columns.length}%`, textAlign: ci === 0 ? 'left' : 'right', fontFamily: ci === 0 ? 'Helvetica' : 'Courier' }]}>{String(cell)}</Text>
                    ))}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ))}
        <Footer />
      </Page>
    </Document>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
