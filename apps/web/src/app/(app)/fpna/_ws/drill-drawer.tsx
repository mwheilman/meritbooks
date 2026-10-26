'use client';

/**
 * Drill to the transaction (exceed X2): the GL lines behind a card, a month or a variance
 * line — read from the LEDGER through the engine drill (governed: a non-finance reader is
 * refused months that are not released), each linking to its journal entry and source
 * document. Paginated, never truncated silently.
 */
import { useEffect, useState } from 'react';
import { Button, Drawer, InlineNotice, PanelSection, api, money, shortDate } from '@meritbooks/merit-ui';
import type { DrillLine, DrillResult } from '@/lib/reports/engine/types';
import { monthEndIso, monthName, monthStartIso } from './format';
import s from './fpna.module.css';

export interface DrillTarget {
  title: string;
  accountIds: string[];
  companyIds: string[];
  /** First month (null = from inception, for balances). */
  from: string | null;
  to: string;
  /** +1 = debit-positive (assets, costs), −1 = credit-positive (revenue, liabilities). */
  sign: 1 | -1;
  companyNames: ReadonlyMap<string, string>;
}

const PAGE = 100;

export function DrillDrawer({ target, onClose }: { target: DrillTarget | null; onClose: () => void }) {
  const [lines, setLines] = useState<DrillLine[]>([]);
  const [total, setTotal] = useState<DrillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (offset: number) => {
    if (!target) return;
    setLoading(true);
    setError(null);
    const res = await api.post<{ data: DrillResult }>('/api/reports/engine/drill', {
      accountIds: target.accountIds.slice(0, 2000),
      companyIds: target.companyIds,
      range: { start: target.from ? monthStartIso(target.from) : null, end: monthEndIso(target.to) },
      kinds: target.from ? ['STANDARD', 'ADJUSTING'] : ['STANDARD', 'ADJUSTING', 'CLOSING'],
      limit: PAGE,
      offset,
    });
    setLoading(false);
    if (res.error || !res.data) {
      setError(res.error?.code === 'NOT_RELEASED' ? 'Those months are not released for your view yet.' : res.error?.error ?? 'The entries could not be loaded.');
      return;
    }
    setTotal(res.data.data);
    setLines((prev) => (offset === 0 ? res.data!.data.lines : [...prev, ...res.data!.data.lines]));
  };

  useEffect(() => {
    setLines([]);
    setTotal(null);
    if (target) void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const sign = target?.sign ?? 1;
  return (
    <Drawer
      open={!!target}
      onClose={onClose}
      width={560}
      eyebrow={['GL detail', target ? (target.from ? `${monthName(target.from)} – ${monthName(target.to)}` : `To ${monthName(target.to)}`) : '']}
      title={target?.title ?? ''}
      meta={total ? `${total.totalCount} line${total.totalCount === 1 ? '' : 's'} · ${money(sign * total.netCents)}` : undefined}
    >
      {error && <InlineNotice tone="neg" title="Couldn’t load the entries.">{error} <Button variant="quiet" onClick={() => void load(0)}>Try again</Button></InlineNotice>}
      {loading && lines.length === 0 && <div className={s.skeleton} aria-busy="true" />}
      {total && total.totalCount === 0 && <p className={s.muted}>No posted lines for these accounts in the window.</p>}
      {lines.length > 0 && (
        <PanelSection title="Posted lines" meta={`${lines.length} of ${total?.totalCount ?? lines.length}`}>
          <ul className={s.drillList}>
            {lines.map((l) => (
              <li key={l.lineId}>
                <span>{shortDate(l.entryDate)}</span>
                <span>
                  <a className={s.rowLink} href={l.entryHref}>{l.entryNumber}</a>
                  {l.sourceHref && (
                    <>
                      {' · '}
                      <a className={s.rowLink} href={l.sourceHref}>{l.sourceLabel ?? 'Source'}</a>
                    </>
                  )}
                  <span className={s.sub}>{[target?.companyNames.get(l.companyId), l.memo].filter(Boolean).join(' · ')}</span>
                </span>
                <span>{money(sign * (l.debitCents - l.creditCents))}</span>
              </li>
            ))}
          </ul>
          {total && lines.length < total.totalCount && (
            <Button variant="quiet" onClick={() => void load(lines.length)} disabled={loading}>
              {loading ? 'Loading…' : `Load ${Math.min(PAGE, total.totalCount - lines.length)} more`}
            </Button>
          )}
        </PanelSection>
      )}
    </Drawer>
  );
}
