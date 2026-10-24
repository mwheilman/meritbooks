# Chart kit: proposal to promote into `packages/merit-ui`

**Slice 3C (Wave 3).** Covers FEATURE-GAP-AUDIT FP-02 and RP-12, §4.4 (the ChartCard frame contract), D-PARTNER-PORTAL §2 / M3 / M7, and E-REPORTING §4 (U1, U6, U10, U15).
**Built in:** `apps/web/src/components/charts/`. It lives in Books for now because another session owns `packages/merit-ui`, and Books needs to ship.
**Status:** built, typechecked (scoped `tsc`), 74 vitest cases passing, rendered and driven in headless Chromium. Gallery at `/reports/chart-kit`, guarded by `settings_system:view`. **No migration.**

---

## 1. What exists

| Layer | Files | Notes |
|---|---|---|
| Data contract | `core/types.ts` | Money in integer cents and percents as fractions. `null` means a gap. Each period has a `PeriodStatus` (`closed`, `preliminary` or `forecast`). Each metric has a `MetricDirection`. The `UnavailableReason` values follow §4.3. `MetricSeriesLike` + `fromMetricSeries()` is the adapter seam for 3B. |
| Pure maths | `core/scale.ts`, `core/series.ts` | Nice ticks (1/2/2.5/5×10ⁿ, no float noise). Money steps are whole dollars, bars start at zero, and flat or negative domains are handled. Also band, point and linear scales; gap segments; a TTM that refuses to invent; bridge running totals with a **tie check**; a diverging stack; variance F/U; shares (losses kept outside the 100%); direction-aware percentile ranks. |
| Formatting | `core/format.ts` | Built on merit-ui `money`, `compactMoney`, `pct` and `pts`, so it is integer-safe. Each axis uses one compact scale with the fewest decimals that keep every tick exact. Margins move in **points**. Relative change is n/m when the base is ≤ 0 or the sign flips. Covenants show two decimals (1.25x). |
| Sentences | `core/summary.ts` | Deterministic one- or two-sentence summaries for each chart type. They double as alt text. Acronyms (EBITDA, DSO) stay upper-case. |
| Table / export | `core/table.ts`, `core/xlsx.ts`, `core/export-image.ts` | `ChartTable` is the one model behind View as table, CSV, XLSX and print. CSV writes money as decimal dollars from cents, percents as `13.1%`, gaps as empty cells, and starts with a BOM. XLSX is a zero-dependency OOXML writer that runs in the browser (stored ZIP; accounting format; frozen header; opens in openpyxl and Excel). SVG/PNG export clones the SVG and inlines its computed paint. |
| React plumbing | `core/hooks.ts`, `core/parts.tsx`, `core/time.ts` | ResizeObserver width at a fixed height, so there is no layout shift. A roving tab stop: ← → Home End, Enter/Space to drill, Esc. ChartCard context carries legend-hidden series and the live announcer. Hatch `<pattern>`s are created per chart. Tooltip. Axes. |
| Frame | `chart-card.tsx`, `chart-state.tsx`, `chart-table.tsx`, `change-chip.tsx`, `legend.tsx` | See §2. |
| Charts | `monthly-combo.tsx`, `time-series-chart.tsx` (line, area, fan), `bar-chart.tsx` (grouped or stacked, vertical or horizontal; also the maturity ladder), `variance-bars.tsx`, `waterfall-chart.tsx`, `combo-chart.tsx`, `sparkline.tsx`, `share-bars.tsx` (ShareBars + Donut), `heat-grid.tsx`, `scatter-chart.tsx`, `bullet-chart.tsx`, `threshold-gauge.tsx`, `aging-bars.tsx`, `sparkline-table.tsx` (+ `SparkRow`), `kpi-tile.tsx` | Every chart reads the card's legend state. Every point is a keyboard stop with a full value label. |
| Styles | `charts.css` (`.mc-*`) | Kit tokens only (`var(--…)`), square geometry, DM Sans tabular figures, Syne only for the report-density title. Container queries handle the 390 px layout. The print block prints the table under the chart and hides controls. |
| QA | `gallery/chart-gallery.tsx`, `gallery/samples.ts`, `app/(app)/reports/chart-kit/page.tsx` | Every card is tagged "Sample". A test fails the build if any non-gallery file imports `gallery/samples`. |

## 2. The ChartCard contract (as built)

