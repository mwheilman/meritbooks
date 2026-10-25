import Link from 'next/link';
import { ButtonLink, Widget } from '@meritbooks/merit-ui';
import type { HomeWidgetKey, MobileActionKey, PlanExperience } from '@meritbooks/industry-packs/src/types';
import { homeFor, mobileActionsFor } from '@meritbooks/industry-packs/src/experience';
import { canReach, type NavAccess } from '@/lib/nav';
import type { ModuleKey } from '@/lib/packs';
import type { PersonaGroup } from '@/lib/access/types';
import type { Vocabulary } from '@/lib/pm/vocab';
import { lower } from '@/lib/pm/vocab';

/**
 * The industry part of a persona's home (UX seat §3b; pack manifest v2 `home` slot): the pack's
 * signature boards for this persona, in the pack's order, and the three things one tap away.
 * Each tile opens the real screen; a board the company doesn't use or the person can't open is
 * left out (absent, not greyed).
 */

interface Board {
  title: string;
  body: string;
  href: string;
  /** Any one of these modules switches the board on (none = always). */
  modules?: ReadonlyArray<ModuleKey | 'dealer_store'>;
}

const BOARDS: Partial<Record<HomeWidgetKey, (v: Vocabulary) => Board>> = {
  dispatch_board: () => ({ title: 'Dispatch board', body: 'Techs by hour, the unassigned queue and live status.', href: '/dispatch', modules: ['dispatch'] }),
  service_board: (v) => ({ title: 'Service board', body: `${v.jobs} by status and technician, with days in the shop.`, href: '/work-orders', modules: ['dispatch'] }),
  capacity_board: () => ({ title: 'Production capacity', body: 'Work centers by week: hours booked against capacity.', href: '/production', modules: ['production'] }),
  install_board: () => ({ title: 'Install board', body: 'Installers by day, square-foot capacity and material-ready flags.', href: '/dispatch', modules: ['dispatch'] }),
  crew_board: (v) => ({ title: 'Crew board', body: `${v.crews} by day across ${lower(v.jobs)}.`, href: '/schedule', modules: ['schedule'] }),
  draw_status: (v) => ({ title: `${v.draws} in flight`, body: 'Packages being built, submitted and funded, in lender order.', href: '/draws', modules: ['lender_draws'] }),
  selections_queue: (v) => ({ title: 'Client decisions', body: `${v.selections} waiting on the client, with allowance impact.`, href: '/selections', modules: ['selections'] }),
  item_tracker: (v) => ({ title: 'Item tracker', body: `${v.selections} by room, from proposed to installed.`, href: '/selections', modules: ['selections', 'procurement_markup'] }),
  utilization: () => ({ title: 'Utilization', body: 'Hours logged by person against target this week.', href: '/time', modules: ['time'] }),
  unit_aging: () => ({ title: 'Unit stock aging', body: 'Units in stock by days on hand and floor-plan cost.', href: '/stock', modules: ['dealer_store'] }),
  pay_apps_due: () => ({ title: 'Pay apps due', body: 'Pay applications to draft, send or chase this period.', href: '/billing', modules: ['billing'] }),
  productivity: () => ({ title: 'Labor productivity', body: 'Installed quantities against hours and budget by cost code.', href: '/job-cost', modules: ['budget'] }),
};

/** Field-app buttons that have a screen in the office app today. */
const FIELD_ACTION: Partial<Record<MobileActionKey, { label: string; href: string }>> = {
  clock_in: { label: 'Clock in', href: '/time' },
  crew_time: { label: 'Crew time', href: '/time' },
  approve_crew_time: { label: 'Approve crew time', href: '/time' },
  log_time: { label: 'Log time', href: '/time' },
  timer: { label: 'Start a timer', href: '/time' },
  daily_log: { label: 'Daily report', href: '/daily-logs' },
  site_visit_report: { label: 'Site visit report', href: '/daily-logs' },
  punch_item: { label: 'Punch item', href: '/punch-list' },
  todo: { label: 'To-do', href: '/punch-list' },
  on_my_way: { label: 'On my way', href: '/' },
  start: { label: 'Start the visit', href: '/' },
  start_ticket: { label: 'Start the ticket', href: '/' },
  clock_on_ro_line: { label: 'Clock on a line', href: '/time' },
  operation_start_stop: { label: 'Start an operation', href: '/production' },
  request_change_order: { label: 'Request a change order', href: '/change-orders' },
  stage_complete: { label: 'Mark a stage complete', href: '/schedule' },
};

