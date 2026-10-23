import React from 'react';
import { Document, Font, Image, Page, Rect, StyleSheet, Svg, Text, View, Line, type Styles } from '@react-pdf/renderer';

type Style = Styles[string];
import type { MicrChar, MicrLine } from '@/lib/ap/checks/micr';
import { composeMicrLine, positionCellIn } from '@/lib/ap/checks/micr';
import { glyphRectsPt } from './e13b';
import {
  CHECK_FIELDS,
  CLEAR_BAND_PT,
  MICR_BASELINE_PT,
  PAGE_H,
  PAGE_W,
  PT_PER_IN,
  pageBands,
  paginate,
  type Band,
  type CheckLayout,
  type Offsets,
} from './layout';
import { formatCheckDate, money, type CheckStockSetup, type ImageBytes, type RenderedCheck } from './check-doc';
import type { MicrFont } from './micr-font';

/**
 * Check-run PDF on blank check stock (Wave 2C, FPB-check-processing §4.1 / §8).
 *
 * Absolute layout in points so the printer nudge moves everything together. The MICR line
 * is drawn at its ANSI X9.13 positions (position 1's right edge 5/16" from the check's
 * right edge, 0.125" pitch, baseline 3/16" above the bottom edge) either with the in-repo
 * vector E-13B glyphs or, when configured, a licensed E-13B font placed one character per
 * position cell. Nothing but the MICR line is drawn in the 5/8" clear band.
 *
 * Built-in Helvetica only (deterministic, no network). The document carries the full MICR
 * numbers, so it is rendered on request and never stored.
 */

const INK = '#000000';
const RULE = '#4a4a4a';

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 9, color: INK },
  abs: { position: 'absolute' },
  payerName: { fontFamily: 'Helvetica-Bold', fontSize: 11 },
  small: { fontSize: 7.5, lineHeight: 1.25 },
  tiny: { fontSize: 6.5, color: RULE },
  label: { fontSize: 6.5, letterSpacing: 0.4, color: RULE },
  number: { fontFamily: 'Helvetica-Bold', fontSize: 11, textAlign: 'right' },
  amount: { fontFamily: 'Helvetica-Bold', fontSize: 11, textAlign: 'right' },
  payee: { fontFamily: 'Helvetica-Bold', fontSize: 10 },
  words: { fontSize: 9 },
  stubHead: { fontFamily: 'Helvetica-Bold', fontSize: 9 },
  stubTh: { fontFamily: 'Helvetica-Bold', fontSize: 7.5 },
  stubTd: { fontSize: 8 },
});

/**
 * The amount in words followed by protective asterisks to the end of the line. Widths are
 * Helvetica estimates (average glyph ≈ 0.5 em, asterisk 0.389 em) — slightly short is safe.
 */
export function fillToWidth(words: string, widthPt: number, fontPt: number): string {
  const used = words.length * fontPt * 0.52;
  const n = Math.floor((widthPt - used) / (fontPt * 0.389)) - 2;
  return n > 2 ? `${words} ${'*'.repeat(n)}` : words;
}

function Abs({ x, y, w, h, o, children, style }: { x: number; y: number; w?: number; h?: number; o: Offsets; children?: React.ReactNode; style?: Style }) {
  return (
    <View style={style ? [s.abs, { left: x + o.xPt, top: y + o.yPt, width: w, height: h }, style] : [s.abs, { left: x + o.xPt, top: y + o.yPt, width: w, height: h }]}>
      {children}
    </View>
  );
}

function HRule({ x, y, w, o, color = RULE }: { x: number; y: number; w: number; o: Offsets; color?: string }) {
  return <View style={[s.abs, { left: x + o.xPt, top: y + o.yPt, width: w, height: 0, borderTopWidth: 0.6, borderTopColor: color }]} />;
}

function Img({ img, x, y, w, h, o }: { img: ImageBytes; x: number; y: number; w: number; h: number; o: Offsets }) {
  return <Image src={{ data: img.data, format: img.format }} style={[s.abs, { left: x + o.xPt, top: y + o.yPt, width: w, height: h, objectFit: 'contain' }]} />;
}

