import Link from 'next/link';
import { Dash, Evidence, Icon, Pip, Widget, type PipKind } from '@meritbooks/merit-ui';
import { ShellLine } from '@/components/layout/shell-context';
import { getClientHome, getRecentActivity, type ClientHome as ClientHomeData, type PeriodStatus } from './actions';
import { ClientDecideQueue } from './client-queue';
import { PERIOD_WORD, ago, cents, dayLabel, monthLabel, shortLabel } from './home-format';
import { PerformanceWidget } from './performance-widget';

type StepState = 'done' | 'current' | 'todo';

interface Step {
  n: number;
  name: string;
  href: string;
  count: string;
  detail: string;
  done: boolean;
}

const PERIOD_PIP: Record<PeriodStatus, PipKind> = { OPEN: 'open', SOFT_CLOSE: 'soft', HARD_CLOSE: 'closed', NO_PERIOD: 'track' };

function steps(h: ClientHomeData): Step[] {
  const b = h.board;
  if (!b) return [];
  const closed = b.periodStatus === 'HARD_CLOSE';
  const review = b.toReview + b.needsAttention;
  // Step 3 is the Inbox's Exceptions + Drafts tabs — the same shared counts.
  const check = b.lanes.exceptions + b.lanes.drafts;
  return [
    {
      n: 1,
      name: 'Review',
      href: '/bank-feed',
      count: review === 0 ? 'Nothing to review' : `${review.toLocaleString()} open · ${b.needsAttention.toLocaleString()} need you`,
      detail: `${h.bands.ready.count.toLocaleString()} bank lines ready to approve`,
      done: closed || review === 0,
    },
    {
      n: 2,
      name: 'Reconcile',
      href: '/reconciliation',
      count: 'Match statements',
      detail: 'Bank, cards and the AR/GL tie-out',
      done: closed,
    },
    {
      n: 3,
      name: 'Check',
      href: '/inbox?tab=exceptions',
      count: check === 0 ? 'No exceptions' : `${b.lanes.exceptions.toLocaleString()} exceptions · ${b.lanes.drafts.toLocaleString()} drafts`,
      detail: 'Exceptions, proposals and unposted entries',
      done: closed || check === 0,
    },
    {
      n: 4,
      name: 'Close',
      href: '/close',
      count: `${monthLabel(h.today)} ${PERIOD_WORD[b.periodStatus]}`,
      detail: 'Tasks, periods and the package',
      done: closed,
    },
  ];
}

function stateOf(all: Step[], s: Step): StepState {
  if (s.done) return 'done';
  const first = all.find((x) => !x.done);
  return first?.n === s.n ? 'current' : 'todo';
}

/**
 * ONE CLIENT's home — board S2 within today's data: the four-step books-review loop
 * (Review · Reconcile · Check · Close) with the current step lit, the open feed in
 * the Decide / Check / Ready bands with the Decide list (primary, 8 of 12), money as
 * an evidence ledger that sums, what else is waiting, this month's close and the
 * client's latest activity. Live, RLS-scoped reads filtered to this client.
 */
