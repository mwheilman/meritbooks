import type { SVGProps } from 'react';
import { cx } from '../cx';
import { iconId, type IconName } from './names';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName;
  /** 16 is the system size. */
  size?: 16 | 12 | 20;
  /**
   * Accessible name. Omit for decorative icons (the default: aria-hidden).
   * Icon-only buttons put their aria-label on the button, not here.
   */
  label?: string;
}

/**
 * <svg class="ico"><use href="#i-name"/></svg>. Always carries .ico so
 * Tailwind preflight's svg{display:block} never breaks inline layout.
 */
export function Icon({ name, size = 16, label, className, ...rest }: IconProps) {
  return (
    <svg
      className={cx('ico', className)}
      width={size}
      height={size}
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...rest}
    >
      <use href={`#${iconId(name)}`} />
    </svg>
  );
}