/** The MICR line for a check band (vector glyphs or a licensed font, one char per cell). */
function MicrLineView({ micr, band, o, font }: { micr: MicrLine; band: Band; o: Offsets; font: MicrFont | null }) {
  const checkWidthIn = PAGE_W / PT_PER_IN;
  const baseline = band.top + band.height - MICR_BASELINE_PT;
  if (font) {
    const size = Number(process.env.CHECK_MICR_FONT_SIZE ?? 12) || 12;
    return (
      <>
        {micr.cells.map((c) => {
          const cell = positionCellIn(c.position, checkWidthIn);
          return (
            <Text
              key={c.position}
              style={[s.abs, { left: cell.left * PT_PER_IN + o.xPt, top: baseline - size * 0.8 + o.yPt, width: 0.125 * PT_PER_IN, fontFamily: 'MICR-E13B', fontSize: size, textAlign: 'center' }]}
            >
              {font.toFontText(c.char)}
            </Text>
          );
        })}
      </>
    );
  }
  const rects = micr.cells.flatMap((c) => {
    const cell = positionCellIn(c.position, checkWidthIn);
    return glyphRectsPt(c.char as MicrChar, cell.left * PT_PER_IN + o.xPt, baseline + o.yPt);
  });
  return (
    <Svg style={[s.abs, { left: 0, top: 0 }]} width={PAGE_W} height={PAGE_H} viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}>
      {rects.map((r, i) => (
        <Rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={INK} />
      ))}
    </Svg>
  );
}

function CheckFace({ check, band, setup, o, font }: { check: RenderedCheck; band: Band; setup: CheckStockSetup; o: Offsets; font: MicrFont | null }) {
  const t = band.top;
  const f = CHECK_FIELDS;
  const logoW = setup.logo ? 48 : 0;
  const twoSigs = check.signaturesRequired === 2;
  return (
    <>
      {setup.logo && <Img img={setup.logo} x={f.payer.x} y={t + f.payer.y} w={44} h={44} o={o} />}
      <Abs x={f.payer.x + logoW} y={t + f.payer.y} w={f.payer.w - logoW} o={o}>
        <Text style={s.payerName}>{setup.payerName}</Text>
        {setup.payerAddress ? <Text style={s.small}>{setup.payerAddress}</Text> : null}
      </Abs>
      <Abs x={f.bank.x} y={t + f.bank.y} w={f.bank.w} o={o} style={{ alignItems: 'center' }}>
        {setup.bankName ? <Text style={[s.small, { fontFamily: 'Helvetica-Bold' }]}>{setup.bankName}</Text> : null}
        {setup.bankAddress ? <Text style={[s.small, { textAlign: 'center' }]}>{setup.bankAddress}</Text> : null}
        {setup.bankFraction ? <Text style={s.tiny}>{setup.bankFraction}</Text> : null}
      </Abs>
      <Abs x={f.number.x} y={t + f.number.y} w={f.number.w} o={o}>
        <Text style={s.number}>{check.checkNumber}</Text>
      </Abs>
      <Abs x={f.date.x} y={t + f.date.y} w={f.date.w} o={o} style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Text style={s.label}>DATE  </Text>
        <Text style={{ fontSize: 9.5 }}>{formatCheckDate(check.checkDate)}</Text>
      </Abs>
      <Abs x={f.payTo.x} y={t + f.payTo.y} w={f.payTo.w} o={o} style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        <Text style={[s.label, { width: 96 }]}>PAY TO THE ORDER OF</Text>
        <Text style={s.payee}>{check.payeeName}</Text>
      </Abs>
      <HRule x={f.payTo.x + 96} y={t + f.payTo.y + f.payTo.h} w={f.payTo.w - 96} o={o} />
      <Abs x={f.amountBox.x} y={t + f.amountBox.y} w={f.amountBox.w} h={f.amountBox.h} o={o}
        style={{ borderWidth: 0.8, borderColor: INK, justifyContent: 'center', paddingHorizontal: 4 }}>
        <Text style={s.amount}>${check.numeral}</Text>
      </Abs>
      <Abs x={f.words.x} y={t + f.words.y} w={f.words.w - 50} o={o}>
        <Text style={s.words}>{fillToWidth(check.words, f.words.w - 56, 9)}</Text>
      </Abs>
      <Abs x={f.words.x + f.words.w - 46} y={t + f.words.y} w={46} o={o}>
        <Text style={[s.label, { textAlign: 'right', fontSize: 7 }]}>DOLLARS</Text>
      </Abs>
      <HRule x={f.words.x} y={t + f.words.y + f.words.h - 2} w={f.words.w - 50} o={o} />
      <Abs x={f.payeeAddress.x} y={t + f.payeeAddress.y} w={f.payeeAddress.w} o={o}>
        <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold' }}>{check.payeeName}</Text>
        {check.payeeAddress ? <Text style={s.small}>{check.payeeAddress}</Text> : null}
      </Abs>
      <Abs x={f.voidAfter.x} y={t + f.voidAfter.y} w={f.voidAfter.w} o={o}>
        <Text style={[s.tiny, { textAlign: 'right' }]}>VOID AFTER {setup.voidAfterDays} DAYS</Text>
      </Abs>
      <Abs x={f.memo.x} y={t + f.memo.y} w={f.memo.w} o={o} style={{ flexDirection: 'row' }}>
        <Text style={[s.label, { width: 30 }]}>MEMO</Text>
        <Text style={s.small}>{check.memo ?? ''}</Text>
      </Abs>
      <HRule x={f.memo.x + 30} y={t + f.memo.y + f.memo.h - 2} w={f.memo.w - 30} o={o} />

      {/* signature 1 (bottom line) */}
      {setup.signature && <Img img={setup.signature} x={f.signature1.x + 10} y={t + f.signature1.y - 28} w={f.signature1.w - 20} h={27} o={o} />}
      <HRule x={f.signature1.x} y={t + f.signature1.y} w={f.signature1.w} o={o} color={INK} />
      <Abs x={f.signature1.x} y={t + f.signature1.y + 1} w={f.signature1.w} o={o}>
        <Text style={[s.tiny, { textAlign: 'center' }]}>AUTHORIZED SIGNATURE</Text>
      </Abs>
      {twoSigs && (
        <>
          {setup.signature2 && <Img img={setup.signature2} x={f.signature2.x + 10} y={t + f.signature2.y - 26} w={f.signature2.w - 20} h={25} o={o} />}
          <HRule x={f.signature2.x} y={t + f.signature2.y} w={f.signature2.w} o={o} color={INK} />
          <Abs x={f.signature2.x} y={t + f.signature2.y + 1} w={f.signature2.w} o={o}>
            <Text style={[s.tiny, { textAlign: 'center' }]}>{setup.signature2 ? 'AUTHORIZED SIGNATURE' : 'TWO SIGNATURES REQUIRED'}</Text>
          </Abs>
        </>
      )}
      <MicrLineView micr={check.micr} band={band} o={o} font={font} />
    </>
  );
}

