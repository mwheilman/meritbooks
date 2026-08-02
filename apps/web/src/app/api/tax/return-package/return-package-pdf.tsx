import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { formatMoney } from '@meritbooks/shared';
import type { TaxReturnPackage } from '@/lib/tax/return-package';

/**
 * Branded Tax Return Package PDF (1120-style, multi-page). Reuses the SAME @react-pdf
 * branding language as the Board Package export (board-package-pdf.tsx): white document,
 * emerald accent, Helvetica UI / Courier numerics, LETTER size, fixed page footer. Nothing
 * is recomputed here — it formats the aggregated package the client previewed.
 */

const DEFAULT_ACCENT = '#10b981';

function signed(cents: number): string {
  return `${cents < 0 ? '(' : ''}${formatMoney(Math.abs(cents))}${cents < 0 ? ')' : ''}`;
}

export function TaxReturnPackagePdf({ pkg }: { pkg: TaxReturnPackage }) {
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
    // Section heading
    header: { marginBottom: 14 },
    entity: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#111' },
    sectionTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: accent, marginTop: 2, letterSpacing: 0.3 },
    metaRow: { flexDirection: 'row', marginTop: 4, flexWrap: 'wrap' },
    meta: { fontSize: 8.5, color: '#6b7178', marginRight: 14 },
    rule: { height: 2, backgroundColor: accent, marginTop: 9, marginBottom: 2 },
    subhead: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', color: '#111', marginTop: 14, marginBottom: 4 },
    caption: { fontSize: 8, color: '#8a9096', fontFamily: 'Helvetica-Oblique', marginBottom: 6 },
    // Generic table
    thead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#1f2328', paddingBottom: 4, marginBottom: 2, paddingTop: 4 },
    th: { fontSize: 7.5, textTransform: 'uppercase', letterSpacing: 0.6, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 15, paddingVertical: 2, borderBottomWidth: 0.5, borderBottomColor: '#eceef0' },
    cellLabel: { flexShrink: 1 },
    val: { fontFamily: 'Courier', fontSize: 9, textAlign: 'right', color: '#1f2328' },
    subtotalRow: { flexDirection: 'row', borderTopWidth: 0.75, borderTopColor: '#c9ced4', paddingVertical: 3, marginTop: 1 },
    subtotalLabel: { fontFamily: 'Helvetica-Bold', fontSize: 9.5, color: '#1f2328' },
    subtotalVal: { fontFamily: 'Courier-Bold', fontSize: 9.5, textAlign: 'right', color: '#1f2328' },
    totalRow: { flexDirection: 'row', borderTopWidth: 1.5, borderTopColor: '#1f2328', paddingVertical: 5, marginTop: 3 },
    totalLabel: { fontFamily: 'Helvetica-Bold', fontSize: 10.5, color: '#111' },
    totalVal: { fontFamily: 'Courier-Bold', fontSize: 10.5, textAlign: 'right', color: accent },
    // KPI grid
    kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
    kpiCard: { width: '33.33%', paddingRight: 8, paddingBottom: 10 },
    kpiCardInner: { borderWidth: 0.75, borderColor: '#e3e6e9', borderRadius: 4, padding: 8, borderLeftWidth: 3, borderLeftColor: accent },
    kpiLabel: { fontSize: 7.5, textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7178', fontFamily: 'Helvetica-Bold' },
    kpiValue: { fontSize: 13, fontFamily: 'Courier-Bold', color: '#111', marginTop: 3 },
    note: { fontSize: 8.5, color: '#8a9096', fontFamily: 'Helvetica-Oblique', marginTop: 6 },
    footer: { position: 'absolute', bottom: 26, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: '#e3e6e9', paddingTop: 6 },
    footerText: { fontSize: 7.5, color: '#aab0b6' },
  });

  const gen = new Date(pkg.meta.generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const sections = ['Book-to-Tax Reconciliation (Schedule M-1)', 'Tax vs. Book Depreciation', 'Income Tax Provision (ASC 740)', 'Deferred Tax Rollforward'];

  const Footer = () => (
    <View style={s.footer} fixed>
      <Text style={s.footerText}>{pkg.meta.entityLabel} · Tax Return Package ({pkg.meta.taxYear})</Text>
      <Text style={s.footerText} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );

  const SectionHeader = ({ title }: { title: string }) => (
    <View style={s.header}>
      <Text style={s.entity}>{pkg.meta.entityLabel}</Text>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.metaRow}>
        <Text style={s.meta}>{pkg.meta.periodLabel}</Text>
        <Text style={s.meta}>Statutory rate {pkg.meta.statutoryRatePct}%</Text>
        <Text style={s.meta}>{pkg.meta.basisLabel}</Text>
      </View>
      <View style={s.rule} />
    </View>
  );

  const LineRow = ({ label, cents }: { label: string; cents: number }) => (
    <View style={s.row} wrap={false}>
      <Text style={[s.cellLabel, { width: '68%' }]}>{label}</Text>
      <Text style={[s.val, { width: '32%' }]}>{signed(cents)}</Text>
    </View>
  );

  return (
    <Document title={`Tax Return Package — ${pkg.meta.entityLabel} (${pkg.meta.taxYear})`}>
      {/* ── Cover ── */}
      <Page size="LETTER" style={s.page}>
        <View style={s.coverWrap}>
          <Text style={s.coverKicker}>Confidential · Prepared for Tax Filing</Text>
          <Text style={s.coverEntity}>{pkg.meta.entityLabel}</Text>
          <Text style={s.coverTitle}>Corporate Tax Return Package · Form 1120 ({pkg.meta.taxYear})</Text>
          <View style={s.coverRule} />
          <Text style={s.coverMeta}>Tax period: {pkg.meta.periodLabel}</Text>
          <Text style={s.coverMeta}>Statutory rate: {pkg.meta.statutoryRatePct}%</Text>
          <Text style={s.coverMeta}>Basis: {pkg.meta.basisLabel}</Text>
          <Text style={s.coverMeta}>Generated: {gen}</Text>

          <Text style={s.tocTitle}>Contents</Text>
          {sections.map((sec, i) => (
            <View key={sec} style={s.tocRow}>
              <Text style={s.tocNum}>{String(i + 1).padStart(2, '0')}</Text>
              <Text style={s.tocLabel}>{sec}</Text>
            </View>
          ))}
          {!pkg.meta.isSingleEntity && (
            <Text style={[s.note, { marginTop: 18 }]}>
              Consolidated preview across all entities — select a single company to produce an entity-level return.
            </Text>
          )}
        </View>
        <Footer />
      </Page>

      {/* ── Summary + waterfall ── */}
      <Page size="LETTER" style={s.page}>
        <SectionHeader title="Tax Summary" />
        <View style={s.kpiGrid}>
          {[
            { label: 'Pretax book income', v: signed(pkg.summary.pretaxBookIncomeCents) },
            { label: 'Taxable income', v: signed(pkg.summary.taxableIncomeCents) },
            { label: 'Current tax', v: signed(pkg.summary.currentTaxCents) },
            { label: 'Deferred tax', v: signed(pkg.summary.deferredTaxCents) },
            { label: 'Total provision', v: signed(pkg.summary.totalProvisionCents) },
            { label: 'Effective rate', v: `${pkg.summary.effectiveRatePct.toFixed(2)}%` },
          ].map((c) => (
            <View key={c.label} style={s.kpiCard}>
              <View style={s.kpiCardInner}>
                <Text style={s.kpiLabel}>{c.label}</Text>
                <Text style={s.kpiValue}>{c.v}</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={s.subhead}>Book income to tax provision</Text>
        <Text style={s.caption}>Net income per books, adjusted by Schedule M-1 differences, to taxable income and the ASC 740 provision.</Text>
        {pkg.waterfall.map((w) =>
          w.kind === 'subtotal' ? (
            <View key={w.key} style={s.subtotalRow} wrap={false}>
              <Text style={[s.subtotalLabel, { width: '68%' }]}>{w.label}</Text>
              <Text style={[s.subtotalVal, { width: '32%' }]}>{signed(w.amountCents)}</Text>
            </View>
          ) : (
            <LineRow key={w.key} label={w.label} cents={w.amountCents} />
          ),
        )}
        <View style={s.totalRow} wrap={false}>
          <Text style={[s.totalLabel, { width: '68%' }]}>Total income tax provision</Text>
          <Text style={[s.totalVal, { width: '32%' }]}>{signed(pkg.summary.totalProvisionCents)}</Text>
        </View>

        {pkg.preparerNotes.length > 0 && (
          <View>
            <Text style={s.subhead}>Preparer notes</Text>
            {pkg.preparerNotes.map((n, i) => (
              <Text key={i} style={s.note}>• {n}</Text>
            ))}
          </View>
        )}
        <Footer />
      </Page>

      {/* ── Schedule M-1 ── */}
      <Page size="LETTER" style={s.page}>
        <SectionHeader title="Schedule M-1 — Book-to-Tax Reconciliation" />
        <LineRow label="Net income per books (pretax)" cents={pkg.m1.bookNetIncomeCents} />

        <Text style={s.subhead}>Additions (increase taxable income)</Text>
        {pkg.m1.additions.length === 0 ? (
          <Text style={s.note}>No additions tagged for this period.</Text>
        ) : (
          pkg.m1.additions.map((l) => (
            <LineRow key={l.code} label={`${l.label}${l.m1Line ? ` · line ${l.m1Line}` : ''}${l.codeSection ? ` (${l.codeSection})` : ''} · ${l.differenceType === 'PERMANENT' ? 'P' : 'T'}`} cents={l.amountCents} />
          ))
        )}
        <View style={s.subtotalRow} wrap={false}>
          <Text style={[s.subtotalLabel, { width: '68%' }]}>Total additions</Text>
          <Text style={[s.subtotalVal, { width: '32%' }]}>{signed(pkg.m1.totalAdditionsCents)}</Text>
        </View>

        <Text style={s.subhead}>Subtractions (decrease taxable income)</Text>
        {pkg.m1.subtractions.length === 0 ? (
          <Text style={s.note}>No subtractions tagged for this period.</Text>
        ) : (
          pkg.m1.subtractions.map((l) => (
            <LineRow key={l.code} label={`${l.label}${l.m1Line ? ` · line ${l.m1Line}` : ''}${l.codeSection ? ` (${l.codeSection})` : ''} · ${l.differenceType === 'PERMANENT' ? 'P' : 'T'}`} cents={l.amountCents} />
          ))
        )}
        <View style={s.subtotalRow} wrap={false}>
          <Text style={[s.subtotalLabel, { width: '68%' }]}>Total subtractions</Text>
          <Text style={[s.subtotalVal, { width: '32%' }]}>{signed(pkg.m1.totalSubtractionsCents)}</Text>
        </View>

        <View style={s.totalRow} wrap={false}>
          <Text style={[s.totalLabel, { width: '68%' }]}>Taxable income</Text>
          <Text style={[s.totalVal, { width: '32%' }]}>{signed(pkg.m1.taxableIncomeCents)}</Text>
        </View>
        <Text style={s.caption}>P = permanent difference · T = temporary difference (reverses in a later year; drives deferred tax).</Text>
        <Footer />
      </Page>

      {/* ── Tax vs book depreciation ── */}
      <Page size="LETTER" style={s.page}>
        <SectionHeader title="Tax vs. Book Depreciation" />
        <Text style={s.caption}>Posted book depreciation vs. the deterministic MACRS / §179 / bonus tax schedule for {pkg.depreciation.taxYear}. The net delta is a temporary Schedule M-1 difference.</Text>
        <View style={s.thead} fixed>
          <Text style={[s.th, { width: '40%' }]}>Asset</Text>
          <Text style={[s.th, { width: '20%' }]}>Method</Text>
          <Text style={[s.th, { width: '20%', textAlign: 'right' }]}>Tax {pkg.depreciation.taxYear}</Text>
          <Text style={[s.th, { width: '20%', textAlign: 'right' }]}>Book {pkg.depreciation.taxYear}</Text>
        </View>
        {pkg.depreciation.assets.length === 0 ? (
          <Text style={s.note}>No depreciable fixed assets for this tax year.</Text>
        ) : (
          pkg.depreciation.assets.map((a) => (
            <View key={a.assetId} style={s.row} wrap={false}>
              <Text style={[s.cellLabel, { width: '40%' }]}>{a.name}</Text>
              <Text style={[s.cellLabel, { width: '20%', fontSize: 8, color: '#6b7178' }]}>{a.taxMethod}{a.recoveryYears ? ` ${a.recoveryYears}yr` : ''}</Text>
              <Text style={[s.val, { width: '20%' }]}>{formatMoney(a.taxYearCents)}</Text>
              <Text style={[s.val, { width: '20%' }]}>{formatMoney(a.bookYearCents)}</Text>
            </View>
          ))
        )}
        <View style={s.subtotalRow} wrap={false}>
          <Text style={[s.subtotalLabel, { width: '60%' }]}>Totals</Text>
          <Text style={[s.subtotalVal, { width: '20%' }]}>{formatMoney(pkg.depreciation.totalTaxCents)}</Text>
          <Text style={[s.subtotalVal, { width: '20%' }]}>{formatMoney(pkg.depreciation.totalBookCents)}</Text>
        </View>
        <View style={s.totalRow} wrap={false}>
          <Text style={[s.totalLabel, { width: '68%' }]}>
            Net book − tax difference{pkg.depreciation.m1Code ? ` (${pkg.depreciation.m1Code === 'BOOK_DEPR_EXCESS' ? 'M-1 line 5a addition' : 'M-1 line 8a subtraction'})` : ''}
          </Text>
          <Text style={[s.totalVal, { width: '32%' }]}>{signed(pkg.depreciation.netDifferenceCents)}</Text>
        </View>
        <Footer />
      </Page>

      {/* ── Provision: effective rate + deferred rollforward ── */}
      <Page size="LETTER" style={s.page}>
        <SectionHeader title="Income Tax Provision (ASC 740)" />

        <Text style={s.subhead}>Effective-rate reconciliation</Text>
        <Text style={s.caption}>Only permanent differences move the effective rate away from statutory.</Text>
        {pkg.effectiveRate.map((row, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Text style={[s.cellLabel, { width: '52%' }]}>{row.label}</Text>
            <Text style={[s.val, { width: '28%' }]}>{signed(row.amountCents)}</Text>
            <Text style={[s.val, { width: '20%' }]}>{row.ratePct.toFixed(2)}%</Text>
          </View>
        ))}

        <Text style={s.subhead}>Deferred tax — DTA / DTL rollforward</Text>
        <Text style={s.caption}>Beginning balances from prior filed provisions; current-period change × {pkg.meta.statutoryRatePct}% of temporary differences.</Text>
        <View style={s.thead} fixed>
          <Text style={[s.th, { width: '52%' }]}>Deferred balance</Text>
          <Text style={[s.th, { width: '24%', textAlign: 'right' }]}>DTA</Text>
          <Text style={[s.th, { width: '24%', textAlign: 'right' }]}>DTL</Text>
        </View>
        {[
          { label: 'Beginning balance', dta: pkg.deferred.rollforward.beginningDtaCents, dtl: pkg.deferred.rollforward.beginningDtlCents },
          { label: 'Change this period', dta: pkg.deferred.rollforward.dtaChangeCents, dtl: pkg.deferred.rollforward.dtlChangeCents },
        ].map((r) => (
          <View key={r.label} style={s.row} wrap={false}>
            <Text style={[s.cellLabel, { width: '52%' }]}>{r.label}</Text>
            <Text style={[s.val, { width: '24%' }]}>{formatMoney(r.dta)}</Text>
            <Text style={[s.val, { width: '24%' }]}>{formatMoney(r.dtl)}</Text>
          </View>
        ))}
        <View style={s.subtotalRow} wrap={false}>
          <Text style={[s.subtotalLabel, { width: '52%' }]}>Ending balance</Text>
          <Text style={[s.subtotalVal, { width: '24%' }]}>{formatMoney(pkg.deferred.rollforward.endingDtaCents)}</Text>
          <Text style={[s.subtotalVal, { width: '24%' }]}>{formatMoney(pkg.deferred.rollforward.endingDtlCents)}</Text>
        </View>
        <View style={s.totalRow} wrap={false}>
          <Text style={[s.totalLabel, { width: '76%' }]}>Net deferred tax asset (liability) at period end</Text>
          <Text style={[s.totalVal, { width: '24%' }]}>{signed(pkg.deferred.rollforward.endingNetDtaCents)}</Text>
        </View>

        {pkg.deferred.items.length > 0 && (
          <View>
            <Text style={s.subhead}>Temporary difference detail</Text>
            {pkg.deferred.items.map((it) => (
              <View key={it.code} style={s.row} wrap={false}>
                <Text style={[s.cellLabel, { width: '52%' }]}>{it.label || it.code} ({it.category})</Text>
                <Text style={[s.val, { width: '28%' }]}>{signed(it.temporaryDiffCents)}</Text>
                <Text style={[s.val, { width: '20%' }]}>{formatMoney(it.deferredTaxCents)}</Text>
              </View>
            ))}
          </View>
        )}
        <Footer />
      </Page>
    </Document>
  );
}
