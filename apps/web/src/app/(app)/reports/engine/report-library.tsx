'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, Tag } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { ALL_REPORTS, SHELVES, searchReports, type LibraryReport } from './catalog';
import { usePrefs, useSavedViews } from './use-engine';
import s from './engine.module.css';

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * The report library: shelves organized by the question each report answers, search,
 * favourites, recently run and saved views (server-side, per user / per org).
 */
export function ReportLibrary({ onOpen, onOpenQuery, dealerReports }: {
  onOpen: (key: string) => void;
  onOpenQuery: (query: string) => void;
  dealerReports?: LibraryReport[];
}) {
  const [q, setQ] = useState('');
  const prefs = usePrefs();
  const views = useSavedViews();
  const all = useMemo(() => [...ALL_REPORTS, ...(dealerReports ?? [])], [dealerReports]);
  const found = useMemo(() => searchReports(q, all), [q, all]);
  const byKey = useMemo(() => new Map(all.map((r) => [r.key, r])), [all]);
  const fav = new Set((prefs.data ?? []).filter((p) => p.isFavorite).map((p) => p.reportKey));
  const recent = (prefs.data ?? []).filter((p) => p.lastRunAt && byKey.has(p.reportKey)).sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '')).slice(0, 8);

  const card = (r: LibraryReport) => (
    <div key={r.key} style={{ position: 'relative', display: 'flex' }}>
      <button type="button" className={s.card} style={{ flex: 1 }} onClick={() => onOpen(r.key)}>
        <span className={s.cardTitle}>{r.label}</span>
        <span className={s.cardDesc}>{r.desc}</span>
        {r.legacy && <span className={s.cardMeta}>Classic report</span>}
      </button>
      <button
        type="button"
        className={s.star}
        aria-pressed={fav.has(r.key)}
        aria-label={fav.has(r.key) ? `Remove ${r.label} from favourites` : `Add ${r.label} to favourites`}
        onClick={() => void prefs.toggle(r.key, !fav.has(r.key))}
      >
        {fav.has(r.key) ? '★' : '☆'}
      </button>
    </div>
  );

  return (
    <div>
      <PageHeader
        eyebrow={['Reports']}
        title="Financial reports"
        description="Every statement from your own general ledger — drill from any figure to the lines and documents behind it."
      />
      <div className={s.libBar}>
        <div className={s.libSearch}>
          <Search aria-label="Search reports" placeholder="Search reports — “cash flow”, “by department”, “budget”" value={q} onChange={(e) => setQ(e.target.value)} slashToFocus />
        </div>
        <span className="t-cap">{found.length} report{found.length === 1 ? '' : 's'}</span>
        <div style={{ flex: 1 }} />
        <Link className="btn" href="/reports/layouts">Statement layouts</Link>
      </div>
      <div className={s.libGrid}>
        <div>
          {SHELVES.map((shelf) => {
            const list = found.filter((r) => r.shelf === shelf.key);
            if (!list.length) return null;
            return (
              <section key={shelf.key} className={s.shelf} aria-labelledby={`shelf-${shelf.key}`}>
                <div className={s.shelfHead}>
                  <h2 className="eyebrow" id={`shelf-${shelf.key}`} style={{ margin: 0 }}>{shelf.label}</h2>
                  {shelf.question && <span className={s.shelfQ}>{shelf.question}</span>}
                </div>
                <div className={s.cards}>{list.map(card)}</div>
              </section>
            );
          })}
          {found.length === 0 && (
            <div className={s.stateBox}>
              <h2 className="t-section">No report matches “{q}”</h2>
              <p>Try a statement name (profit and loss, balance sheet, cash flow) or a dimension (department, class, company).</p>
            </div>
          )}
        </div>
        <aside className={s.side} aria-label="Your reports">
          <div className={s.sideSec}>
            <h2 className="eyebrow" style={{ margin: 0 }}>Favourites</h2>
            {fav.size === 0 ? (
              <p className={s.empty}>Star a report to keep it here.</p>
            ) : (
              <ul className={s.sideList}>
                {[...fav].filter((k) => byKey.has(k)).map((k) => (
                  <li key={k}><button type="button" className={s.sideLink} onClick={() => onOpen(k)}><span>{byKey.get(k)!.label}</span></button></li>
                ))}
              </ul>
            )}
          </div>
          <div className={s.sideSec}>
            <h2 className="eyebrow" style={{ margin: 0 }}>Recently run</h2>
            {prefs.loading && !prefs.data ? <p className={s.empty}>Loading…</p> : recent.length === 0 ? (
              <p className={s.empty}>Reports you run appear here.</p>
            ) : (
              <ul className={s.sideList}>
                {recent.map((p) => (
                  <li key={p.reportKey}><button type="button" className={s.sideLink} onClick={() => onOpen(p.reportKey)}><span>{byKey.get(p.reportKey)!.label}</span><span>{when(p.lastRunAt)}</span></button></li>
                ))}
              </ul>
            )}
          </div>
          <div className={s.sideSec}>
            <h2 className="eyebrow" style={{ margin: 0 }}>Saved views</h2>
            {views.error ? <p className={s.empty}>Couldn't load saved views.</p> : (views.data ?? []).length === 0 ? (
              <p className={s.empty}>Open a report, set it up, and choose Save view.</p>
            ) : (
              <ul className={s.sideList}>
                {(views.data ?? []).slice(0, 20).map((v) => {
                  const query = typeof v.config?.query === 'string' ? v.config.query : `report=${v.report_key}`;
                  return (
                    <li key={v.id}>
                      <button type="button" className={s.sideLink} onClick={() => onOpenQuery(query)}>
                        <span>{v.name}</span>
                        <span>{byKey.get(v.report_key)?.label ?? v.report_key}{typeof v.config?.query !== 'string' && <Tag style={{ marginLeft: 6 }}>classic</Tag>}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
