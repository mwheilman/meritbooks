/**
 * Binding copy/design rules over apps/projects/src (Style Guide v2.3 §1.2, §2–4, §10).
 * Scans product source; *.test.* files are skipped because lint tests carry the
 * banned words as their own patterns.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(__dirname, '..');
const self = resolve(__filename);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(p) && !/\.test\.tsx?$/.test(p) && p !== self ? [p] : [];
  });
}

// Built from parts so this file never matches itself.
const RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'emer' + 'ald (retired theme)', re: new RegExp('emer' + 'ald', 'i') },
  { name: 'rounded- (only none/kbd)', re: new RegExp('\\brou' + 'nded-(?!none\\b|kbd\\b)') },
  { name: 'font-mono', re: new RegExp('\\bfont-' + 'mono\\b') },
  { name: 'luc' + 'ide icons', re: new RegExp('luc' + 'ide', 'i') },
  { name: 'port' + 'folio', re: new RegExp('port' + 'folio', 'i') },
  { name: '"No da' + 'ta"', re: new RegExp('No da' + 'ta') },
  { name: 'banned marketing words', re: new RegExp('\\b(syn' + 'ergy|lever' + 'age|best in cl' + 'ass|world-cl' + 'ass|revolutioni[sz]e|soluti' + 'ons)\\b', 'i') },
  { name: 'one-word product name', re: new RegExp('Merit' + 'Projects|Merit' + 'Books(?![-_/.a-z])') },
];

describe('banned strings in apps/projects/src', () => {
  const files = walk(src);

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  for (const rule of RULES) {
    it(`no ${rule.name}`, () => {
      const hits: string[] = [];
      for (const f of files) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (rule.re.test(line)) hits.push(`${relative(src, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }

  it('only palette hexes appear in app code', () => {
    const palette = new Set(['#2563EB', '#3B82F6', '#0A1628', '#3D4F65', '#8494A7', '#FDFCFA', '#F5F3EF', '#EBF2FE', '#FFFFFF', '#536A82', '#E1E5EA', '#CCD3DB', '#1F6E50', '#B42318', '#8A5A00']);
    const hits: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/#[0-9a-fA-F]{6}\b/g)) if (!palette.has(m[0].toUpperCase())) hits.push(`${relative(src, f)}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});
