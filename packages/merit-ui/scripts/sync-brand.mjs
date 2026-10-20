#!/usr/bin/env node
/**
 * Copy the Merit lockups an app needs into <appDir>/public/brand/.
 *
 *   node packages/merit-ui/scripts/sync-brand.mjs apps/projects
 *   node packages/merit-ui/scripts/sync-brand.mjs apps/projects --module projects --module books
 *   node packages/merit-ui/scripts/sync-brand.mjs apps/web --all
 *   node packages/merit-ui/scripts/sync-brand.mjs apps/projects --check   (exit 1 if out of date)
 *
 * Copies, for each module: every form (horizontal, vertical) × variant
 * (on-dark, midnight, white, full-color) → public/brand/lockups/, plus the
 * shared icon (merit-icon-*.svg) and the official merit-icon.png → public/brand/.
 * Sources are this package's assets/ (themselves verbatim kit files). Files are
 * copied byte-for-byte; lockups are never edited or re-typeset.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const srcLockups = join(pkgRoot, 'assets', 'lockups');
const srcIconPng = join(pkgRoot, 'assets', 'official', 'merit-icon.png');

const MODULES = ['books', 'projects', 'crm', 'fpa', 'hr', 'inventory', 'payroll', 'platform'];

function usage(msg) {
  if (msg) console.error(`sync-brand: ${msg}`);
  console.error('usage: sync-brand.mjs <appDir> [--module <slug>]... [--all] [--check]');
  process.exit(2);
}

const args = process.argv.slice(2);
const appArg = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--module');
if (!appArg) usage('missing <appDir>');
const appDir = resolve(process.cwd(), appArg);
if (!existsSync(join(appDir, 'package.json'))) usage(`${appDir} is not an app (no package.json)`);

const all = args.includes('--all');
const check = args.includes('--check');
const modules = new Set();
args.forEach((a, i) => {
  if (a === '--module') {
    const m = args[i + 1];
    if (!m || !MODULES.includes(m)) usage(`unknown module "${m ?? ''}" (one of ${MODULES.join(', ')})`);
    modules.add(m);
  }
});
if (modules.size === 0 && !all) {
  // Default: the module named by the app folder (apps/projects → projects), else projects.
  const guess = appDir.split(/[\\/]/).pop();
  modules.add(MODULES.includes(guess) ? guess : 'projects');
}

const files = readdirSync(srcLockups).filter((f) => f.endsWith('.svg'));
const wanted = files.filter((f) => {
  if (f.startsWith('merit-icon-')) return true; // shared icon (favicon, collapsed rail)
  if (all) return true;
  return [...modules].some((m) => f.startsWith(`merit-${m}-`));
});

const destLockups = join(appDir, 'public', 'brand', 'lockups');
const destBrand = join(appDir, 'public', 'brand');
const plan = wanted.map((f) => [join(srcLockups, f), join(destLockups, f)]);
plan.push([srcIconPng, join(destBrand, 'merit-icon.png')]);

const same = (a, b) => existsSync(b) && readFileSync(a).equals(readFileSync(b));
const stale = plan.filter(([a, b]) => !same(a, b));

if (check) {
  if (stale.length) {
    console.error(`sync-brand: ${stale.length} brand file(s) missing or changed in ${destBrand}`);
    for (const [, b] of stale) console.error(`  ${b}`);
    process.exit(1);
  }
  console.log(`sync-brand: ${plan.length} brand files up to date in ${destBrand}`);
  process.exit(0);
}

mkdirSync(destLockups, { recursive: true });
for (const [a, b] of stale) copyFileSync(a, b);
console.log(
  `sync-brand: ${stale.length} copied, ${plan.length - stale.length} unchanged → ${destBrand}` +
    ` (modules: ${all ? 'all' : [...modules].join(', ')})`,
);
