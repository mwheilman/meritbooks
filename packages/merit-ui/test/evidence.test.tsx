import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Evidence, Note } from '../src/ai/Note';
import { EvidenceMismatchError, assertEvidenceTies, evidenceSum } from '../src/ai/evidence';
import { StatementTable, StatementTieError, assertStatementTies, type StatementColumn, type StatementRow } from '../src/tables/StatementTable';

// Kit note 1: Heartland's materials ran $81,941 over budget.
const rows = [
  { label: 'Ferguson, +7.5% from Aug 15', value: 2_140_000 },
  { label: 'Johnstone Supply, +4.0% from Sep 1', value: 890_000 },
  { label: 'More jobs started than budgeted', value: 5_164_100 },
];

describe('Evidence must sum to the claim', () => {
  it('assertEvidenceTies passes when rows sum exactly', () => {
    expect(evidenceSum(rows)).toBe(8_194_100);
    expect(assertEvidenceTies(rows, 8_194_100, 'Heartland over budget')).toBe(8_194_100);
  });

  it('throws EvidenceMismatchError when off by even one cent', () => {
    expect(() => assertEvidenceTies(rows, 8_194_101, 'Heartland over budget')).toThrow(EvidenceMismatchError);
    try {
      assertEvidenceTies(rows, 8_194_101, 'Heartland over budget');
    } catch (e) {
      expect((e as EvidenceMismatchError).expected - (e as EvidenceMismatchError).actual).toBe(1);
      expect((e as Error).message).toMatch(/off by 1/);
    }
  });

  it('refuses non-integer values', () => {
    expect(() => evidenceSum([{ label: 'x', value: 0.5 }])).toThrow();
  });

  it('renders the dotted-leader ledger with the total line (.ev-total)', () => {
    const html = renderToStaticMarkup(<Evidence rows={rows} total={{ label: 'Heartland over budget', value: 8_194_100 }} format={{ decimals: 0 }} />);
    expect(html).toContain('class="ev"');
    expect(html).toContain('<li class="ev-total">Heartland over budget<span class="dl"></span><span class="v">81,941</span></li>');
    expect(html).toContain('21,400');
    expect(html.match(/<span class="dl"><\/span>/g)?.length).toBe(4);
  });

  it('computes and renders the total when none is given', () => {
    const html = renderToStaticMarkup(<Evidence rows={rows} total={{ label: 'Total' }} format={{ decimals: 0 }} />);
    expect(html).toContain('<span class="v">81,941</span></li></ul>');
  });

  it('throws in development when the given total does not tie', () => {
    expect(() => renderToStaticMarkup(<Evidence rows={rows} total={{ label: 'Wrong', value: 1 }} />)).toThrow(EvidenceMismatchError);
  });

  it('a Note renders claim, evidence, basis and actions in the kit structure', () => {
    const html = renderToStaticMarkup(
      <Note n={1} kind="Margin" title="Heartland’s materials ran $81,941 over budget" evidence={{ rows, total: { label: 'Heartland over budget', value: 8_194_100 }, format: { decimals: 0 } }} basis={{ confidence: 88, items: ['612 GL lines · 3 price letters'] }}>
        Two supplier increases hit jobs quoted before they took effect.
      </Note>,
    );
    expect(html).toContain('<article class="note" id="note-1" data-note="1"');
    expect(html).toContain('<span class="note-no" aria-hidden="true">1</span>');
    expect(html).toContain('Note 1 · Margin');
    expect(html).toContain('class="basis"');
    expect(html).toContain('aria-label="Confidence 88 of 100"');
  });
});

describe('Statement totals tie', () => {
  const columns: StatementColumn[] = [
    { id: 'sep', header: 'Sep 2026', current: true },
    { id: 'aug', header: 'Aug 2026' },
  ];
  const good: StatementRow[] = [
    { kind: 'head', label: 'Revenue' },
    { kind: 'line', id: 'contract', label: 'Contract revenue', values: [350_350_000, 371_290_000] },
    { kind: 'line', id: 'co', label: 'Change orders', values: [12_000_000, 9_000_000] },
    { kind: 'elim', id: 'elim', label: 'Intercompany eliminations', values: [-3_120_000, -3_120_000] },
    { kind: 'sub', id: 'rev', label: 'Total revenue', values: [359_230_000, 377_170_000], sumOf: ['contract', 'co', 'elim'] },
    { kind: 'line', id: 'cost', label: 'Job cost', values: [300_000_000, 310_000_000] },
    { kind: 'gap' },
    { kind: 'grand', label: 'Gross profit', values: [59_230_000, 67_170_000], sumOf: ['rev', { id: 'cost', sign: -1 }] },
  ];

  it('passes when every total equals its rows', () => {
    expect(() => assertStatementTies(good, columns)).not.toThrow();
  });

  it('throws StatementTieError on a total that does not tie', () => {
    const bad = good.map((r) => (r.kind === 'grand' ? { ...r, values: [59_230_001, 67_170_000] } : r));
    expect(() => assertStatementTies(bad, columns)).toThrow(StatementTieError);
  });

  it('renders parentheses, hanging parens and the grand-total row', () => {
    const html = renderToStaticMarkup(<StatementTable unitLabel="In US dollars" columns={columns} rows={good} />);
    expect(html).toContain('class="tbl tbl-fs"');
    expect(html).toContain('(31,200.00)');
    expect(html).toContain('3,503,500.00<span class="hp">)</span>');
    expect(html).toContain('<tr class="fs-grand">');
    expect(html).toContain('<tr class="fs-line fs-elim">');
    expect(html).toContain('<th scope="col" class="n cur">Sep 2026</th>');
  });
});
