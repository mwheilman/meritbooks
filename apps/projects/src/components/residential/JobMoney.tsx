'use client';

import { Figure, InlineNotice, Status, money } from '@meritbooks/merit-ui';
import type { CashPosition, MarginFade } from '@/app/api/residential/jobs/[jobId]/money/route';
import { Section } from '@/components/ops/common/bits';
import { BoardState, Empty, pctText, useBoard } from '@/components/dealer/common/depth';

interface Data { cash: CashPosition; fade: MarginFade; alerts: Array<{ id: string; kind: string; status: string; raised_at: string }> }

/** Job cash position (RES-84) and the margin-fade warning (RES-122) with the cost codes that moved. */
export function JobMoney({ jobId }: { jobId: string }) {
  const b = useBoard<Data>(`/api/residential/jobs/${jobId}/money`);
  const state = <BoardState b={b} what="Job money" />;
  if (!b.data) return state;
  const { cash, fade } = b.data;
  return (
    <div className="stack">
      {!cash.books_available && <InlineNotice tone="info" title="Books is not connected for this company.">Cash collected shows once Merit Books holds the job's invoices and deposits.</InlineNotice>}
      {cash.negative && <InlineNotice tone="warn" title="This job is cash-negative.">{cash.why}</InlineNotice>}
      {fade.fading && <InlineNotice tone="warn" title="Margin is fading.">{fade.why}</InlineNotice>}
      <div className="dl-strip">
        <Figure dense label="Cash position" value={money(cash.cash_position_cents, { decimals: 0 })} vs={[`collected ${money(cash.cash_collected_cents, { decimals: 0 })}`, `cost ${money(cash.cost_incurred_cents, { decimals: 0 })}`]} href={`/job-cost?job=${jobId}`} linkLabel="Job cost" />
        <Figure dense label="After open commitments" value={money(cash.cash_after_commitments_cents, { decimals: 0 })} vs={[`committed ${money(cash.committed_open_cents, { decimals: 0 })}`, `deposit coverage ${pctText(cash.deposit_coverage_pct, 0)}`]} href={`/commitments?job=${jobId}`} linkLabel="Commitments" />
        <Figure dense label="Open AR" value={money(cash.open_ar_cents, { decimals: 0 })} vs={[`billed ${money(cash.billed_to_date_cents, { decimals: 0 })}`, cash.next_draw ? `next draw #${cash.next_draw.draw_number} ${cash.next_draw.status.toLowerCase()}` : 'no draw open']} href={`/billing?job=${jobId}`} linkLabel="Billing" />
        <Figure dense label="Projected margin" value={pctText(fade.projected_margin_pct)} vs={[`sold ${pctText(fade.sold_margin_pct)}`, fade.fade_points == null ? 'no baseline' : `${fade.fade_points > 0 ? 'down' : 'up'} ${pctText(Math.abs(fade.fade_points))}`]} href={`/job-cost?job=${jobId}`} linkLabel="Margin" />
      </div>
      <Section title="Cost codes that moved" meta={`${fade.missing_change_orders} with no change order · ${fade.field_cos_unpriced} field requests unpriced`}>
        {fade.moved_codes.length === 0 ? <Empty title="Every cost code is inside its budget" body="Codes whose forecast passes the budget show here with whether a change order covers them." /> :
          <table className="ops-mini" aria-label="Cost codes over budget"><thead><tr><th>Code</th><th className="n">Budget</th><th className="n">Forecast</th><th className="n">Over</th><th>Change order</th></tr></thead>
            <tbody>{fade.moved_codes.map((c) => <tr key={c.cost_code_id}><td>{c.code} · {c.name}</td><td className="n">{money(c.budget_cents, { decimals: 0 })}</td><td className="n">{money(c.forecast_cents, { decimals: 0 })}</td>
              <td className="n neg">{money(c.over_cents, { decimals: 0 })}</td><td>{c.change_order_on_code ? <Status kind="ready" pip="ready">On a CO</Status> : <Status kind="risk" pip="risk">Missing CO?</Status>}</td></tr>)}</tbody></table>}
      </Section>
    </div>
  );
}
