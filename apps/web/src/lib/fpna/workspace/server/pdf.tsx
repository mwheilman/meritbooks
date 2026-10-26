/**
 * FP&A view → branded PDF (AC-W11). Rendered on the SERVER from a recomputed view — the
 * client never sends figures. Merit palette (Electric Blue #2563EB, Midnight #0A1628,
 * Steel #3D4F65), built-in Helvetica only (deterministic, no network fonts — same rule as the
 * statement PDFs), square geometry, the books-closed-through footer and a preview watermark
 * when unclosed months are shown to finance.
 */

import React from 'react';
import { Document, Page, Polyline, StyleSheet, Svg, Text, View } from '@react-pdf/renderer';
import { cardRow, printTable } from '../print-table';
import type { CardModel, DashboardViewResponse, ViewResponse, WsBlock } from '../types';
import { TAB_LABEL } from '../types';
import { longMonth } from '../units';

const ELECTRIC = '#2563EB';
const MIDNIGHT = '#0A1628';
const STEEL = '#3D4F65';
const LINE = '#D9DEE5';
const SLATE = '#8494A7';

const s = StyleSheet.create({
  page: { paddingHorizontal: 40, paddingTop: 36, paddingBottom: 52, fontSize: 9, color: MIDNIGHT, fontFamily: 'Helvetica' },
  eyebrow: { fontSize: 7.5, letterSpacing: 1.2, color: STEEL, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase' },
  title: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: MIDNIGHT, marginTop: 2 },
  meta: { fontSize: 8.5, color: STEEL, marginTop: 4 },
  rule: { height: 2, backgroundColor: ELECTRIC, marginTop: 10, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  card: { width: '25%', paddingHorizontal: 4, marginBottom: 8 },
  cardBox: { borderTopWidth: 1, borderTopColor: LINE, paddingTop: 6, minHeight: 74 },
  cardLabel: { fontSize: 7.5, color: STEEL, fontFamily: 'Helvetica-Bold' },
  cardValue: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginTop: 3 },
  cardNa: { fontSize: 8, color: STEEL, marginTop: 4 },
  cardChg: { fontSize: 7.5, marginTop: 2 },
  cardSub: { fontSize: 7, color: SLATE, marginTop: 2 },
  block: { marginBottom: 14 },
  blockTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold' },
  summary: { fontSize: 8.5, color: STEEL, marginTop: 2, marginBottom: 5 },
  thead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: MIDNIGHT, paddingBottom: 2 },
  th: { fontSize: 7, fontFamily: 'Helvetica-Bold', color: STEEL, textTransform: 'uppercase' },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: LINE, paddingVertical: 2 },
  td: { fontSize: 8 },
  num: { textAlign: 'right' },
  foot: { fontSize: 7.5, color: SLATE, marginTop: 3 },
  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.5, borderTopColor: LINE, paddingTop: 5 },
  footerText: { fontSize: 7, color: SLATE },
  watermark: { position: 'absolute', top: 320, left: 40, right: 40, textAlign: 'center', fontSize: 44, fontFamily: 'Helvetica-Bold', color: '#E3E8EF', transform: 'rotate(-28deg)' },
  notice: { fontSize: 8, color: STEEL, borderLeftWidth: 2, borderLeftColor: ELECTRIC, paddingLeft: 6, marginBottom: 8 },
});

