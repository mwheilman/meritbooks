import type { Metadata } from 'next';
import Link from 'next/link';
import { Page, PageHead, Status, WidgetState, count, money, pct } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadScorecard } from '@/lib/fieldservice/queries';
import type { ScorecardRow } from '@/lib/fieldservice/types';
import { addDays, todayIso } from '@/lib/time';

export const metadata: Metadata = { title: 'Scorecards' };
export const dynamic = 'force-dynamic';

const PERIODS = [{ key: 'today', label: 'Today', days: 1 }, { key: 'week', label: 'Last 7 days', days: 7 }, { key: 'period', label: 'Last 14 days', days: 14 }, { key: 'month', label: 'Last 30 days', days: 30 }, { key: 'quarter', label: 'Last 90 days', days: 90 }] as const;

const m = (c: number | null) => (c == null ? '—' : money(Number(c)));
const p = (x: number | null) => (x == null ? '—' : pct(Number(x)));

/**
 * Technician scorecards and leaderboard (FS-40 / FS-103) with performance-pay inputs (FS-101).
 * The database decides what each person sees: a technician gets their own row (with their pay);
 * a service manager sees every tech with revenue but no pay; the GM / owner sees pay too.
 */
export default async function ScorecardsPage({ searchParams }: { searchParams: { period?: string } }) {
  const g = await fsPage([['projects.jobs', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Scorecards" /><OneCompany what="Scorecards" /></Page></>);
  const period = PERIODS.find((x) => x.key === searchParams.period) ?? PERIODS[3];
  const today = todayIso();
  const from = addDays(today, -period.days + 1);
  const { rows, error } = await loadScorecard(o.db, companyId, from, today);
  const company = o.companyName(companyId) ?? o.where;
  const sorted = [...rows].sort((a, b) => Number(b.revenue_cents ?? 0) - Number(a.revenue_cents ?? 0) || b.completed_jobs - a.completed_jobs);
  const showRev = rows.some((r) => r.revenue_visible);
  const showPay = rows.some((r) => r.pay_visible);
  const mine = rows.find((r) => r.is_me) ?? null;
  return (
    <>
      <PageLine facts={[company, period.label, { label: `${count(rows.length)} technician(s)`, strong: true }]} />
      <Page>
        <PageHead eyebrow={company} title={rows.length === 1 && mine ? 'My scorecard' : 'Scorecards'} />
        <div className="fs-toolbar" aria-label="Period">
          {PERIODS.map((x) => <Link key={x.key} className={x.key === period.key ? 'btn btn--primary' : 'btn'} href={`/dispatch/scorecards?period=${x.key}`} aria-current={x.key === period.key ? 'page' : undefined}>{x.label}</Link>)}
        </div>
        {error ? <WidgetState state={{ kind: 'error', title: 'Scorecards did not load', body: error.replace(/^PM_FORBIDDEN:\s*/, '') }} /> : rows.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: 'No completed visits in this period', body: 'Scorecards count visits each technician led to completion, options sold, leads set and memberships sold.' }} />
        ) : (
          <>
            {mine && <MyPay row={mine} />}
            <section className="fs-card fs-scroll" aria-label="Leaderboard">
              <table className="fs-table">
                <thead>
                  <tr>
                    <th>Technician</th><th className="n">Jobs</th>{showRev && <><th className="n">Revenue</th><th className="n">Avg ticket</th></>}<th className="n">Options sold</th><th className="n">Conversion</th>
                    <th className="n">Leads set / sold</th><th className="n">Memberships</th><th className="n">Recalls</th><th className="n">Billable hours</th><th className="n">Reviews</th>
                    {showPay && <><th className="n">Commission</th><th className="n">Spiffs + bonuses</th><th className="n">Chargebacks</th><th className="n">Pay total</th></>}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.employee_id} aria-selected={r.is_me}>
                      <td><span className="l1">{r.tech_name}{r.is_me ? ' (you)' : ''}</span></td>
                      <td className="n">{count(r.completed_jobs)}</td>
                      {showRev && <><td className="n">{m(r.revenue_cents)}</td><td className="n">{m(r.avg_ticket_cents)}</td></>}
                      <td className="n">{count(r.sold_jobs)} of {count(r.opportunities)}</td><td className="n">{p(r.conversion_pct)}</td>
                      <td className="n">{count(r.tgl_set)} / {count(r.tgl_sold)}</td><td className="n">{count(r.memberships_sold)}</td>
                      <td className="n">{count(r.recalls)}{r.recall_rate_pct != null && <span className="l2">{p(r.recall_rate_pct)}</span>}</td>
                      <td className="n">{Number(r.billable_hours).toFixed(1)} of {Number(r.clocked_hours).toFixed(1)}</td>
                      <td className="n">{r.review_avg == null ? '—' : Number(r.review_avg).toFixed(2)}<span className="l2">{count(r.reviews)}</span></td>
                      {showPay && <><td className="n">{m(r.commission_cents)}</td><td className="n">{r.spiff_cents == null ? '—' : money(Number(r.spiff_cents) + Number(r.tgl_bonus_cents ?? 0) + Number(r.membership_spiff_cents ?? 0))}</td>
                        <td className="n">{r.chargeback_cents == null ? '—' : `(${money(Number(r.chargeback_cents))})`}</td><td className="n b">{m(r.pay_total_cents)}</td></>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <p className="t-cap" style={{ marginTop: 12 }}>Revenue is what was sold and completed on the visits a technician led (approved customer-pay lines). Pay figures are inputs for Books payroll — Books accrues commission and runs payroll.</p>
          </>
        )}
      </Page>
    </>
  );
}

function MyPay({ row }: { row: ScorecardRow }) {
  return (
    <section className="fs-card" aria-label="My pay this period" style={{ marginBottom: 16 }}>
      <div className="fs-card-h"><h2 className="t-section">My pay this period</h2><span className="sp" /><Status kind="track">Estimate until payroll runs</Status></div>
      <div className="fs-card-b">
        <dl className="kv">
          <dt>Commission</dt><dd className="tnum">{m(row.commission_cents)}</dd>
          <dt>Spiffs</dt><dd className="tnum">{m(row.spiff_cents)}</dd>
          <dt>Lead-set bonuses ({count(row.tgl_sold)} sold)</dt><dd className="tnum">{m(row.tgl_bonus_cents)}</dd>
          <dt>Membership spiffs ({count(row.memberships_sold)})</dt><dd className="tnum">{m(row.membership_spiff_cents)}</dd>
          <dt>Recall chargebacks</dt><dd className="tnum">{row.chargeback_cents == null ? '—' : `(${money(Number(row.chargeback_cents))})`}</dd>
          <dt><b>Total</b></dt><dd className="tnum b">{m(row.pay_total_cents)}</dd>
        </dl>
      </div>
    </section>
  );
}