export async function ClientHome({ locationId }: { locationId: string }) {
  const [home, activity] = await Promise.all([getClientHome(locationId), getRecentActivity(6, locationId)]);
  const b = home.board;

  if (home.status === 'error' || !b) {
    return (
      <Dash flow="row" className="mb-home-dash">
        <Widget
          primary
          title="This client’s books"
          w={12}
          h={2}
          state={{
            kind: 'error',
            title: 'This client’s home didn’t load',
            body: (
              <>
                The client’s queues couldn’t be read. <Link className="link" href="/dashboard">Reload the page</Link>, or press ⌘J
                and pick the client again.
              </>
            ),
          }}
        />
      </Dash>
    );
  }

  const all = steps(home);
  const month = monthLabel(home.today);
  // The client's Inbox total — the same number as its Inbox header and the rail badge.
  const needsYou = b.needsYou;
  const otherOpen = Math.max(0, b.toReview + b.needsAttention - (home.bands.decide.count + home.bands.check.count + home.bands.ready.count));
  const feedOpen = home.bands.decide.count + home.bands.check.count + home.bands.ready.count;
  const openSteps = all.filter((s) => !s.done).length;

  return (
    <div className="mb-home">
      <ShellLine
        items={[
          dayLabel(home.today),
          `${month} books review`,
          `Period ${PERIOD_WORD[b.periodStatus]}`,
          { label: needsYou > 0 ? `${needsYou.toLocaleString()} need you` : b.totalOpen > 0 ? `${b.totalOpen.toLocaleString()} open` : 'Nothing waiting', strong: true },
        ]}
      />

      <div className="mb-loop-h">
        <span className="t-head">{month} books review</span>
        <span className="t-cap">
          {b.name} · {b.shortCode}
          {b.isOwnBooks ? ' · Own books' : ''} · four steps, in order
        </span>
        <span className="sp" />
        <span className="t-cap tnum">{openSteps === 0 ? 'All four steps done' : `${openSteps} of 4 steps open`}</span>
      </div>
      <nav className="mb-loop" aria-label={`${month} books review`}>
        {all.map((s) => {
          const st = stateOf(all, s);
          return (
            <Link key={s.n} href={s.href} className="mb-lstep" data-state={st} aria-current={st === 'current' ? 'step' : undefined}>
              <span className="num" aria-hidden="true">
                {st === 'done' ? <Icon name="check" /> : s.n}
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="nm">
                  {s.name}
                  <span className="sr">{st === 'done' ? ', done' : st === 'current' ? ', current step' : ''}</span>
                </span>
                <span className="cnt tnum">{s.count}</span>
                <span className="l2">{s.detail}</span>
              </span>
            </Link>
          );
        })}
      </nav>

      <Dash flow="row" className="mb-home-dash">
        <Widget
          primary
          title="Bank & card feed"
          count={feedOpen.toLocaleString()}
          meta="Open lines · lowest confidence first"
          w={8}
          h={4}
          foot={
            <>
              <span className="tnum">
                Then {home.bands.check.count.toLocaleString()} to check, then the Ready batch of {home.bands.ready.count.toLocaleString()}
              </span>
              <Link className="btn btn--primary" href="/bank-feed">
                Open bank feed <Icon name="right" />
              </Link>
            </>
          }
          state={
            feedOpen === 0
              ? {
                  kind: 'done',
                  title: 'Every bank and card line is posted',
                  body: `Nothing is waiting in ${b.name}’s feed. Next: reconcile the accounts for ${month}.`,
                  action: (
                    <Link className="btn btn--primary" href="/reconciliation">
                      Start reconciling
                    </Link>
                  ),
                }
              : undefined
          }
        >
          <div className="bands mb-bands-in" role="list" aria-label="Confidence bands">
            <div className="band-tab" role="listitem" aria-current="true">
              <span className="eyebrow">Decide</span>
              <span className="v tnum">{home.bands.decide.count.toLocaleString()}</span>
              <span className="t-cap tnum">Under 70 or flagged · {cents(home.bands.decide.amountCents)}</span>
            </div>
            <div className="band-tab" role="listitem">
              <span className="eyebrow">Check</span>
              <span className="v tnum">{home.bands.check.count.toLocaleString()}</span>
              <span className="t-cap tnum">70–89 · one look · {cents(home.bands.check.amountCents)}</span>
            </div>
            <div className="band-tab" role="listitem">
              <span className="eyebrow">Ready</span>
              <span className="v tnum">{home.bands.ready.count.toLocaleString()}</span>
              <span className="t-cap tnum">90+ · batch · {cents(home.bands.ready.amountCents)}</span>
            </div>
          </div>
          {home.decide.length > 0 ? (
            <ClientDecideQueue items={home.decide} />
          ) : (
            <div className="wg-state">
              <span className="wg-done-mark" aria-hidden="true">
                <Icon name="check" />
              </span>
              <span className="t-head">Nothing to decide</span>
              <p>Every open line scored 70 or better. Check them once each, then approve the Ready batch.</p>
            </div>
          )}
        </Widget>

        <Widget
          title="Money"
          meta={`Posted GL · ${shortLabel(home.today)}`}
          w={4}
          h={2}
          pad
          foot={
            <Link className="btn btn--quiet" href="/cash">
              Cash position
            </Link>
          }
        >
          <Evidence
            rows={[
              { label: 'Book cash', value: Math.round(b.cashCents) },
              { label: 'Open receivables', value: Math.round(b.openARCents) },
              { label: 'Less open payables', value: -Math.round(b.openAPCents) },
            ]}
            total={{ label: 'Cash + receivables − payables' }}
          />
        </Widget>

        {/* The client's Inbox, tab by tab — the same shared counts as the Inbox tabs and
            the rail badge, so this can never say "nothing waiting" while the Inbox has 100+. */}
        <Widget
          title="In your Inbox"
          count={home.work.total.toLocaleString()}
          meta={`${b.name} only · same counts as the Inbox`}
          w={4}
          h={2}
          foot={
            otherOpen > 0 ? (
              <Link className="btn btn--quiet" href="/bills">
                {otherOpen.toLocaleString()} receipts and bills to review <Icon name="right" />
              </Link>
            ) : undefined
          }
        >
          <ul className="mb-waiting">
            <li>
              <Link href="/inbox?tab=approvals">
                <span>Approvals and policy holds</span>
                <b className="tnum">{home.work.lanes.approvals.toLocaleString()}</b>
              </Link>
            </li>
            <li>
              <Link href="/inbox?tab=exceptions">
                <span>
                  Exceptions
                  {b.openExceptions > 0 ? <span className="ink-3"> · {b.openExceptions.toLocaleString()} AI proposals</span> : null}
                </span>
                <b className="tnum">{home.work.lanes.exceptions.toLocaleString()}</b>
              </Link>
            </li>
            <li>
              <Link href="/inbox?tab=alerts">
                <span>Alerts due within 30 days</span>
                <b className="tnum">{home.work.lanes.alerts.toLocaleString()}</b>
              </Link>
            </li>
            <li>
              <Link href="/inbox?tab=drafts">
                <span>Draft journal entries</span>
                <b className="tnum">{home.work.lanes.drafts.toLocaleString()}</b>
              </Link>
            </li>
          </ul>
          {home.workDegraded.length > 0 && (
            <p className="t-cap" role="status" style={{ padding: '0 16px 12px' }}>
              Some queues didn’t answer ({home.workDegraded.join(', ')}); these counts may be low.
            </p>
          )}
        </Widget>

        <Widget
          title="Latest activity"
          meta={`${b.name} · bank and card lines, newest first`}
          w={8}
          h={2}
          state={activity.length === 0 ? { kind: 'empty', title: 'No bank lines yet', body: 'Connect this client’s bank feed and new transactions land here as they arrive.' } : undefined}
        >
          <ul className="mb-activity">
            {activity.map((a) => (
              <li key={a.id}>
                <span style={{ minWidth: 0 }}>
                  <span className="l1">{a.description}</span>
                  <span className="l2">{[a.status.toLowerCase().replace(/_/g, ' '), ago(a.created_at)].join(' · ')}</span>
                </span>
                {a.amount_cents != null && <span className="n">{cents(Number(a.amount_cents))}</span>}
              </li>
            ))}
          </ul>
        </Widget>

        <Widget
          title={`${month} close`}
          w={4}
          h={2}
          pad
          foot={
            <Link className="btn btn--quiet" href="/close">
              Open close
            </Link>
          }
        >
          <p className="mb-period-big">
            <Pip kind={PERIOD_PIP[b.periodStatus]} />
            <span className="t-head">
              {month} is {PERIOD_WORD[b.periodStatus]}
            </span>
          </p>
          <p className="ink-2" style={{ marginTop: 8 }}>
            {b.periodStatus === 'HARD_CLOSE'
              ? 'Hard-closed: nothing can post to this month without a reopen.'
              : b.periodStatus === 'SOFT_CLOSE'
                ? 'Soft-closed: posting needs a controller. Finish the tasks, then hard-close.'
                : b.periodStatus === 'NO_PERIOD'
                  ? 'No fiscal period exists for this month yet — set one up before closing.'
                  : 'Open: review, reconcile and check, then work the close tasks.'}
          </p>
        </Widget>

        {/* Period-based P&L — the one home figure that follows the period picker. */}
        <PerformanceWidget scopeLabel={b.name} />
      </Dash>
    </div>
  );
}
