import Link from 'next/link';
import { Dash, Evidence, Meter, Pip, Widget, countStrokes } from '@meritbooks/merit-ui';
import { ShellLine } from '@/components/layout/shell-context';
import { getRecentActivity, getWorkboard, type CompanyBoard, type RecentActivity } from './actions';
import { WorkspaceClients } from './workspace-clients';
import { ago, cents, dayLabel, monthLabel, shortLabel } from './home-format';

/** Top two clients for a queue — "Clive 6 · Dorrian 9" — so a band says where the work is. */
function topTwo(companies: CompanyBoard[], pick: (c: CompanyBoard) => number): Array<{ name: string; n: number }> {
  return companies
    .map((c) => ({ name: c.name, n: pick(c) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2);
}

function Band({
  label,
  count,
  caption,
  split,
  href,
}: {
  label: string;
  count: number;
  caption: string;
  split: Array<{ name: string; n: number }>;
  href?: string;
}) {
  const body = (
    <>
      <span className="eyebrow">{label}</span>
      <span className="v tnum">{count.toLocaleString()}</span>
      <span className="t-cap">{caption}</span>
      {split.length > 0 && (
        <span className="mb-split">
          {split.map((s) => (
            <span key={s.name}>
              <span className="mb-trunc">{s.name}</span>
              <b className="tnum">{s.n.toLocaleString()}</b>
            </span>
          ))}
        </span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className="band-tab mb-band">
      {body}
    </Link>
  ) : (
    <div className="band-tab mb-band">{body}</div>
  );
}

function ActivityList({ items }: { items: RecentActivity[] }) {
  return (
    <ul className="mb-activity">
      {items.map((a) => (
        <li key={a.id}>
          <span style={{ minWidth: 0 }}>
            <span className="l1">{a.description}</span>
            <span className="l2">
              {[a.location_name, a.status.toLowerCase().replace(/_/g, ' '), ago(a.created_at)].filter(Boolean).join(' · ')}
            </span>
          </span>
          {a.amount_cents != null && <span className="n">{cents(Number(a.amount_cents))}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The WORKSPACE home (no client picked) — board S1 within today's data: the primary
 * "Your clients" queue top-left at 8 of 12, then what's across the clients (money as
 * an evidence ledger that sums), this month's close, the queues that need judgment
 * and the latest feed activity. Every figure is a live, RLS-scoped read.
 */
export async function WorkspaceHome() {
  const [board, activity] = await Promise.all([getWorkboard(), getRecentActivity(8)]);

  if (board.status === 'error') {
    return (
      <Dash flow="row" className="mb-home-dash">
        <Widget
          primary
          title="Your clients"
          w={12}
          h={2}
          state={{
            kind: 'error',
            title: 'Your clients didn’t load',
            body: (
              <>
                The workboard couldn’t be read. <Link className="link" href="/dashboard">Reload the page</Link> — if it keeps
                happening, sign out and back in (your session may have expired).
              </>
            ),
          }}
        />
      </Dash>
    );
  }

  if (board.status === 'empty' || board.companies.length === 0) {
    return (
      <Dash flow="row" className="mb-home-dash">
        <Widget
          primary
          title="Your clients"
          w={12}
          h={2}
          state={{
            kind: 'empty',
            title: 'Add your first client to start',
            body: 'Connect QuickBooks or drop your files — Merit Books builds the books and you approve them. A brand-new business can start fresh in a minute.',
            action: (
              <Link href="/onboarding" className="btn btn--primary">
                Set up your books
              </Link>
            ),
          }}
        />
      </Dash>
    );
  }

  const c = board.consolidated;
  const companies = board.companies;
  const n = companies.length;
  const open = companies.filter((x) => x.periodStatus === 'OPEN').length;
  const soft = companies.filter((x) => x.periodStatus === 'SOFT_CLOSE').length;
  const none = companies.filter((x) => x.periodStatus === 'NO_PERIOD').length;
  // The all-clients Inbox total — the same number as the Inbox header and the rail badge.
  const needsYou = c.needsYou;
  const month = monthLabel(board.today);

  return (
    <>
      <ShellLine
        items={[
          dayLabel(board.today),
          `${month} · ${n} ${n === 1 ? 'client' : 'clients'}`,
          `${c.companiesClosed} of ${n} closed`,
          { label: needsYou > 0 ? `${needsYou.toLocaleString()} need your judgment` : 'Nothing needs your judgment', strong: true },
        ]}
      />
      <Dash flow="row" className="mb-home-dash">
        <WorkspaceClients companies={companies} />

        <Widget
          title="Across your clients"
          meta={`Posted GL · ${shortLabel(board.today)}`}
          w={4}
          h={2}
          pad
          foot={
            <Link className="btn btn--quiet" href="/reports">
              Open reports
            </Link>
          }
        >
          <Evidence
            rows={[
              { label: 'Book cash', value: Math.round(c.cashCents) },
              { label: 'Open receivables', value: Math.round(c.openARCents) },
              { label: 'Less open payables', value: -Math.round(c.openAPCents) },
            ]}
            total={{ label: 'Cash + receivables − payables' }}
          />
        </Widget>

        <Widget
          title={`${month || 'This month'}’s close`}
          count={`${c.companiesClosed} of ${n}`}
          w={4}
          h={2}
          pad
          foot={
            <Link className="btn btn--quiet" href="/close">
              Open close
            </Link>
          }
        >
          <div className="mb-close-meter">
            <Meter
              size="lg"
              strokes={countStrokes(Math.min(n, 24), Math.min(c.companiesClosed, 24), Math.min(soft, 24 - Math.min(c.companiesClosed, 24)))}
              label={`${c.companiesClosed} of ${n} clients closed, ${soft} in soft close`}
            />
            <span className="t-cap">Closed · soft close · open</span>
          </div>
          <ul className="mb-legend">
            <li>
              <Pip kind="closed" /> Closed <b className="tnum">{c.companiesClosed}</b>
            </li>
            <li>
              <Pip kind="soft" /> Soft close <b className="tnum">{soft}</b>
            </li>
            <li>
              <Pip kind="open" /> Open <b className="tnum">{open}</b>
            </li>
            {none > 0 && (
              <li>
                <Pip kind="track" /> No period set up <b className="tnum">{none}</b>
              </li>
            )}
          </ul>
        </Widget>

        {/* The Inbox, tab by tab, across every client — the same shared counts (and
            scope) as the Inbox tabs and the rail badge. */}
        <Widget
          title="Needs your judgment"
          count={needsYou.toLocaleString()}
          meta="Your Inbox across every client — same counts as the Inbox tabs"
          w={8}
          h={2}
          foot={
            <>
              <span className="tnum">
                {c.lanes.approvals.toLocaleString()} + {c.lanes.exceptions.toLocaleString()} + {c.lanes.alerts.toLocaleString()} +{' '}
                {c.lanes.drafts.toLocaleString()} = {needsYou.toLocaleString()} · then {c.toReview.toLocaleString()} to review
              </span>
              <Link className="btn btn--primary" href="/inbox">
                Open inbox
              </Link>
            </>
          }
        >
          <div className="bands mb-bands-4">
            <Band
              label="Approvals"
              count={c.lanes.approvals}
              caption="Money movement, expenses and policy holds"
              split={topTwo(companies, (x) => x.lanes.approvals)}
              href="/inbox?tab=approvals"
            />
            <Band
              label="Exceptions"
              count={c.lanes.exceptions}
              caption={`${c.openExceptions.toLocaleString()} AI proposals, plus flagged lines`}
              split={topTwo(companies, (x) => x.lanes.exceptions)}
              href="/inbox?tab=exceptions"
            />
            <Band label="Alerts" count={c.lanes.alerts} caption="Overdue or due within 30 days" split={topTwo(companies, (x) => x.lanes.alerts)} href="/inbox?tab=alerts" />
            <Band label="Drafts" count={c.lanes.drafts} caption="Journal entries to post" split={topTwo(companies, (x) => x.lanes.drafts)} href="/inbox?tab=drafts" />
          </div>
        </Widget>

        <Widget
          title="Latest activity"
          meta="Bank and card lines, newest first"
          w={4}
          h={2}
          state={
            activity.length === 0
              ? { kind: 'empty', title: 'No bank lines yet', body: 'Connect a bank feed and new transactions land here as they arrive.' }
              : undefined
          }
        >
          <ActivityList items={activity} />
        </Widget>
      </Dash>
    </>
  );
}
