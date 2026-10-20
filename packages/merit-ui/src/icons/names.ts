/**
 * Every symbol in <IconSprite/>. The first 23 are the kit's sprite
 * (reference/components.html), copied path-for-path. The rest are drawn for a
 * project/field product to the same spec: 16px grid, 1.5px stroke,
 * currentColor, butt caps (as the kit draws), joins round only where the kit
 * rounds them. No sparkles: "ask" is the kit's speech note.
 */
export const KIT_ICON_NAMES = [
  'search',
  'down',
  'right',
  'layers',
  'grid',
  'pin',
  'lock',
  'drag',
  'sliders',
  'x',
  'check',
  'receipt',
  'bill',
  'none',
  'eye',
  'undo',
  'plug',
  'plus',
  'flag',
  'ask',
  'resize',
  'history',
  'book',
] as const;

export const PRODUCT_ICON_NAMES = [
  'calendar',
  'clock',
  'truck',
  'wrench',
  'hammer',
  'clipboard',
  'users',
  'map-pin',
  'camera',
  'box',
  'factory',
  'home',
  'building',
  'file-text',
  'dollar',
  'more',
  'upload',
  'up',
  'left',
] as const;

export const ICON_NAMES = [...KIT_ICON_NAMES, ...PRODUCT_ICON_NAMES] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** The sprite <symbol> id for a name: "i-search". */
export function iconId(name: IconName): string {
  return `i-${name}`;
}
