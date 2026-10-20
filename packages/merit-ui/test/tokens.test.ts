import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import preset from '../tailwind/preset';

const root = resolve(__dirname, '..');
const systemCss = readFileSync(join(root, 'styles/system.css'), 'utf8');

/** :root { --name: value; … } from system.css. */
function rootTokens(css: string): Map<string, string> {
  const block = /:root\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) out.set(`--${m[1]}`, (m[2] ?? '').trim());
  return out;
}

const tokens = rootTokens(systemCss);
const hex = (v: string | undefined) => (v ?? '').toUpperCase();

type ColorTree = Record<string, string | Record<string, string>>;
const colors = (preset.theme?.colors ?? {}) as ColorTree;

/** preset color path → system.css variable. */
function varFor(key: string, sub?: string): string {
  if (sub === undefined || sub === 'DEFAULT') return `--${key}`;
  if (sub === 'wash') return `--${key}-wash`;
  return `--${key}-${sub}`;
}

const PALETTE = new Set<string>();
for (const [k, v] of tokens) if (/^#[0-9a-f]{6}$/i.test(v)) PALETTE.add(hex(v)), void k;

describe('preset ↔ system.css tokens', () => {
  it('system.css is the verbatim kit v2.3 file (hash pinned in KIT_VERSION)', () => {
    const sha = createHash('sha256').update(readFileSync(join(root, 'styles/system.css'))).digest('hex');
    const pinned = /sha256 ([0-9a-f]{64})/.exec(readFileSync(join(root, 'KIT_VERSION'), 'utf8'))?.[1];
    expect(sha).toBe(pinned);
    const kit = '/home/claude/brand/kit-b/Merit-Suite-Style-Kit/reference/system.css';
    if (existsSync(kit)) expect(createHash('sha256').update(readFileSync(kit)).digest('hex')).toBe(sha);
  });

  it('every preset color equals its system.css :root value', () => {
    const checked: string[] = [];
    for (const [key, value] of Object.entries(colors)) {
      if (key === 'transparent' || key === 'current') continue;
      if (typeof value === 'string') {
        expect(hex(value), key).toBe(hex(tokens.get(varFor(key))));
        checked.push(key);
      } else {
        for (const [sub, v] of Object.entries(value)) {
          expect(hex(v), `${key}.${sub}`).toBe(hex(tokens.get(varFor(key, sub))));
          checked.push(`${key}.${sub}`);
        }
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(30);
  });

  it('every system.css palette hex is available in the preset (nothing missing, nothing extra)', () => {
    const presetHexes = new Set<string>();
    for (const v of Object.values(colors)) {
      if (typeof v === 'string') {
        if (v.startsWith('#')) presetHexes.add(hex(v));
      } else Object.values(v).forEach((x) => presetHexes.add(hex(x)));
    }
    expect([...PALETTE].sort()).toEqual([...presetHexes].sort());
  });

  it('spacing, type sizes and shadows mirror the tokens', () => {
    const spacing = preset.theme?.spacing as Record<string, string>;
    expect(spacing.half).toBe(tokens.get('--s-half'));
    for (const n of [1, 2, 3, 4, 5, 6, 8]) expect(spacing[String(n)], `spacing ${n}`).toBe(tokens.get(`--s${n}`));
    expect(spacing.rail).toBe(tokens.get('--rail'));
    expect(spacing['rail-mini']).toBe(tokens.get('--rail-mini'));
    expect(spacing.bar).toBe(tokens.get('--bar'));
    expect(spacing.ctxline).toBe(tokens.get('--ctxline'));
    expect(spacing.row).toBe(tokens.get('--row'));

    const fs = preset.theme?.fontSize as Record<string, [string, { lineHeight: string }]>;
    const pairs: Array<[string, number]> = [['cap', 12], ['ui', 13], ['body', 15], ['section', 20], ['title', 28], ['display', 40]];
    for (const [name, px] of pairs) {
      expect(fs[name]?.[0]).toBe(tokens.get(`--t-${px}`));
      expect(fs[name]?.[1].lineHeight).toBe(tokens.get(`--lh-${px}`));
    }

    const shadow = preset.theme?.boxShadow as Record<string, string>;
    const sub = (v: string) => v.replace(/var\(--midnight\)/g, '#0A1628').replace(/var\(--electric\)/g, '#2563EB').replace(/\s+/g, '');
    expect(sub(shadow.float ?? '')).toBe(sub(tokens.get('--float') ?? ''));
    expect(sub(shadow.lift ?? '')).toBe(sub(tokens.get('--lift') ?? ''));
  });

  it('radius is square except the keycap; fonts point at next/font variables; no mono family', () => {
    expect(preset.theme?.borderRadius).toEqual({ none: '0', kbd: '2px', full: '9999px' });
    const ff = preset.theme?.fontFamily as Record<string, string[]>;
    expect(Object.keys(ff).sort()).toEqual(['display', 'sans']);
    expect(ff.sans?.[0]).toBe('var(--font-dm-sans, "DM Sans")');
    expect(ff.display?.[0]).toBe('var(--font-syne, "Syne")');
    expect(JSON.stringify(ff)).not.toMatch(/mono/i);
  });
});

/* ---------------------------------------------------------- palette-only code */

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

function expandHex(h: string): string {
  const v = h.slice(1);
  return `#${(v.length === 3 ? v.split('').map((c) => c + c).join('') : v).toUpperCase()}`;
}

describe('palette only', () => {
  it('every hex literal in src/ and the package CSS we author is a palette hex', () => {
    const files = [...walk(join(root, 'src'), ['.ts', '.tsx']), join(root, 'styles/marks.css'), join(root, 'styles/next-adapter.css')];
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
        // ignore anchors like "#main" (not hex) — the regex already requires hex digits; skip id-like "#i-…"
        const h = expandHex(m[0]);
        if (!PALETTE.has(h)) offenders.push(`${f.replace(root, '')}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no rgba()/hsl() colours outside the kit-sanctioned scrim/shadow ink', () => {
    const files = walk(join(root, 'src'), ['.ts', '.tsx']).concat([join(root, 'styles/marks.css'), join(root, 'styles/next-adapter.css')]);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(rgba?|hsla?)\([^)]*\)/g)) offenders.push(`${f.replace(root, '')}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
