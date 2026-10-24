import Link from 'next/link';
import { QUIET_HOURS_SOURCES, formatQuietHours, type QuietHoursSummary } from '@/lib/requests/quiet-display';

/**
 * The one quiet-hours sentence every chase screen shows (vendor compliance, receipts): the
 * hours this screen's reminders keep, where to change them, and — because the two chases
 * have separate settings — what the other chase uses, so the screens never look like they
 * disagree. Values come from the engine's own resolver (lib/requests/quiet-display).
 */
export function QuietHoursNote({ summary, primary }: { summary: QuietHoursSummary | null | undefined; primary: 'vendor' | 'receipt' }) {
  if (!summary) return null;
  const other = primary === 'vendor' ? 'receipt' : 'vendor';
  const mine = primary === 'vendor' ? summary.vendor : summary.receipt;
  const theirs = primary === 'vendor' ? summary.receipt : summary.vendor;
  const who = primary === 'vendor' ? 'the vendor’s' : 'the cardholder’s';
  const otherWho = primary === 'vendor' ? 'Receipt reminders to cardholders' : 'Vendor W-9 / COI reminders';
  return (
    <span>
      Quiet hours <b className="tnum">{formatQuietHours(mine)}</b> in {who} time zone — change under{' '}
      <Link className="link" href={QUIET_HOURS_SOURCES[primary].href}>
        {QUIET_HOURS_SOURCES[primary].label}
      </Link>
      . {otherWho} keep <span className="tnum">{formatQuietHours(theirs)}</span> ({QUIET_HOURS_SOURCES[other].label}).
    </span>
  );
}
