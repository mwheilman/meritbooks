/**
 * Conversion Reconciliation report model (PURE, deterministic).
 *
 * The "final artifact" of the controller brief (ONBOARDING-DESIGN-SPEC §4): the
 * report the accountant holds next to QuickBooks during the parallel month. Each
 * section is MeritBooks (the live book of record) vs. the Source (the imported
 * prior-books figures), with a VARIANCE column that must be zero to go live.
 *
 * This module is pure — it takes already-computed cents on both sides and assembles
 * the sectioned model + variances. The server helper (build.ts) sources the numbers:
 * MeritBooks from the live GL + subledgers, Source from the staged conversion import.
 * All money is integer cents. The sibling test file is the correctness guarantee.
 */

export type ReconSectionKey = 'OPENING_BS' | 'AR_AGING' | 'AP_AGING' | 'WIP';

/** One reconciled line: MeritBooks vs Source, with the variance (source − merit). */
export interface ReconLine {
  key: string;
  label: string;
  /** The imported/source figure, cents (debit-positive / normal orientation). */
  sourceCents: number;
  /** The live-MeritBooks figure, cents (same orientation). */
  meritCents: number;
  /** source − merit; zero when the two sides agree. */
  varianceCents: number;
  ties: boolean;
}

export interface ReconSection {
  key: ReconSectionKey;
  label: string;
  /**
   * Whether this section is a live comparison. False = neutral (e.g. a non-job
   * business has no WIP, or no source subledger detail was imported yet) — it never
   * blocks and never shows a false green.
   */
  applicable: boolean;
  /** Optional context shown under the section header. */
  note?: string;
  lines: ReconLine[];
  sourceTotalCents: number;
  meritTotalCents: number;
  varianceCents: number;
  /** True when the section is applicable and every line ties (variance zero). */
  ties: boolean;
}

export interface ConversionReconciliation {
  sections: ReconSection[];
  /** True when every APPLICABLE section ties — the zero-variance go-live requirement. */
  ties: boolean;
  /** Total absolute variance across applicable sections, cents (0 ⇒ perfect). */
  totalAbsVarianceCents: number;
  generatedAt: string;
}

/** Build one reconciled line. Variance is source − merit. Pure. */
export function reconLine(key: string, label: string, sourceCents: number, meritCents: number): ReconLine {
  const s = Math.round(sourceCents || 0);
  const m = Math.round(meritCents || 0);
  const varianceCents = s - m;
  return { key, label, sourceCents: s, meritCents: m, varianceCents, ties: varianceCents === 0 };
}

/**
 * Assemble a section from its lines. A non-applicable section is neutral: its lines
 * still render (for reference) but it never contributes to the go-live gate and is
 * reported as tying so it cannot show a false red or a false green.
 */
export function buildSection(
  key: ReconSectionKey,
  label: string,
  lines: ReconLine[],
  opts: { applicable: boolean; note?: string },
): ReconSection {
  let sourceTotalCents = 0;
  let meritTotalCents = 0;
  for (const l of lines) {
    sourceTotalCents += l.sourceCents;
    meritTotalCents += l.meritCents;
  }
  const varianceCents = sourceTotalCents - meritTotalCents;
  const ties = !opts.applicable || (varianceCents === 0 && lines.every((l) => l.ties));
  return { key, label, applicable: opts.applicable, note: opts.note, lines, sourceTotalCents, meritTotalCents, varianceCents, ties };
}

/** Fold sections into the report + the overall zero-variance verdict. Pure. */
export function buildReconciliation(sections: ReconSection[], generatedAt: string): ConversionReconciliation {
  let totalAbsVarianceCents = 0;
  let ties = true;
  for (const s of sections) {
    if (!s.applicable) continue;
    totalAbsVarianceCents += Math.abs(s.varianceCents);
    if (!s.ties) ties = false;
  }
  return { sections, ties, totalAbsVarianceCents, generatedAt };
}

/** The offending lines across applicable sections (variance ≠ 0) — for the gate/UI. */
export function reconciliationBlockers(report: ConversionReconciliation): string[] {
  const out: string[] = [];
  for (const s of report.sections) {
    if (!s.applicable || s.ties) continue;
    for (const l of s.lines) {
      if (l.ties) continue;
      out.push(
        `${s.label}: "${l.label}" — source ${l.sourceCents} vs MeritBooks ${l.meritCents} (off by ${Math.abs(l.varianceCents)} cents).`,
      );
    }
  }
  return out;
}
