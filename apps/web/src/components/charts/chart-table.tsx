/**
 * ChartTableView — the accessible table behind every chart. Same ChartTable the
 * exports use. Kit statement grammar: blue header rule, tabular figures,
 * right-aligned numbers, totals bold over a Midnight rule, (P)/(F) markers.
 */
import { cellText, type ChartTable } from './core/table';

export interface ChartTableViewProps {
  table: ChartTable;
  /** Visually hidden caption is still read; show it when the table stands alone. */
  showCaption?: boolean;
  /** Row click → drill (same keys the chart hands to onDrill). */
  onRowDrill?: (key: string) => void;
  className?: string;
  id?: string;
}

export function ChartTableView({ table, showCaption, onRowDrill, className, id }: ChartTableViewProps) {
  return (
    <div className={className ? `mc-tbl-wrap ${className}` : 'mc-tbl-wrap'} id={id}>
      <table className="mc-tbl">
        <caption className={showCaption ? 'mc-tbl-cap' : 'sr'}>{table.caption}</caption>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} scope="col" className={c.unit ? 'n' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => {
            const drill = onRowDrill ? () => onRowDrill(r.key) : undefined;
            return (
              <tr
                key={r.key}
                className={[r.emphasis ? `is-${r.emphasis}` : '', r.status && r.status !== 'closed' ? `is-${r.status}` : '', drill ? 'is-link' : ''].filter(Boolean).join(' ') || undefined}
                onClick={drill}
                onKeyDown={drill ? (e) => (e.key === 'Enter' ? drill() : undefined) : undefined}
                tabIndex={drill ? 0 : undefined}
              >
                {r.cells.map((cell, j) => {
                  const col = table.columns[j];
                  const text = cellText(cell, col);
                  if (j === 0)
                    return (
                      <th key={j} scope="row">
                        {text}
                        {r.status === 'preliminary' && <abbr className="mc-mk" title="Preliminary — the period is not closed">P</abbr>}
                        {r.status === 'forecast' && <abbr className="mc-mk" title="Forecast">F</abbr>}
                      </th>
                    );
                  return (
                    <td key={j} className={col?.unit ? 'n' : undefined}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {table.notes?.map((n, i) => (
        <p key={i} className="mc-tbl-note">
          {n}
        </p>
      ))}
    </div>
  );
}
