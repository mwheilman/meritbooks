/** WIP CSV export: formula injection neutralized, numbers (incl. negatives) stay numeric. */
import { describe, it, expect } from 'vitest';
import { csvCell } from './wip-view';

describe('WIP csvCell', () => {
  it.each([
    ['=HYPERLINK("http://x","click")', `"'=HYPERLINK(""http://x"",""click"")"`],
    ['+cmd', "'+cmd"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['  =1+1', "'  =1+1"],
    ['\tTAB', "'\tTAB"],
  ])('neutralizes %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
  it('leaves plain text and numbers alone', () => {
    expect(csvCell('Main St remodel')).toBe('Main St remodel');
    expect(csvCell('-1250.00')).toBe('-1250.00');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('12.5')).toBe('12.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell('a, b')).toBe('"a, b"');
  });
});