function Stub({ check, band, setup, o }: { check: RenderedCheck; band: Band; setup: CheckStockSetup; o: Offsets }) {
  const t = band.top + 24;
  const cols = [
    { label: 'DATE', w: 70, align: 'left' as const },
    { label: 'INVOICE / REFERENCE', w: 190, align: 'left' as const },
    { label: 'AMOUNT', w: 90, align: 'right' as const },
    { label: 'DISCOUNT', w: 80, align: 'right' as const },
    { label: 'PAID', w: 110, align: 'right' as const },
  ];
  const rowH = 12.5;
  const total = check.stubLines.reduce((a, l) => a + l.paidCents, 0);
  return (
    <>
      <Abs x={36} y={t} w={540} o={o} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={s.stubHead}>{setup.payerName}</Text>
        <Text style={s.stubHead}>
          Check {check.checkNumber} · {formatCheckDate(check.checkDate)} · ${money(check.amountCents)}
        </Text>
      </Abs>
      <Abs x={36} y={t + 14} w={540} o={o} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={s.small}>Pay to: {check.payeeName}</Text>
        <Text style={s.tiny}>{band.copy === 'file' ? 'FILE COPY' : 'REMITTANCE — DETACH AND RETAIN'}</Text>
      </Abs>
      <Abs x={36} y={t + 34} w={540} o={o} style={{ flexDirection: 'row', borderBottomWidth: 0.6, borderBottomColor: INK, paddingBottom: 2 }}>
        {cols.map((c) => (
          <Text key={c.label} style={[s.stubTh, { width: c.w, textAlign: c.align }]}>{c.label}</Text>
        ))}
      </Abs>
      {check.stubVisible.map((l, i) => (
        <Abs key={i} x={36} y={t + 50 + i * rowH} w={540} o={o} style={{ flexDirection: 'row' }}>
          <Text style={[s.stubTd, { width: cols[0].w }]}>{l.date ? formatCheckDate(l.date) : ''}</Text>
          <Text style={[s.stubTd, { width: cols[1].w }]}>{l.ref ?? '—'}</Text>
          <Text style={[s.stubTd, { width: cols[2].w, textAlign: 'right' }]}>{money(l.billAmountCents)}</Text>
          <Text style={[s.stubTd, { width: cols[3].w, textAlign: 'right' }]}>{money(l.discountCents)}</Text>
          <Text style={[s.stubTd, { width: cols[4].w, textAlign: 'right' }]}>{money(l.paidCents)}</Text>
        </Abs>
      ))}
      {check.stubOverflow > 0 && (
        <Abs x={36} y={t + 50 + check.stubVisible.length * rowH} w={540} o={o}>
          <Text style={s.small}>
            + {check.stubOverflow} more invoice(s) totalling ${money(check.stubLines.slice(check.stubVisible.length).reduce((a, l) => a + l.paidCents, 0))} — see the remittance advice.
          </Text>
        </Abs>
      )}
      <Abs x={36} y={band.top + band.height - 40} w={540} o={o} style={{ flexDirection: 'row', justifyContent: 'flex-end', borderTopWidth: 0.6, borderTopColor: INK, paddingTop: 3 }}>
        <Text style={s.stubHead}>Total paid  ${money(total)}</Text>
      </Abs>
    </>
  );
}

