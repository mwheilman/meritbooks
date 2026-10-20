import type { ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import { InlineNotice, Tag } from '../primitives/Status';

export interface AiPausedProps {
  /** Plain, calm headline (no trailing period needed). */
  title?: string;
  /** What still works and what the user can do ("Rules still route change orders. 13 wait for you."). */
  children?: ReactNode;
  /** inline (an .inline-notice) or widget (a .wg-state inside a Widget body). */
  variant?: 'inline' | 'widget';
  /** One action, e.g. <ButtonLink href="…">Review the 13 left</ButtonLink>. */
  action?: ReactNode;
}

/**
 * AI-down honesty (§7.8): when the AI gateway is off, say so plainly, inline,
 * and say what still works. Never a dead tile, never an apology.
 */
export function AiPaused({ title = 'AI assist paused', children, variant = 'inline', action }: AiPausedProps) {
  if (variant === 'widget') {
    return (
      <div className="wg-state" role="status">
        <Tag>AI paused</Tag>
        <span className="t-head">{title}</span>
        {children != null && <p>{children}</p>}
        {action}
      </div>
    );
  }
  return (
    <InlineNotice icon={<Icon name="plug" style={{ marginTop: 2 }} />} title={`${title.replace(/\.$/, '')}.`}>
      {children}
      {action != null && <> {action}</>}
    </InlineNotice>
  );
}
