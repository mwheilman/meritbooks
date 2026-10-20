import type { ImgHTMLAttributes } from 'react';
import { isDev } from '../cx';
import {
  LOCKUP_BASE_PATH,
  LOCKUP_MIN_HEIGHT,
  PRODUCT_NAMES,
  lockupFile,
  lockupSize,
  type LockupForm,
  type LockupModule,
  type LockupVariant,
} from './lockups';

export interface LockupProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'width' | 'height' | 'alt'> {
  /** The suite module. 'merit' is the bare Merit logo (outside any product). */
  module: LockupModule;
  form?: LockupForm;
  /** Background the lockup sits on. Rail = on-dark. */
  variant?: LockupVariant;
  /** Rendered height in px. Rail = 24 (the default for horizontal). */
  height?: number;
  /** Public folder the app serves lockups from. */
  basePath?: string;
  /** Defaults to the written product name ("Merit Projects"). */
  alt?: string;
}

/**
 * The product lockup as an <img> of the kit SVG — never typeset text.
 *
 *   <Lockup module="projects" />  →  merit-projects-horizontal-on-dark.svg, 161 × 24
 */
export function Lockup({
  module,
  form = 'horizontal',
  variant = 'on-dark',
  height,
  basePath = LOCKUP_BASE_PATH,
  alt,
  ...rest
}: LockupProps) {
  const h = height ?? (form === 'vertical' ? 64 : 24);
  if (isDev() && form !== 'icon' && h < LOCKUP_MIN_HEIGHT) {
    // eslint-disable-next-line no-console
    console.warn(`[merit-ui] Lockup ${module} at ${h}px is under the ${LOCKUP_MIN_HEIGHT}px minimum. Use form="icon".`);
  }
  const size = lockupSize(module, form, h);
  return (
    <img
      src={`${basePath}/${lockupFile(module, form, variant)}`}
      alt={alt ?? PRODUCT_NAMES[module]}
      width={size.width}
      height={size.height}
      decoding="async"
      {...rest}
    />
  );
}