export interface CheckRunPdfProps {
  checks: RenderedCheck[];
  setup: CheckStockSetup;
  micrFont?: MicrFont | null;
  title?: string;
}

let fontRegistered: string | null = null;
function ensureMicrFont(font: MicrFont | null | undefined): MicrFont | null {
  if (!font) return null;
  if (fontRegistered !== font.path) {
    Font.register({ family: 'MICR-E13B', src: font.path });
    fontRegistered = font.path;
  }
  return font;
}

export function CheckRunPdf({ checks, setup, micrFont, title }: CheckRunPdfProps) {
  const o: Offsets = { xPt: setup.offsetXPt, yPt: setup.offsetYPt };
  const font = ensureMicrFont(micrFont);
  const pages = paginate(checks, setup.layout);
  const bands = pageBands(setup.layout);
  return (
    <Document title={title ?? 'Checks'} author={setup.payerName} creator="MeritBooks" producer="MeritBooks">
      {pages.map((pageChecks, pi) => {
        let ci = 0;
        return (
          <Page key={pi} size="LETTER" style={s.page}>
            {bands.map((band, bi) => {
              if (band.kind === 'check') {
                const check = pageChecks[setup.layout === 'THREE_UP' ? ci++ : 0];
                if (!check) return null;
                return <CheckFace key={bi} check={check} band={band} setup={setup} o={o} font={font} />;
              }
              const check = pageChecks[0];
              return check ? <Stub key={bi} check={check} band={band} setup={setup} o={o} /> : null;
            })}
          </Page>
        );
      })}
    </Document>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Alignment test page
// ─────────────────────────────────────────────────────────────────────────────

export interface AlignmentPdfProps {
  layout: CheckLayout;
  offsetXPt: number;
  offsetYPt: number;
  accountLabel: string;
}

/** Plain-paper test sheet: field boxes, crosshairs, a ruler, the MICR clear band. Not a check. */
export function AlignmentPdf({ layout, offsetXPt, offsetYPt, accountLabel }: AlignmentPdfProps) {
  const o: Offsets = { xPt: offsetXPt, yPt: offsetYPt };
  const bands = pageBands(layout);
  // A dummy MICR line (zeros; routing 000000000 passes the checksum) so the band position can be checked.
  const sample = composeMicrLine({ checkNumber: 1, routing: '000000000', account: '0000000000' });
  const f = CHECK_FIELDS;
  const box = (key: string, x: number, y: number, w: number, h: number) => (
    <Abs key={key} x={x} y={y} w={w} h={Math.max(h, 8)} o={o} style={{ borderWidth: 0.5, borderColor: '#2563EB', borderStyle: 'dashed', padding: 1 }}>
      <Text style={{ fontSize: 5.5, color: '#2563EB' }}>{key}</Text>
    </Abs>
  );
  return (
    <Document title="Check alignment test" creator="MeritBooks" producer="MeritBooks">
      <Page size="LETTER" style={s.page}>
        {/* ruler: quarter-inch ticks along the top and left edges (not nudged — it measures the paper) */}
        <Svg style={[s.abs, { left: 0, top: 0 }]} width={PAGE_W} height={PAGE_H} viewBox={`0 0 ${PAGE_W} ${PAGE_H}`}>
          {Array.from({ length: 35 }, (_, i) => (
            <Line key={`t${i}`} x1={i * 18} y1={0} x2={i * 18} y2={i % 4 === 0 ? 12 : 6} stroke="#8494A7" strokeWidth={0.5} />
          ))}
          {Array.from({ length: 45 }, (_, i) => (
            <Line key={`l${i}`} x1={0} y1={i * 18} x2={i % 4 === 0 ? 12 : 6} y2={i * 18} stroke="#8494A7" strokeWidth={0.5} />
          ))}
        </Svg>
        {bands.map((band, bi) => {
          const t = band.top;
          if (band.kind === 'stub') {
            return (
              <React.Fragment key={bi}>
                <Abs x={18} y={t + 6} w={576} h={band.height - 12} o={o} style={{ borderWidth: 0.5, borderColor: '#8494A7' }}>
                  <Text style={{ fontSize: 8, color: '#8494A7', margin: 6 }}>STUB ({band.copy === 'file' ? 'file copy' : 'payee copy'})</Text>
                </Abs>
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={bi}>
              {box('PAYER', f.payer.x, t + f.payer.y, f.payer.w, f.payer.h)}
              {box('BANK', f.bank.x, t + f.bank.y, f.bank.w, f.bank.h)}
              {box('CHECK NO.', f.number.x, t + f.number.y, f.number.w, f.number.h)}
              {box('DATE', f.date.x, t + f.date.y, f.date.w, f.date.h)}
              {box('PAY TO', f.payTo.x, t + f.payTo.y, f.payTo.w, f.payTo.h)}
              {box('AMOUNT', f.amountBox.x, t + f.amountBox.y, f.amountBox.w, f.amountBox.h)}
              {box('AMOUNT IN WORDS', f.words.x, t + f.words.y, f.words.w, f.words.h)}
              {box('PAYEE ADDRESS (envelope window)', f.payeeAddress.x, t + f.payeeAddress.y, f.payeeAddress.w, f.payeeAddress.h)}
              {box('MEMO', f.memo.x, t + f.memo.y, f.memo.w, f.memo.h)}
              {box('SIGNATURE', f.signature1.x, t + f.signature1.y - 28, f.signature1.w, 28)}
              <Abs x={0} y={t + band.height - CLEAR_BAND_PT} w={PAGE_W} h={CLEAR_BAND_PT} o={o}
                style={{ borderTopWidth: 0.5, borderTopColor: '#B42318', borderStyle: 'dashed' }}>
                <Text style={{ fontSize: 5.5, color: '#B42318', marginLeft: 20 }}>MICR CLEAR BAND (5/8") — keep blank except the MICR line</Text>
              </Abs>
              {/* crosshairs at the check's corners */}
              {[[18, t + 6], [PAGE_W - 18, t + 6], [18, t + band.height - 6], [PAGE_W - 18, t + band.height - 6]].map(([x, y], k) => (
                <React.Fragment key={`c${k}`}>
                  <HRule x={x - 6} y={y} w={12} o={o} color="#2563EB" />
                  <Abs x={x} y={y - 6} w={0} h={12} o={o} style={{ borderLeftWidth: 0.6, borderLeftColor: '#2563EB' }} />
                </React.Fragment>
              ))}
              <MicrLineView micr={sample} band={band} o={o} font={null} />
              <Abs x={96} y={t + 74} w={420} o={o}>
                <Text style={{ fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#B42318', textAlign: 'center' }}>ALIGNMENT TEST — NOT A CHECK — VOID</Text>
              </Abs>
            </React.Fragment>
          );
        })}
        <Abs x={24} y={2} w={570} o={{ xPt: 0, yPt: 0 }}>
          <Text style={{ fontSize: 5.5, color: '#3D4F65' }}>
            {accountLabel} · layout {layout.replace('_', ' ').toLowerCase()} · printer nudge x {offsetXPt.toFixed(1)} pt, y {offsetYPt.toFixed(1)} pt.
            Print on plain paper at 100% (no "fit to page"), lay it over a sheet of check stock against a light, and adjust the nudge until the boxes sit on the stock's fields.
          </Text>
        </Abs>
      </Page>
    </Document>
  );
}
