import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Lockup } from '../src/brand/Lockup';
import { LOCKUP_VARIANTS, LOCKUP_VIEWBOX, PRODUCT_NAMES, lockupFile, lockupSize, type LockupForm, type LockupModule } from '../src/brand/lockups';
import { pageTitle, titleTemplate } from '../src/brand/pageTitle';
import { ICON_NAMES, KIT_ICON_NAMES } from '../src/icons/names';
import { ICON_SYMBOLS, IconSprite } from '../src/icons/sprite';
import { Icon } from '../src/icons/Icon';

const assets = resolve(__dirname, '../assets/lockups');
const files = readdirSync(assets).filter((f) => f.endsWith('.svg'));

describe('lockups', () => {
  it('the ratio table matches every SVG viewBox in assets/lockups', () => {
    for (const f of files) {
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(readFileSync(join(assets, f), 'utf8'));
      const stem = f.replace(/-(on-dark|midnight|white|full-color)\.svg$/, '');
      expect(LOCKUP_VIEWBOX[stem], stem).toEqual({ w: Number(vb?.[1]), h: Number(vb?.[2]) });
    }
  });

  it('a file exists for every module × form × variant', () => {
    const modules = Object.keys(PRODUCT_NAMES) as LockupModule[];
    const forms: LockupForm[] = ['horizontal', 'vertical', 'icon'];
    for (const m of modules) for (const form of forms) for (const v of LOCKUP_VARIANTS) expect(files, `${m} ${form} ${v}`).toContain(lockupFile(m, form, v));
  });

  it('lockup SVGs are paths, never live text', () => {
    for (const f of files) expect(readFileSync(join(assets, f), 'utf8'), f).not.toMatch(/<text\b/);
  });

  it('rail lockups fit the 232px rail at 24px (Projects ≈ 161 × 24)', () => {
    expect(lockupSize('projects', 'horizontal', 24)).toEqual({ width: 161, height: 24 });
    expect(lockupSize('books', 'horizontal', 24)).toEqual({ width: 141, height: 24 });
    for (const m of Object.keys(PRODUCT_NAMES) as LockupModule[]) expect(lockupSize(m, 'horizontal', 24).width).toBeLessThanOrEqual(232 - 48);
  });

  it('renders the img with the written two-word name as alt', () => {
    const html = renderToStaticMarkup(<Lockup module="projects" />);
    expect(html).toBe('<img src="/brand/lockups/merit-projects-horizontal-on-dark.svg" alt="Merit Projects" width="161" height="24" decoding="async"/>');
    expect(renderToStaticMarkup(<Lockup module="fpa" variant="full-color" form="vertical" height={64} />)).toContain('alt="Merit FP&amp;A"');
    expect(renderToStaticMarkup(<Lockup module="projects" form="icon" height={20} />)).toContain('merit-icon-on-dark.svg');
  });

  it('page titles name the module', () => {
    expect(pageTitle('To review', 'projects')).toBe('To review · Merit Projects');
    expect(pageTitle(undefined, 'books')).toBe('Merit Books');
    expect(titleTemplate('projects')).toBe('%s · Merit Projects');
  });
});

describe('icons', () => {
  const kit = readFileSync('/home/claude/brand/kit-b/Merit-Suite-Style-Kit/reference/components.html', 'utf8');

  it('has all 23 kit symbols plus the product set, every one defined', () => {
    expect(KIT_ICON_NAMES.length).toBe(23);
    for (const n of ICON_NAMES) expect(ICON_SYMBOLS[n], n).toBeDefined();
  });

  it('kit symbols are path-for-path copies of components.html', () => {
    const html = renderToStaticMarkup(<IconSprite />);
    const norm = (s: string) =>
      s
        .replace(/\s+/g, ' ')
        .replace(/ \/>/g, '/>')
        .replace(/#fff\b/gi, '#FFFFFF')
        .replace(/<\/(path|circle|rect)>/g, '')
        .replace(/<(path|circle|rect)([^>]*?)\/?>/g, '<$1$2/>');
    for (const name of KIT_ICON_NAMES) {
      const theirs = new RegExp(`<symbol id="i-${name}"[^>]*>([\\s\\S]*?)</symbol>`).exec(kit)?.[1] ?? '';
      const ours = new RegExp(`<symbol id="i-${name}"[^>]*>([\\s\\S]*?)</symbol>`).exec(html)?.[1] ?? '';
      expect(norm(ours), name).toBe(norm(theirs));
    }
  });

  it('product symbols use the 16px grid and 1.5px currentColor stroke (or a currentColor fill)', () => {
    for (const n of ICON_NAMES) {
      const a = ICON_SYMBOLS[n].attrs;
      expect(a.stroke === 'currentColor' || a.fill === 'currentColor', n).toBe(true);
      if (a.stroke) expect([1.5, 1.75]).toContain(a.strokeWidth);
    }
  });

  it('<Icon/> always carries .ico and is hidden from AT unless labelled', () => {
    expect(renderToStaticMarkup(<Icon name="search" />)).toBe('<svg class="ico" width="16" height="16" focusable="false" aria-hidden="true"><use href="#i-search"></use></svg>');
    expect(renderToStaticMarkup(<Icon name="truck" label="Delivery" className="ink-2" />)).toContain('class="ico ink-2"');
    expect(renderToStaticMarkup(<Icon name="truck" label="Delivery" />)).toContain('role="img" aria-label="Delivery"');
  });
});
