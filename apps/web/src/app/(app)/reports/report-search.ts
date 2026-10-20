/**
 * "Ask for any report…" sidebar box (audit 06 §5 bug 8 / L.2 #8 — it did
 * nothing on Enter). Resolution order:
 *
 *   1. Deterministic catalog match (no AI): "balance sheet", "ap aging",
 *      "p&l by month", "trial balance" open that report directly.
 *   2. Anything else is handed to the NL Report Compiler (/api/reports/compile),
 *      which shows its own honest "AI unavailable" / abstain message.
 */
export interface SearchableReport {
  key: string;
  label: string;
  desc?: string;
}
export interface SearchableCategory {
  key: string;
  reports: SearchableReport[];
}

/** Common shorthand → canonical words, applied before matching. */
const SYNONYMS: Array<[RegExp, string]> = [
  [/\bp\s*&\s*l\b|\bpnl\b|\bp and l\b|\bprofit and loss\b|\bincome statement\b/g, 'profit loss'],
  [/\bbs\b/g, 'balance sheet'],
  [/\btb\b/g, 'trial balance'],
  [/\ba\/r\b|\breceivables?\b/g, 'ar'],
  [/\ba\/p\b|\bpayables?\b/g, 'ap'],
  [/\bcash ?flows?\b/g, 'cash flow'],
];

export function normalizeReportQuery(s: string): string {
  let t = s.toLowerCase();
  for (const [re, rep] of SYNONYMS) t = t.replace(re, rep);
  return t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set(['the', 'a', 'an', 'show', 'me', 'run', 'open', 'report', 'for', 'of', 'please', 'statement', 'my']);

function tokens(s: string): string[] {
  return normalizeReportQuery(s).split(' ').filter((w) => w && !STOP.has(w));
}

export interface ReportMatch {
  categoryKey: string;
  reportKey: string;
  label: string;
}

/**
 * Best catalog report for a query, or null when nothing is a confident match
 * (every query token must appear in the report label, and the label must not
 * have many unmatched words — so "p&l" picks "Profit & Loss", not "P&L by Class").
 */
export function matchCatalogReport(query: string, catalog: SearchableCategory[]): ReportMatch | null {
  const q = tokens(query);
  if (q.length === 0) return null;
  let best: { m: ReportMatch; score: number } | null = null;
  for (const cat of catalog) {
    for (const r of cat.reports) {
      const lt = tokens(r.label);
      if (lt.length === 0) continue;
      const allHit = q.every((w) => lt.includes(w) || normalizeReportQuery(r.key).split(' ').includes(w));
      if (!allHit) continue;
      const extra = lt.filter((w) => !q.includes(w)).length;
      const score = 10 - extra;
      if (!best || score > best.score) best = { m: { categoryKey: cat.key, reportKey: r.key, label: r.label }, score };
    }
  }
  return best && best.score >= 8 ? best.m : null;
}
