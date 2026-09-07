import {
  Compass,
  Inbox,
  Landmark,
  FileText,
  BarChart3,
  ClipboardCheck,
  LayoutGrid,
  Settings,
  Rocket,
  type LucideIcon,
} from 'lucide-react';
import type { UserRole } from '@/lib/rbac/permissions';

/**
 * A single card in the first-session guided tour. Each step is self-describing:
 * an icon, a short title, one or two plain-language sentences ("what this is /
 * why you'll use it"), and an optional deep link to the real destination.
 */
export interface TourStep {
  /** Stable id (used for React keys + progress-dot aria labels). */
  id: string;
  icon: LucideIcon;
  title: string;
  /** 1-2 sentences of plain-language "what this is / why you'll use it." */
  body: string;
  /** Optional "Take me there" deep link to the real route. */
  cta?: { label: string; href: string };
  /** Marks the closing "start using the app" step (rendered as the primary CTA). */
  isFinal?: boolean;
}

/**
 * The identity signals the tour tailors itself to. All are already present in the
 * shared `useMe()` context, so the tour needs no extra fetch. Every field is
 * degrade-safe: a null role / empty name still yields a friendly generic tour.
 */
export interface TourContext {
  firstName: string;
  role: UserRole | null;
  roleLabel: string;
  orgName: string;
  isAdmin: boolean;
  canManageUsers: boolean;
  canEditSystemSettings: boolean;
}

/** Roles whose day is oversight/approval-shaped rather than data-entry-shaped. */
const LEADERSHIP_ROLES: readonly UserRole[] = [
  'company_admin',
  'cfo',
  'merit_controller',
  'assistant_cfo',
];

/**
 * True when this member should see the oversight-flavored tour (approvals, the
 * company picker, settings) rather than the operator-flavored one (bank feed,
 * bills). We look at explicit capability flags first so a delegated admin still
 * gets the leadership tour even if their base role isn't in the list.
 */
export function isLeadershipTour(ctx: TourContext): boolean {
  return (
    ctx.isAdmin ||
    ctx.canManageUsers ||
    ctx.canEditSystemSettings ||
    (ctx.role !== null && LEADERSHIP_ROLES.includes(ctx.role))
  );
}

/**
 * Build the ordered list of tour steps for this member.
 *
 * Role-aware by emphasis, not gating: everyone gets a warm welcome, the Inbox,
 * Reports, and a clear finish. Leaders/admins additionally get Approvals, the
 * company picker (Entities), and Settings; hands-on bookkeepers get the Bank Feed
 * and Bills instead. Both branches land at 6-7 steps.
 */
export function buildTourSteps(ctx: TourContext): TourStep[] {
  const name = ctx.firstName || 'there';
  const company = ctx.orgName || 'your company';
  const roleLabel = ctx.roleLabel || 'teammate';
  const leadership = isLeadershipTour(ctx);

  const welcome: TourStep = {
    id: 'welcome',
    icon: Compass,
    title: `Welcome, ${name}`,
    body: `You're set up as ${roleLabel} on ${company}. The books are already live — this quick tour points out the handful of places you'll spend most of your time.`,
    cta: { label: 'Open your dashboard', href: '/dashboard' },
  };

  const inbox: TourStep = {
    id: 'inbox',
    icon: Inbox,
    title: 'Your Inbox is home base',
    body: 'Anything that needs a person — flagged transactions, exceptions, approvals waiting on you — lands here first. Clear the Inbox and the day is done.',
    cta: { label: 'Take me to the Inbox', href: '/inbox' },
  };

  const reports: TourStep = {
    id: 'reports',
    icon: BarChart3,
    title: 'Reports, always current',
    body: 'The P&L, balance sheet, and cash flow read straight off the ledger — no exporting, no rebuilding. Pick a period and drill from any number down to the underlying entry.',
    cta: { label: 'Explore Reports', href: '/reports' },
  };

  const start: TourStep = {
    id: 'start',
    icon: Rocket,
    title: "You're ready to go",
    body: `That's the quick lap, ${name}. Everything you saw lives in the left sidebar whenever you need it — jump into your dashboard and start working the books.`,
    cta: { label: 'Start using MeritBooks', href: '/dashboard' },
    isFinal: true,
  };

  if (leadership) {
    const approvals: TourStep = {
      id: 'approvals',
      icon: ClipboardCheck,
      title: 'Approvals run through you',
      body: 'Bills, payments, and journal entries above their threshold pause for sign-off. Set the routing once and MeritBooks enforces the chain on every posting.',
      cta: { label: 'Review approval workflows', href: '/settings/approvals' },
    };

    const companies: TourStep = {
      id: 'companies',
      icon: LayoutGrid,
      title: 'Every entity, one login',
      body: 'Switch companies from the picker at the top of the sidebar, or see them all — balances, close status, and health — from the Entities view.',
      cta: { label: 'See all entities', href: '/portfolio' },
    };

    const settings: TourStep = {
      id: 'settings',
      icon: Settings,
      title: 'Make it yours',
      body: 'Invite teammates, tune roles and permissions, dial in AI autonomy, and connect your bank and payment rails — all from Settings when you need them.',
      cta: { label: 'Open Settings', href: '/settings' },
    };

    // Leadership: welcome -> inbox -> approvals -> companies -> reports -> settings -> start (7)
    return [welcome, inbox, approvals, companies, reports, settings, start];
  }

  const bankFeed: TourStep = {
    id: 'bank-feed',
    icon: Landmark,
    title: 'The Bank Feed does the sorting',
    body: 'Transactions arrive pre-categorized with an AI confidence score, lowest first so your attention goes where it matters. Approve, flag, or fix — the ledger updates as you go.',
    cta: { label: 'Open the Bank Feed', href: '/bank-feed' },
  };

  const bills: TourStep = {
    id: 'bills',
    icon: FileText,
    title: 'Bills capture themselves',
    body: 'Forward or upload a bill and MeritBooks reads the vendor, amount, and GL coding for you. You confirm and it routes for payment — no manual keying.',
    cta: { label: 'Go to Bills', href: '/bills' },
  };

  // Operator: welcome -> inbox -> bank feed -> bills -> reports -> start (6)
  return [welcome, inbox, bankFeed, bills, reports, start];
}
