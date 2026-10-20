import { ContextLine, dayDate, type ContextLineItem } from '@meritbooks/merit-ui';
import type { ReactNode } from 'react';
import { todayIso, weekLabel } from '@/lib/time';

/**
 * The 32px context line: date // week // where // the one fact that matters.
 * Each page passes its own facts after the date and week.
 */
export function PageLine({ facts = [], actions }: { facts?: ReadonlyArray<ContextLineItem>; actions?: ReactNode }) {
  const today = todayIso();
  return <ContextLine items={[dayDate(today), weekLabel(today), ...facts]} actions={actions} />;
}
