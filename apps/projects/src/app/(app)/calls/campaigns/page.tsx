import type { Metadata } from 'next';
import Link from 'next/link';
import { Page, PageHead, WidgetState, count, money, pct } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { OneCompany } from '@/components/fieldservice/common/OneCompany';
import '@/components/fieldservice/fs.css';
import { fsPage } from '@/lib/fieldservice/page';
import { loadCampaignReport, loadReviews } from '@/lib/fieldservice/queries';
import { listEmployees } from '@/lib/pm/ops/field-queries';
import { addDays, todayIso } from '@/lib/time';

export const metadata: Metadata = { title: 'Campaigns' };
export const dynamic = 'force-dynamic';

const PERIODS = [{ days: 30, label: 'Last 30 days' }, { days: 90, label: 'Last 90 days' }, { days: 365, label: 'Last 12 months' }] as const;

/**
 * Campaign attribution (FS-106) — booked rate, completed revenue and, with job financials, cost and
 * margin from Books job cost — and review requests per technician (FS-107, never filtered).
 */
export default async function CampaignsPage({ searchParams }: { searchParams: { days?: string } }) {
  const g = await fsPage([['projects.reports', 'view'], ['projects.leads', 'view']]);
  if (!g) return null;
  const { o, companyId } = g;
  if (!companyId) return (<><PageLine facts={[o.where]} /><Page><PageHead eyebrow={o.where} title="Campaigns" /><OneCompany what="Campaigns and tracking numbers" /></Page></>);
  const days = PERIODS.find((p) => String(p.days) === searchParams.days)?.days ?? 30;
  const today = todayIso();
  const from = addDays(today, -days + 1);
  const [report, reviews, employees] = await Promise.all([loadCampaignReport(o.db, companyId, from, today), loadReviews(o.db, companyId), listEmployees(o.db)]);
  const company = o.companyName(companyId) ?? o.where;
  const rows = report.rows;
  const booked = rows.reduce((s, r) => s + r.booked, 0);
  const decided = rows.reduce((s, r) => s + r.booked + r.not_booked, 0);
  const name = new Map(employees.map((e) => [e.id, [e.first_name, e.last_name].filter(Boolean).join(' ')]));
  const byTech = new Map<string, { sent: number; rated: number; sum: number }>();
  for (const r of reviews) {
    if (!r.employee_id) continue;
    const t = byTech.get(r.employee_id) ?? { sent: 0, rated: 0, sum: 0 };
    if (r.status !== 'SUPPRESSED') t.sent += 1;
    if (r.rating != null) { t.rated += 1; t.sum += r.rating; }
    byTech.set(r.employee_id, t);
  }
  return (
    <>
      <PageLine facts={[company, { label: `${decided ? pct(booked / decided) : '—'} booking rate`, strong: true }, PERIODS.find((p) => p.days === days)!.label]} />
      <Page>
        <PageHead eyebrow={company} title="Campaigns" />
        <div className="fs-toolbar" role="tablist" aria-label="Period">
          {PERIODS.map((p) => <Link key={p.days} className={p.days === days ? 'btn btn--primary' : 'btn'} href={`/calls/campaigns?days=${p.days}`} aria-current={p.days === days ? 'page' : undefined}>{p.label}</Link>)}
        </div>
        {report.error ? <WidgetState state={{ kind: 'error', title: 'The campaign report did not load', body: report.error }} /> : rows.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: 'No calls in this period', body: 'Tag calls with a campaign on the call desk (tracking numbers tag themselves) and they add up here.' }} />
        ) : (
          <section className="fs-card" aria-label="Campaign attribution">
            <table className="fs-table">
              <thead><tr><th>Campaign</th><th className="n">Calls</th><th className="n">Booked</th><th className="n">Booking rate</th><th className="n">Jobs done</th>
                {rows[0]!.revenue_visible && <th className="n">Revenue</th>}{rows[0]!.cost_visible && <th className="n">Job cost</th>}{rows[0]!.revenue_visible && rows[0]!.cost_visible && <th className="n">Margin</th>}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.campaign_id ?? 'none'}>
                    <td><span className="l1">{r.campaign_name}</span><span className="l2">{r.campaign_channel.replace(/_/g, ' ').toLowerCase()}</span></td>
                    <td className="n">{count(r.calls)}</td><td className="n">{count(r.booked)}</td>
                    <td className="n">{r.booking_rate_pct == null ? '—' : pct(r.booking_rate_pct)}</td><td className="n">{count(r.completed_jobs)}</td>
                    {r.revenue_visible && <td className="n">{r.revenue_cents == null ? '—' : money(r.revenue_cents)}</td>}
                    {r.cost_visible && <td className="n">{r.cost_cents == null ? '—' : money(r.cost_cents)}</td>}
                    {r.revenue_visible && r.cost_visible && <td className="n">{r.margin_cents == null ? '—' : money(r.margin_cents)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="t-cap" style={{ padding: 12 }}>Ad spend comes from the Books GL by campaign; until Books tags spend to campaigns, ROI shows revenue and job cost only.</p>
          </section>
        )}
        <section className="fs-card" aria-label="Reviews by technician" style={{ marginTop: 24 }}>
          <div className="fs-card-h"><h2 className="t-section">Review requests by technician</h2><span className="sp" /><span className="t-cap">Sent after every completed customer-pay visit — never filtered by how the visit went</span></div>
          {byTech.size === 0 ? <div className="fs-card-b"><WidgetState state={{ kind: 'empty', title: 'No review requests yet', body: 'Add the company’s review link in field-service settings; requests queue when a visit completes.' }} /></div> : (
            <table className="fs-table">
              <thead><tr><th>Technician</th><th className="n">Requests sent</th><th className="n">Reviews</th><th className="n">Average rating</th></tr></thead>
              <tbody>{[...byTech.entries()].map(([id, t]) => <tr key={id}><td>{name.get(id) ?? 'Technician'}</td><td className="n">{count(t.sent)}</td><td className="n">{count(t.rated)}</td><td className="n">{t.rated ? (t.sum / t.rated).toFixed(2) : '—'}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      </Page>
    </>
  );
}
