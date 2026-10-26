'use client';

/**
 * Processing metrics (kit rule 8 — a number is never alone): three dense figures,
 * each a value + its comparison + where it goes. Reviewed today X of Y (Z%),
 * AI auto-approved (of the reviewed), and average confidence on the open lines.
 */

import Link from 'next/link';
import { Conf, Meter, scoreStrokes } from '@meritbooks/merit-ui';
import type { BankFeedMetrics } from '@meritbooks/shared';
import styles from './bank-feed.module.css';

interface BankFeedMetricsStripProps {
  metrics: BankFeedMetrics | null;
  isLoading: boolean;
  /** "Show posted" — jump to the Posted status tab. */
  onShowPosted?: () => void;
  /** "Show under 70" — narrow to the low-confidence band. */
  onShowLow?: () => void;
}

export function BankFeedMetricsStrip({ metrics, isLoading, onShowPosted, onShowLow }: BankFeedMetricsStripProps) {
  if (isLoading) {
    return (
      <div className={styles.metrics} aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={styles.metricSkel}>
            <span className="mb-skel" style={{ width: 112, height: 12 }} aria-hidden="true" />
            <span className="mb-skel" style={{ width: 96, height: 20 }} aria-hidden="true" />
            <span className="mb-skel" style={{ width: 160, height: 12 }} aria-hidden="true" />
          </div>
        ))}
        <span className="sr" role="status">Loading today&apos;s numbers</span>
      </div>
    );
  }

  if (!metrics) return null;

  const { total_today, reviewed_today, auto_approved_today, avg_confidence } = metrics;
  const pctReviewed = total_today > 0 ? Math.round((reviewed_today / total_today) * 100) : 0;
  // The route reports 0 when no open line has been scored yet — that is "nothing
  // scored", not "0% confident", so it reads as a neutral dash rather than an alarm.
  const hasScored = Number.isFinite(avg_confidence) && avg_confidence > 0;
  const avgPct = hasScored ? Math.round(avg_confidence * 100) : null;

  return (
    <section className={styles.metrics} aria-label="Today's processing">
      {/* Reviewed today */}
      <div className={`fig ${styles.metric}`}>
        <span className="fig-l">Reviewed today</span>
        <span className={styles.metricValue}>
          <span className="fig-v fig-v--dense tnum">
            {reviewed_today.toLocaleString()} of {total_today.toLocaleString()}
          </span>
          {total_today > 0 && <Meter strokes={scoreStrokes(pctReviewed)} label={`${pctReviewed}% reviewed`} />}
        </span>
        <span className="fig-vs">
          <span className="tnum">
            {total_today > 0 ? `${pctReviewed}% of today's lines` : 'No new lines came in today'}
          </span>
        </span>
        {onShowPosted && (
          <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={onShowPosted}>
            Show posted
          </button>
        )}
      </div>

      {/* AI auto-approved */}
      <div className={`fig ${styles.metric}`}>
        <span className="fig-l">AI auto-approved</span>
        <span className={styles.metricValue}>
          <span className="fig-v fig-v--dense tnum">{auto_approved_today.toLocaleString()}</span>
        </span>
        <span className="fig-vs">
          <span className="tnum">
            {reviewed_today > 0
              ? `of ${reviewed_today.toLocaleString()} reviewed today`
              : 'Nothing reviewed yet today'}
          </span>
        </span>
        <Link className="link" href="/ai-decisions">
          AI decision log
        </Link>
      </div>

      {/* Average confidence */}
      <div className={`fig ${styles.metric}`}>
        <span className="fig-l">Avg confidence</span>
        <span className={styles.metricValue}>
          {avgPct === null ? (
            <span className="fig-v fig-v--dense tnum" title="No open lines have been scored yet">
              —<span className="sr"> no scored lines yet</span>
            </span>
          ) : (
            <Conf score={avgPct} label={`Average confidence ${avgPct} of 100`} />
          )}
        </span>
        <span className="fig-vs">
          <span>
            {avgPct === null
              ? 'No open lines scored yet'
              : avgPct >= 90
                ? 'Open lines, 90+ is ready to batch'
                : avgPct >= 70
                  ? 'Open lines, 70–89 needs one look each'
                  : 'Open lines, under 70 needs a decision'}
          </span>
        </span>
        {onShowLow && (
          <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={onShowLow}>
            Show under 70
          </button>
        )}
      </div>
    </section>
  );
}