/** UX seat §3b "3 actions one tap away", per persona group. */
function quickActions(group: PersonaGroup, v: Vocabulary): Array<{ label: string; href: string }> {
  switch (group) {
    case 'management': return [{ label: 'Approve the top item', href: '/approvals' }, { label: `Open a ${lower(v.job)}`, href: '/jobs' }, { label: 'Margin by job', href: '/insights/margin' }];
    case 'admin': return [{ label: 'New lead', href: '/leads?new=1' }, { label: 'Schedule the next one', href: '/dispatch' }, { label: `Send ${lower(v.billing)}`, href: '/billing' }];
    case 'pm': return [{ label: `Open a ${lower(v.job)}`, href: '/jobs' }, { label: `New ${lower(v.change_order)}`, href: '/change-orders' }, { label: 'Approve the next item', href: '/approvals' }];
    case 'sales': return [{ label: 'New lead', href: '/leads?new=1' }, { label: v.estimates, href: '/estimates' }, { label: 'Customers', href: '/customers' }];
    default: return [];
  }
}

export interface PackHomeStripProps {
  experience: PlanExperience | null;
  group: PersonaGroup;
  access: NavAccess;
  companyId: string | null;
  modules: ReadonlyArray<ModuleKey>;
  isDealer: boolean;
  vocab: Vocabulary;
  /** The pack's name ("Field service") for the section label. */
  packName: string | null;
}

export function packBoards(p: Pick<PackHomeStripProps, 'experience' | 'group' | 'access' | 'companyId' | 'modules' | 'isDealer' | 'vocab'>): Board[] {
  const used = new Set<string>([...p.modules, ...(p.isDealer ? ['dealer_store'] : [])]);
  return (homeFor(p.experience, p.group) ?? [])
    .map((k) => BOARDS[k]?.(p.vocab))
    .filter((b): b is Board => !!b)
    .filter((b) => !b.modules || b.modules.some((m) => used.has(m)))
    .filter((b) => canReach(p.access, b.href, p.companyId))
    .filter((b, i, all) => all.findIndex((x) => x.href === b.href && x.title === b.title) === i)
    .slice(0, 3);
}

export function packFieldActions(p: Pick<PackHomeStripProps, 'experience' | 'group' | 'access' | 'companyId'>): Array<{ label: string; href: string }> {
  return mobileActionsFor(p.experience, p.group)
    .map((a) => FIELD_ACTION[a])
    .filter((a): a is { label: string; href: string } => !!a && canReach(p.access, a.href, p.companyId))
    .filter((a, i, all) => all.findIndex((x) => x.label === a.label) === i)
    .slice(0, 3);
}

export function PackHomeStrip(p: PackHomeStripProps) {
  if (!p.experience) return null;
  const boards = packBoards(p);
  const field = p.group === 'supervisor' || p.group === 'labor' ? packFieldActions(p) : [];
  const quick = (field.length ? field : quickActions(p.group, p.vocab)).filter((a) => canReach(p.access, a.href.split('?')[0]!, p.companyId));
  if (!boards.length && !quick.length) return null;
  return (
    <section className="dash" style={{ gridAutoFlow: 'row', marginBottom: 'var(--s3)' }} aria-label={p.packName ? `${p.packName} shortcuts` : 'Shortcuts'}>
      {quick.length > 0 && (
        <Widget w={boards.length ? 4 : 12} h={2} title="One tap away" meta={p.packName ?? undefined} pad>
          <div className="btn-row" style={{ flexWrap: 'wrap' }}>
            {quick.map((a, i) => (
              <ButtonLink key={a.label} href={a.href} variant={i === 0 ? 'primary' : 'default'}>{a.label}</ButtonLink>
            ))}
          </div>
        </Widget>
      )}
      {boards.map((b) => (
        <Widget key={b.title} w={quick.length ? Math.floor(8 / boards.length) : Math.floor(12 / boards.length)} h={2} title={b.title} pad foot={<Link className="link" href={b.href}>Open</Link>}>
          <p className="t-cap ink-2">{b.body}</p>
        </Widget>
      ))}
    </section>
  );
}
