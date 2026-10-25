'use client';

import { useState } from 'react';
import { money } from '@/lib/portal/format';
import { t } from '@/lib/portal/i18n';
import type { DrawLine, Locale, PortalHome } from '@/lib/portal/types';
import { DecisionPanel } from './DecisionPanel';

/** The draw package by lender budget line; the lender may approve each line for less than requested. */
export function DrawReview({ orgId, drawId, lines, locale, canDecide, decided, verified, phoneHint, company }: {
  orgId: string; drawId: string; lines: readonly DrawLine[]; locale: Locale; canDecide: boolean; decided: string | null;
  verified: PortalHome['verified']; phoneHint: string | null; company: string;
}) {
  const [approved, setApproved] = useState<Record<string, number>>({});
  const total = (k: 'budget_cents' | 'previous_cents' | 'this_period_cents') => lines.reduce((s, l) => s + l[k], 0);
  const approvedTotal = lines.reduce((s, l) => s + (approved[l.line_id] ?? l.this_period_cents), 0);
  const changed = lines.filter((l) => approved[l.line_id] !== undefined && approved[l.line_id] !== l.this_period_cents)
    .map((l) => ({ line_id: l.line_id, approved_cents: approved[l.line_id] }));
  return (
    <div>
      <div className="pt-scroll">
        <table className="pt-tbl">
          <thead><tr><th>{t(locale, 'draw.line')}</th><th className="n">{t(locale, 'draw.budget')}</th><th className="n">{t(locale, 'draw.previous')}</th>
            <th className="n">{t(locale, 'draw.this_period')}</th>{canDecide && <th className="n">{t(locale, 'draw.approve_amount')}</th>}<th className="n">{t(locale, 'draw.remaining')}</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.line_id}>
                <td>{l.line_no}. {l.description}</td>
                <td className="n">{money(l.budget_cents, locale)}</td>
                <td className="n">{money(l.previous_cents, locale)}</td>
                <td className="n">{money(l.this_period_cents, locale)}</td>
                {canDecide && (
                  <td className="n">
                    <input type="number" min={0} step="0.01" inputMode="decimal" style={{ width: 110, textAlign: 'right' }} aria-label={`${t(locale, 'draw.approve_amount')} ${l.description}`}
                           defaultValue={(l.this_period_cents / 100).toFixed(2)}
                           onChange={(e) => {
                             const cents = Math.round(Number(e.target.value) * 100);
                             if (Number.isFinite(cents)) setApproved((a) => ({ ...a, [l.line_id]: Math.min(Math.max(0, cents), l.this_period_cents) }));
                           }} />
                  </td>
                )}
                <td className="n">{money(l.budget_cents - l.previous_cents - (approved[l.line_id] ?? l.this_period_cents), locale)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>{t(locale, 'item.total')}</td><td className="n">{money(total('budget_cents'), locale)}</td><td className="n">{money(total('previous_cents'), locale)}</td>
              <td className="n">{money(total('this_period_cents'), locale)}</td>{canDecide && <td className="n">{money(approvedTotal, locale)}</td>}
              <td className="n">{money(total('budget_cents') - total('previous_cents') - approvedTotal, locale)}</td></tr>
          </tfoot>
        </table>
      </div>
      {(canDecide || decided) && (
        <div style={{ marginTop: 16 }}>
          <DecisionPanel orgId={orgId} kind="draw" id={drawId} locale={locale} company={company} canAct={canDecide} verified={verified}
                         phoneHint={phoneHint} decided={decided} lines={changed.length ? changed : null} />
        </div>
      )}
    </div>
  );
}
