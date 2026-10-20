import { money, pct } from '@meritbooks/merit-ui';
import { CATEGORY_WORDS, g703 } from '@/lib/pm/ops/draw-math';
import type { DrawLineStatusRow } from '@/lib/pm/ops/types';

/**
 * The AIA G703-style continuation sheet, from pm.v_draw_line_status. Column letters follow the
 * form: C scheduled value · D from previous draws · E this draw · G completed to date · G ÷ C ·
 * H balance to finish · I retainage held. Server-safe (no state).
 */
export function ContinuationSheet({ rows, openDrawNumber }: { rows: ReadonlyArray<DrawLineStatusRow>; openDrawNumber: number | null }) {
  const { lines, totals } = g703(rows);
  return (
    <div className="mp-table" style={{ overflowX: 'auto' }}>
      <table className="g703" aria-label="Continuation sheet">
        <thead>
          <tr>
            <th className="l"><span className="col">A</span>Item</th>
            <th className="l"><span className="col">B</span>Description of work</th>
            <th><span className="col">C</span>Scheduled value</th>
            <th><span className="col">D</span>From previous draws</th>
            <th><span className="col">E</span>{openDrawNumber ? `This draw (#${openDrawNumber})` : 'This draw'}</th>
            <th><span className="col">G</span>Completed to date</th>
            <th><span className="col">G ÷ C</span>%</th>
            <th><span className="col">H</span>Balance to finish</th>
            <th><span className="col">I</span>Retainage held</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className={l.thisDraw > 0 ? 'is-open' : undefined}>
              <td className="l">{l.lineNo}</td>
              <td className="l"><span className="l1">{l.description}</span><span className="l2">{CATEGORY_WORDS[l.category]}</span></td>
              <td>{money(l.scheduled)}</td>
              <td>{money(l.previous)}</td>
              <td>{l.thisDraw ? money(l.thisDraw) : '—'}</td>
              <td>{money(l.completed)}</td>
              <td>{l.pct == null ? '—' : pct(l.pct)}</td>
              <td className={l.balance < 0 ? 'neg b' : undefined}>{money(l.balance)}</td>
              <td>{l.retainage ? money(l.retainage) : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="l" colSpan={2}>Totals</td>
            <td>{money(totals.scheduled)}</td>
            <td>{money(totals.previous)}</td>
            <td>{money(totals.thisDraw)}</td>
            <td>{money(totals.completed)}</td>
            <td>{totals.pct == null ? '—' : pct(totals.pct)}</td>
            <td>{money(totals.balance)}</td>
            <td>{money(totals.retainage)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
