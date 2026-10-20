import { PRODUCT_NAMES, type LockupModule } from './lockups';

/**
 * Browser tab title (§12): "<Page> · Merit <Module>".
 *   pageTitle('To review', 'projects') → "To review · Merit Projects"
 *   pageTitle(undefined, 'projects')   → "Merit Projects"
 */
export function pageTitle(page: string | undefined, module: LockupModule = 'projects'): string {
  const product = PRODUCT_NAMES[module];
  const p = page?.trim();
  return p ? `${p} · ${product}` : product;
}

/** For Next metadata: `title: { template: titleTemplate('projects'), default: 'Merit Projects' }`. */
export function titleTemplate(module: LockupModule = 'projects'): string {
  return `%s · ${PRODUCT_NAMES[module]}`;
}