function Spark({ c }: { c: CardModel }) {
  const vals = c.sparkline.map((p) => p.value);
  const nums = vals.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const w = 110;
  const h = 16;
  const pts = vals
    .map((v, i) => (v === null ? null : `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - (hi === lo ? h / 2 : ((v - lo) / (hi - lo)) * h)).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
  return (
    <Svg width={w} height={h + 2} style={{ marginTop: 3 }}>
      <Polyline points={pts} stroke={ELECTRIC} strokeWidth={1} fill="none" />
    </Svg>
  );
}

function Card({ c }: { c: CardModel }) {
  const r = cardRow(c);
  const good = c.change ? c.change.verdict === 'improvement' || c.change.verdict === 'favourable' : null;
  return (
    <View style={s.card} wrap={false}>
      <View style={s.cardBox}>
        <Text style={s.cardLabel}>{c.name}</Text>
        {c.value === null ? <Text style={s.cardNa}>{c.unavailable?.message ?? 'Not available'}</Text> : <Text style={s.cardValue}>{r[1]}</Text>}
        {c.change && <Text style={[s.cardChg, { color: good === null ? STEEL : good ? ELECTRIC : '#9F2A2A' }]}>{r[3]} vs {c.comparison?.label}</Text>}
        <Spark c={c} />
        <Text style={s.cardSub}>{`${c.window.basis.toUpperCase()} · ${c.window.from === c.window.to ? longMonth(c.window.to) : `${longMonth(c.window.from)} – ${longMonth(c.window.to)}`}${c.preliminary ? ' · preliminary' : ''}`}</Text>
      </View>
    </View>
  );
}

function Block({ b }: { b: WsBlock }) {
  const t = printTable(b);
  const n = t ? t.columns.length : 1;
  const first = n > 4 ? 30 : 40;
  const other = (100 - first) / Math.max(1, n - 1);
  return (
    <View style={s.block}>
      <Text style={s.eyebrow}>{b.eyebrow}</Text>
      <Text style={s.blockTitle}>{b.title}</Text>
      <Text style={s.summary}>{b.summary}</Text>
      {t ? (
        <View>
          <View style={s.thead} fixed>
            {t.columns.map((c, i) => (
              <Text key={i} style={[s.th, { width: `${i === 0 ? first : other}%` }, i > 0 ? s.num : {}]}>{c}</Text>
            ))}
          </View>
          {t.rows.slice(0, 40).map((row, ri) => (
            <View key={ri} style={s.tr} wrap={false}>
              {row.map((cell, i) => (
                <Text key={i} style={[s.td, { width: `${i === 0 ? first : other}%` }, i > 0 ? s.num : {}]}>{cell}</Text>
              ))}
            </View>
          ))}
        </View>
      ) : (
        <Text style={s.foot}>{b.state?.kind === 'unavailable' ? b.state.detail : b.state?.kind === 'empty' ? b.state.body : ''}</Text>
      )}
      {b.footnotes.slice(0, 3).map((f, i) => (
        <Text key={i} style={s.foot}>{f}</Text>
      ))}
    </View>
  );
}

export interface WorkspacePdfProps {
  view: ViewResponse;
  scopeLabel: string;
  title?: string;
  generatedFor?: string | null;
}

export function WorkspacePdf({ view, scopeLabel, title, generatedFor }: WorkspacePdfProps) {
  const heading = title ?? (view.tab === 'dashboard' ? (view as DashboardViewResponse).dashboard.name : TAB_LABEL[view.tab]);
  return (
    <Document title={`${heading} — ${view.period.label}`} author="Merit Books">
      <Page size="LETTER" orientation={view.tab === 'dashboard' ? 'portrait' : 'landscape'} style={s.page}>
        {view.governance.preview && <Text style={s.watermark} fixed>PREVIEW — NOT CLOSED</Text>}
        <Text style={s.eyebrow}>FP&A // {TAB_LABEL[view.tab]}</Text>
        <Text style={s.title}>{heading}</Text>
        <Text style={s.meta}>
          {scopeLabel} · {view.period.label}
          {view.period.comparisonLabel ? ` vs ${view.period.comparisonLabel}` : ''}
          {view.scope.weighting === 'ownership' ? ' · ownership-weighted' : ''}
        </Text>
        <View style={s.rule} />
        {'notices' in view && view.notices.map((n, i) => <Text key={i} style={s.notice}>{n.title} {n.body}</Text>)}
        {view.tab === 'dashboard' ? (
          <View style={s.grid}>
            {(view as DashboardViewResponse).cards.map((c) => (
              <Card key={c.metric} c={c} />
            ))}
          </View>
        ) : (
          (view as Extract<ViewResponse, { blocks: WsBlock[] }>).blocks.map((b) => <Block key={b.id} b={b} />)
        )}
        <View style={s.footer} fixed>
          <Text style={s.footerText}>{view.governance.footnote}</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `${generatedFor ? `${generatedFor} · ` : ''}Generated ${view.generatedAt.slice(0, 10)} · Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export function scopeLabelOf(view: ViewResponse): string {
  const n = view.scope.companies.map((c) => c.name);
  if (n.length === 0) return 'No companies';
  if (n.length <= 3) return n.join(', ');
  return `${n.length} companies`;
}

