'use client';

import Link from 'next/link';
import { InlineNotice, Status, money, pct } from '@meritbooks/merit-ui';
import type { Mark } from '@/lib/pm/money/status';
import { preconditionCopy, preconditionFixHref } from '@/lib/pm/money/preconditions';

/** A status word with its pip (never colour alone). */
export function MarkStatus({ mark }: { mark: Mark }) {
  return <Status kind={mark.kind} pip={mark.pip}>{mark.word}</Status>;
}

/** Table money; null → em dash. */
export function m(v: number | null | undefined): string {
  return v == null ? '—' : money(v);
}

/** Whole-dollar money for headers and comparisons. */
export function m0(v: number | null | undefined): string {
  return v == null ? '—' : money(v, { decimals: 0 });
}

/** A fraction as a percent, or an em dash. */
export function p(v: number | null | undefined, decimals = 1): string {
  return v == null || !Number.isFinite(v) ? '—' : pct(v, { decimals });
}

/** "10" / "12.5" (percent text) → 0.1 / 0.125; null when not 0–100 with up to 2 decimals. */
export function parsePct(text: string): number | null {
  const t = text.trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? Math.round(n * 100) / 10000 : null;
}

/** A fraction → editable percent text ("12.5"). */
export function pctInput(f: number | null | undefined): string {
  return f == null ? '' : String(Math.round(f * 10000) / 100);
}

/** Who issues the invoice. Shown wherever a billing request can be sent. */
export function BooksNote({ booksPresent }: { booksPresent: boolean }) {
  return booksPresent ? (
    <InlineNotice tone="info" title="Merit Books numbers and posts the invoice.">
      Merit Projects drafts the request and checks it. Approving sends it to Merit Books, which issues the invoice, gives it its number and posts it to the ledger. The number appears here once it is issued.
    </InlineNotice>
  ) : (
    <InlineNotice title="Merit Books is not on for this workspace.">
      Approved requests are kept here as approved, not sent. Nothing is invoiced or posted from Merit Projects; send the invoice from your own system.
    </InlineNotice>
  );
}

/** Failing billing preconditions as inline notices, each with its fix. */
export function PreconditionNotices({ codes, jobId }: { codes: ReadonlyArray<string>; jobId: string }) {
  if (!codes.length) return null;
  return (
    <InlineNotice tone="warn" title={codes.length === 1 ? 'One check is not met.' : `${codes.length} checks are not met.`} role="status">
      <ul style={{ listStyle: 'none', display: 'grid', gap: 6, marginTop: 4 }}>
        {codes.map((c) => {
          const copy = preconditionCopy(c);
          const href = preconditionFixHref(c, jobId);
          return (
            <li key={c}>
              {copy.sentence}{' '}
              {href && copy.fix && <Link className="link" href={href}>{copy.fix.label}</Link>}
            </li>
          );
        })}
      </ul>
    </InlineNotice>
  );
}
