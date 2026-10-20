/**
 * Binding-rule lint over the package source (Style Guide §1.2, §2, §3, §4, §10).
 * Fails the build if any banned class, family, library or word appears in src/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const srcDir = join(root, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(p) ? [p] : [];
  });
}

const RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'rounded corners (square everywhere; .kbd is the only radius)', re: /(?:className|class)=[^>]*\brounded\b|\brounded-(?!none\b|kbd\b)[a-z0-9[]|border-?radius/i },
  { name: 'monospace (figures are DM Sans tabular)', re: /\bfont-mono\b|JetBrains|monospace/i },
  { name: 'emerald theme (retired)', re: /emerald|#10b981/i },
  { name: 'Plus Jakarta Sans (retired)', re: /Plus Jakarta/i },
  { name: 'lucide icons (use the sprite)', re: /lucide/i },
  { name: 'banned vocabulary: portfolio / portco / holding company', re: /portfolio|portco|holding company/i },
  { name: 'banned state copy', re: /No data/ },
  { name: 'banned marketing words', re: /\b(synergy|leverage|best in class|world-class|revolutioni[sz]e)\b/i },
  { name: 'gradients/glows/shimmer utilities', re: /\bbg-gradient-|\bshadow-(?:sm|md|lg|xl|2xl|inner)\b|\bblur-|\bbackdrop-blur/ },
  { name: 'emoji', re: /[\u{1F300}-\u{1FAFF}\u{2728}]/u },
  { name: 'Tailwind default palette utilities', re: /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|green|emerald|indigo|violet|amber|yellow)-\d{2,3}\b/ },
];

describe('banned classes and strings in packages/merit-ui/src', () => {
  const files = walk(srcDir);

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  for (const rule of RULES) {
    it(`no ${rule.name}`, () => {
      const hits: string[] = [];
      for (const f of files) {
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (rule.re.test(line)) hits.push(`${relative(root, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
          });
      }
      expect(hits).toEqual([]);
    });
  }

  it('Syne is never set inside table/button components (font-display only via kit classes)', () => {
    const hits = files.filter((f) => /tables\/|Button\.tsx/.test(f) && /font-display|f-display|Syne/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(root, f))).toEqual([]);
  });

  it('every <svg> rendered by the package carries .ico (or is the hidden sprite)', () => {
    const hits: string[] = [];
    for (const f of files.filter((p) => p.endsWith('.tsx'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<svg\b[^>]*>/g)) {
        if (!/cx\('ico'|class="ico/.test(m[0]) && !/width="0" height="0"/.test(m[0])) hits.push(`${relative(root, f)}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
