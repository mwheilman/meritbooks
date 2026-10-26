'use client';

/**
 * The read-only "why" blocks shared by the edit panel and the confidence
 * explainer. Both read the deterministic /api/bank-feed/[id]/insight endpoint:
 * the documented composite match score (Vendor 40% + Amount 40% + Date 20%)
 * and the auto-approve check (confidence ≥ threshold AND amount ≤ cap AND a
 * trusted vendor). Pure arithmetic, no live model.
 */

import { Conf, PanelSection, Status, Tag } from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import s from './bank-feed-panels.module.css';

export interface AutoApproveInsight {
  eligible: boolean;
  tier: 'auto' | 'review' | 'escalate';
  reason: string;
  confidence: number | null;
  amountCents: number;
  autoThreshold: number;
  autoMaxCents: number | null;
  trustedVendor: boolean | null;
  checks: { confidenceOk: boolean; amountOk: boolean; vendorTrusted: boolean };
}

export interface MatchBreakdownInsight {
  breakdown: {
    score: number;
    vendorScore: number;
    amountScore: number;
    dateScore: number;
    explanation: string;
  } | null;
  candidateLabel: string | null;
  matchType: string | null;
  matchConfidence: number | null;
}

const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);

/** One auto-approve rule: pip + word ("Met" / "Not met") + the rule. */
function AutoCheck({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={s.check}>
      <Status kind={ok ? 'ready' : 'risk'}>{ok ? 'Met' : 'Not met'}</Status>
      <span className="tnum">{label}</span>
    </li>
  );
}

/** Auto-approve eligibility: the three rules and the server's reason. */
export function AutoApproveSection({ insight }: { insight: AutoApproveInsight }) {
  const trusted =
    insight.trustedVendor == null
      ? 'Trusted vendor (no vendor identified)'
      : insight.trustedVendor
        ? 'Trusted vendor'
        : 'Trusted vendor (not marked trusted)';
  return (
    <PanelSection
      title="Auto-approve"
      meta={<Tag tone={insight.eligible ? 'pos' : 'warn'}>{insight.eligible ? 'Eligible' : 'Needs review'}</Tag>}
    >
      <ul className={s.checks}>
        <AutoCheck
          ok={insight.checks.confidenceOk}
          label={`Confidence ${insight.confidence == null ? '—' : `${pct(insight.confidence)}%`} ≥ ${Math.round(insight.autoThreshold * 100)}%`}
        />
        <AutoCheck
          ok={insight.checks.amountOk}
          label={`Amount ${formatMoney(insight.amountCents)} ≤ ${insight.autoMaxCents == null ? 'no cap' : formatMoney(insight.autoMaxCents)}`}
        />
        <AutoCheck ok={insight.checks.vendorTrusted} label={trusted} />
      </ul>
      <p className={`t-cap ${s.para}`}>{insight.reason}</p>
    </PanelSection>
  );
}

/** One weighted component of the composite score: name, weight, meter + number. */
function ScoreRow({ label, weight, value }: { label: string; weight: string; value: number }) {
  const v = pct(value);
  return (
    <li className={s.score}>
      <span className="ink">{label}</span>
      <span className="t-cap tnum">{weight} weight</span>
      <Conf score={v} label={`${label} score ${v} of 100`} />
    </li>
  );
}

/** Composite match score — Vendor 40% + Amount 40% + Date 20%. */
export function MatchScoreSection({ match, showExplanation = false }: { match: MatchBreakdownInsight; showExplanation?: boolean }) {
  const b = match.breakdown;
  if (!b) return null;
  return (
    <PanelSection
      title="Match score"
      meta={
        <span className={s.metaFig}>
          {match.candidateLabel && <span className="t-cap mb-trunc">vs {match.candidateLabel}</span>}
          <b className="tnum">{pct(b.score)}%</b>
        </span>
      }
    >
      <ul className={s.scores}>
        <ScoreRow label="Vendor" weight="40%" value={b.vendorScore} />
        <ScoreRow label="Amount" weight="40%" value={b.amountScore} />
        <ScoreRow label="Date" weight="20%" value={b.dateScore} />
      </ul>
      {showExplanation && <p className={`t-cap ${s.para}`}>{b.explanation}</p>}
    </PanelSection>
  );
}