Each part of the card, top to bottom:
- **Header:** `01 // EYEBROW` · title (Syne 20 Electric in `density-report`, DM Sans 15/600 in cockpit) · basis line.
- **Header actions:** period chip · (i) definition popover (text, formula, source, and an optional **Edit definition** for administrators) · **View as table** (`aria-pressed`) · **Export ▾** (CSV, Excel, PNG, SVG).
- **Headline:** the figure, plus a **ChangeChip** (arrow + figure + *improvement/erosion* + colour, worded from the metric's direction).
- **Summary sentence:** required. It is `aria-labelledby` on the SVG together with the title.
- **Legend:** series are toggle buttons. Encodings (hatch = preliminary, loss) are listed but are not toggles. `seriesLegend()` derives swatches from the bar palette index, so a legend can't disagree with its chart.
- **Body:** the chart, the table, or a state. The reserved `height` means swapping between them never shifts layout.
- **States:** `loading` (skeleton bars, `aria-busy`), `empty` (title, body, next action), `unavailable` (reason copy from §4.3, overridable detail) and `error` (`role=alert`, retry). The banned "No data" copy is never used.
- **Footer:** *Books closed through …*, footnotes (`timeSeriesFootnotes()` names preliminary months, forecast months and gaps), and a drill hint.
- **Print:** the same table is in the DOM and prints under the chart.
- **Live region:** announces legend toggles, the view switch and exports.

**Encodings:** actual is Electric. Prior year is a dashed Midnight line. The budget is Midnight tick marks. Preliminary is Electric-on-Blue-200 hatch: on bars for bar charts, as a hatched column behind line charts. Forecast is dotted or outlined. Unfavourable is brick hatch. A gap is a dotted hairline plus "n/a", never zero. TTM sits in a **synced sub-panel**, never on a second axis. Bars always start at zero. The series palette is luminance-separated (Electric, Midnight, Blue-300, Steel, Blue-200, Grey-400), and severity adds hatch, so nothing reads by colour alone.

## 3. Promote into merit-ui — recommended order

1. **`core/*` pure modules** go to `packages/merit-ui/src/charts/core/*` unchanged. They depend only on merit-ui's own `format.ts`. Move the tests with them.
2. **`charts.css`** goes to `packages/merit-ui/styles/charts.css`, imported after `marks.css` in the cascade (README §3). The kit's `system.css` stays verbatim. If the kit owner adopts these rules, they become a kit v2.4 section `13. CHARTS`.
3. **Components:** ChartCard, the states, the table view, ChangeChip, Legend, then the charts. They already use kit classes (`.eyebrow`, `.sl`, `.tag`, `.status`, `.pip`, `.btn`, `.seg`) and merit-ui `Popover`/`Pip`.
4. **Swap the barrel:** `apps/web/src/components/charts/index.ts` becomes `export * from '@meritbooks/merit-ui/charts'`. Books call sites don't change.

**Changes to make during promotion:**
- Point the gallery's `Sample` tag at the kit's `Tag`. Replace the inline (i) and caret glyphs with `Icon` once the sprite gains `info`/`download`; the sprite currently has neither.
- Add `esbuild: { jsx: 'automatic' }` to the vitest configs. `apps/web` currently uses the classic runtime for `.tsx` under vitest, which is why `charts.render.test.ts` sets `globalThis.React`.
- `ThresholdGauge` names its hatch pattern by label. Switch to `useId` if two gauges with the same label are ever on one page.
- PNG export falls back to the system sans unless DM Sans is installed, because canvas can't load web fonts from an SVG image. SVG export keeps the font declaration. Inlining the woff2 as a data URL is possible if PNG fidelity matters.

## 4. What the parallel slices consume

- **3A (report engine / viewer):** use `ChartCard` + `MonthlyCombo` / `WaterfallChart` / `VarianceBars` on statement pages. Build the card's `table` with `timeSeriesTable` / `bridgeTable` / `varianceTable` from the same engine output, and pass `closedThrough` from period locks. `onDrill(periodKey)` and `onRowDrill` hand back the period or row key for the drill panel.
- **3B (metrics):** if `lib/metrics` emits `MetricSeriesLike`-compatible series, `fromMetricSeries()` maps them. Unavailable states map one-to-one onto `UnavailableReason`. Sparklines and bridges take `Value[]` and `BridgeStep[]` directly.
- **3D (governance):** feed `closedThrough` and the preliminary/forecast `PeriodStatus` per period. Restatement notes go in `footnotes`.
- **3E (flux):** `VarianceBars` + `varianceTable` (F/U by direction, n/m when plan ≤ 0) covers the flux list visual.

## 5. Kit items not yet built (from §4.4)

- **S-curve (job billing):** use `TimeSeriesChart variant="line"` on cumulative values. A dedicated planned-vs-actual S-curve with a "% complete" axis is a 4A follow-up.
- **League table:** the sortable `SparklineTable` and `HeatGrid` cover most of it. A full portal-parity league table (rank columns, sticky first column, kind badges, stale "as of") belongs on the 4A screen, built from `SparkRow`.
- **Synced crosshair across separate cards:** within MonthlyCombo the bars and the TTM panel are synced. Syncing across cards needs a shared context and is left for 4A.
