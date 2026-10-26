/**
 * The eight migration stages in plain words (spec §5.3.1 — binding UI copy) and the
 * stage machine. PURE: the service gathers `StageFacts` from the database; this file
 * decides what each stage's status is, which stage is current and what the one next
 * step is. A stage's "Done when" sentence IS its derivation rule.
 *
 * Part 1 note: "Practice close" (shadow close, OB-13) ships in part 2. Until then a
 * clean-switch project skips it automatically (shown as skipped, never as done); a
 * parallel project needs someone to skip it explicitly with a reason before sign-off.
 */

import type { HistoryDepth, ShadowMode, Stage } from './types';
import { STAGES } from './types';
import { dollars, plural } from './format';

export interface StageDefinition {
  stage: Stage;
  number: number;
  /** UI label — the only name a person ever sees. */
  label: string;
  /** One line on the tab. */
  oneLine: string;
  whatHappens: string;
  whoDoesIt: string;
  doneWhen: string;
}

export const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  {
    stage: 'plan',
    number: 1,
    label: 'Gather info',
    oneLine: 'Cutover date and systems',
    whatHappens: 'Set the cutover date and how much history to bring, and name every system the client uses.',
    whoDoesIt: 'Accounting manager (migration lead). The client owner answers the discovery questions.',
    doneWhen: 'Every system is named and the cutover date is set.',
  },
  {
    stage: 'connect',
    number: 2,
    label: 'Connect systems',
    oneLine: 'Read-only sign-in or files',
    whatHappens: 'Sign in to each system read-only, or follow its export steps and drop the files. Loans, bank recs and leases go in the same place.',
    whoDoesIt: 'Preparer, or the client owner when they hold the login.',
    doneWhen: 'Every source has been pulled once.',
  },
  {
    stage: 'preflight',
    number: 3,
    label: 'Check data quality',
    oneLine: '24 automatic checks',
    whatHappens: '24 checks run on the old books: bank not reconciled, A/R that doesn’t match its aging, suspense balances and more. Each finding gets a decision: fix it in the old system, handle it here, or accept it.',
    whoDoesIt: 'MeritBooks runs them. The preparer decides each one.',
    doneWhen: 'No blockers remain and every warning has a decision.',
  },
  {
    stage: 'map',
    number: 4,
    label: 'Match accounts',
    oneLine: 'Old chart to Merit chart',
    whatHappens: 'Each old account is matched to the MeritBooks chart. Rules your team approved on other clients and AI propose, largest balance first. Customers, vendors, items and classes are matched too, so nothing is created twice.',
    whoDoesIt: 'Preparer decides. The accounting manager settles shared rules.',
    doneWhen: 'Every account with a balance is matched.',
  },
  {
    stage: 'tie_out',
    number: 5,
    label: 'Prove balances',
    oneLine: 'Old minus new is zero',
    whatHappens: 'Opening balances, open invoices and open bills load, then the trial balance, receivables, payables, bank and equity are each tied: old books minus new books must be zero.',
    whoDoesIt: 'Preparer signs the balance proof. The reviewer checks.',
    doneWhen: 'Every tie is zero and the preparer has signed.',
  },
  {
    stage: 'shadow_close',
    number: 6,
    label: 'Practice close',
    oneLine: 'One month in both systems',
    whatHappens: 'Close one month in MeritBooks and in the old system, then compare them account by account.',
    whoDoesIt: 'Preparer. The reviewer reads the differences.',
    doneWhen: 'Every difference is explained.',
  },
  {
    stage: 'certified',
    number: 7,
    label: 'Signed off',
    oneLine: 'Reviewer signs certificate',
    whatHappens: 'The reviewer signs the Conversion Certificate. Months before the cutover lock for good.',
    whoDoesIt: 'Reviewer — never the preparer.',
    doneWhen: 'The certificate is signed.',
  },
  {
    stage: 'live',
    number: 8,
    label: 'Live',
    oneLine: 'MeritBooks is the book',
    whatHappens: 'MeritBooks is the book of record. The old ledger is archived; field, bank and card systems keep feeding.',
    whoDoesIt: 'MeritBooks, automatically. The bookkeeper takes over.',
    doneWhen: 'The client moves to the close grid.',
  },
];

const DEF = new Map(STAGE_DEFINITIONS.map((d) => [d.stage, d]));

export function stageDefinition(stage: Stage): StageDefinition {
  return DEF.get(stage) ?? STAGE_DEFINITIONS[0];
}

/** Plain label for any stored stage value (paused / abandoned included). Never the DB value. */
export function stageLabel(stage: string): string {
  if (stage === 'paused') return 'Paused';
  if (stage === 'abandoned') return 'Stopped';
  return DEF.get(stage as Stage)?.label ?? 'Gather info';
}

export const HISTORY_DEPTH_COPY: Record<HistoryDepth, { label: string; detail: string }> = {
  opening_only: {
    label: 'Opening balances only',
    detail: 'One opening entry at the cutover. Fastest; reports start the day MeritBooks takes over.',
  },
  monthly: {
    label: 'Monthly history',
    detail: 'One summary entry per month for this fiscal year and last, so comparisons work on day one. (Posting history arrives in part 2; the plan is kept.)',
  },
  monthly_plus_detail: {
    label: 'Monthly history + transaction detail',
    detail: 'Monthly history, plus every source transaction kept read-only for drill-down and to teach vendor habits. (Part 2.)',
  },
};

export const SHADOW_MODE_COPY: Record<ShadowMode, { label: string; detail: string }> = {
  clean_switch: {
    label: 'Clean switch',
    detail: 'Stop keeping the old books at cutover. The first MeritBooks close is checked against trend and outside evidence.',
  },
  parallel: {
    label: 'Practice close in both systems',
    detail: 'Keep the old system one more month and compare the close account by account. (The side-by-side compare arrives in part 2.)',
  },
  none: {
    label: 'No practice close',
    detail: 'Only with a controller’s reason. Printed on the certificate.',
  },
};

// ── Stage machine ────────────────────────────────────────────────────────────

/** Everything the stage tests read. Gathered by the service, from real rows. */
export interface StageFacts {
  cutoverDate: string | null;
  systemsConfirmed: boolean;
  /** Active (non-archived) sources. */
  sourceCount: number;
  /** Sources that have pulled / staged at least once. */
  sourcesPulled: number;
  /** Required recipe files not dropped yet, across sources. */
  filesMissing: number;
  preflightRan: boolean;
  openBlockers: number;
  openBlockerCents: number;
  undecidedWarnings: number;
  /** Source accounts carrying a balance at cutover. */
  balanceAccounts: number;
  balanceAccountsMatched: number;
  unmatchedBalanceCents: number;
  /** The opening entry is staged (conversion session) / posted. */
  openingStaged: boolean;
  openingPosted: boolean;
  /** Ties with a non-zero difference and their absolute total. */
  tieDifferences: number;
  tieDifferenceCents: number;
  proofSigned: boolean;
  shadowMode: ShadowMode;
  certificateIssued: boolean;
  live: boolean;
  skipped: ReadonlyArray<Stage>;
}

export type StageStatus = 'done' | 'current' | 'todo' | 'skipped';

export interface StageState {
  stage: Stage;
  label: string;
  status: StageStatus;
  /** Plain detail for the rail ("2 of 3 sources pulled"). */
  detail: string;
}

function isDone(stage: Stage, f: StageFacts): boolean {
  switch (stage) {
    case 'plan':
      return !!f.cutoverDate && f.systemsConfirmed && f.sourceCount > 0;
    case 'connect':
      return f.sourceCount > 0 && f.sourcesPulled >= f.sourceCount && f.filesMissing === 0;
    case 'preflight':
      return f.preflightRan && f.openBlockers === 0 && f.undecidedWarnings === 0;
    case 'map':
      return f.balanceAccounts > 0 && f.balanceAccountsMatched >= f.balanceAccounts;
    case 'tie_out':
      return f.proofSigned;
    case 'shadow_close':
      // Part 1: practice close itself isn't built — it is done only by an explicit skip.
      return false;
    case 'certified':
      return f.certificateIssued;
    case 'live':
      return f.live;
  }
}

function detailFor(stage: Stage, f: StageFacts, status: StageStatus): string {
  if (status === 'skipped') {
    return stage === 'shadow_close' && f.shadowMode !== 'parallel' ? 'Skipped · clean switch' : 'Skipped';
  }
  switch (stage) {
    case 'plan':
      if (!f.cutoverDate) return 'Cutover date not set';
      if (f.sourceCount === 0) return 'No systems named yet';
      return f.systemsConfirmed ? `${plural(f.sourceCount, 'system')} named` : 'Systems not confirmed';
    case 'connect':
      if (f.sourceCount === 0) return 'Nothing to connect yet';
      return f.filesMissing > 0
        ? `${f.sourcesPulled} of ${f.sourceCount} pulled · ${plural(f.filesMissing, 'file')} missing`
        : `${f.sourcesPulled} of ${f.sourceCount} pulled`;
    case 'preflight':
      if (!f.preflightRan) return 'Not run yet';
      if (f.openBlockers > 0) return `${plural(f.openBlockers, 'blocker')} · ${dollars(f.openBlockerCents)}`;
      if (f.undecidedWarnings > 0) return `${plural(f.undecidedWarnings, 'warning')} to decide`;
      return 'No blockers';
    case 'map':
      if (f.balanceAccounts === 0) return 'Waiting for a trial balance';
      return f.balanceAccountsMatched >= f.balanceAccounts
        ? `${plural(f.balanceAccounts, 'account')} matched`
        : `${f.balanceAccounts - f.balanceAccountsMatched} to decide · ${dollars(f.unmatchedBalanceCents)}`;
    case 'tie_out':
      if (f.proofSigned) return 'Preparer signed';
      if (!f.openingStaged) return 'Opening balances not loaded';
      if (!f.openingPosted) return 'Opening entry not posted';
      if (f.tieDifferences > 0) return `${plural(f.tieDifferences, 'difference')} · ${dollars(f.tieDifferenceCents)}`;
      return 'Ties · ready to sign';
    case 'shadow_close':
      return f.shadowMode === 'parallel' ? 'Arrives in part 2 · skip with a reason' : 'Clean switch';
    case 'certified':
      return f.certificateIssued ? 'Certificate signed' : f.proofSigned ? 'Waiting for the reviewer' : 'After the balance proof';
    case 'live':
      return f.live ? 'MeritBooks is the book' : 'After sign-off';
  }
}

/** The status of all eight stages, and which one is current (the first not done/skipped). */
export function deriveStages(f: StageFacts): { stages: StageState[]; current: Stage } {
  const skipped = new Set<Stage>(f.skipped);
  // A clean switch (or "none") never runs a practice close in part 1 — shown as skipped.
  if (f.shadowMode !== 'parallel') skipped.add('shadow_close');
  let current: Stage | null = null;
  const stages: StageState[] = STAGES.map((stage) => {
    const def = stageDefinition(stage);
    let status: StageStatus;
    if (stage !== 'live' && stage !== 'certified' && skipped.has(stage) && !isDone(stage, f)) status = 'skipped';
    else if (isDone(stage, f)) status = 'done';
    else if (current === null) {
      status = 'current';
      current = stage;
    } else status = 'todo';
    return { stage, label: def.label, status, detail: '' };
  });
  for (const s of stages) s.detail = detailFor(s.stage, f, s.status);
  return { stages, current: current ?? 'live' };
}

/**
 * The stored stage: the derived current stage, except that a certificate / go-live is
 * never undone by data changing underneath (those are explicit, gated transitions).
 */
export function storedStage(f: StageFacts): Stage {
  if (f.live) return 'live';
  if (f.certificateIssued) return 'certified';
  const { current } = deriveStages(f);
  // "Signed off" is reachable only after the preparer signed (a prepared certificate is
  // linked, which the DB CHECK requires); "Live" needs live_at, so an issued-but-not-yet-
  // live project rests on "Signed off".
  if (current === 'live') return 'certified';
  if (current === 'certified') return f.proofSigned ? 'certified' : 'tie_out';
  return current;
}

export type NextActionKind =
  | 'plan'
  | 'connect'
  | 'run_preflight'
  | 'decide_findings'
  | 'match_accounts'
  | 'load_opening'
  | 'post_opening'
  | 'fix_differences'
  | 'sign_proof'
  | 'skip_practice_close'
  | 'sign_off'
  | 'go_live'
  | 'done';

export interface NextAction {
  kind: NextActionKind;
  /** One verb button, the exact step ("Match 38 accounts"). */
  label: string;
  /** Which stage tab the button opens. */
  stage: Stage;
}

/** The one next step for a project (Tower "Next step" column + workspace primary button). */
export function nextAction(f: StageFacts): NextAction {
  const { current } = deriveStages(f);
  switch (current) {
    case 'plan':
      if (!f.cutoverDate) return { kind: 'plan', label: 'Set the cutover date', stage: 'plan' };
      return { kind: 'plan', label: f.sourceCount === 0 ? 'Name the systems' : 'Confirm the systems', stage: 'plan' };
    case 'connect':
      if (f.filesMissing > 0) return { kind: 'connect', label: `Drop ${plural(f.filesMissing, 'file')}`, stage: 'connect' };
      return { kind: 'connect', label: `Connect ${plural(f.sourceCount - f.sourcesPulled, 'source')}`, stage: 'connect' };
    case 'preflight':
      if (!f.preflightRan) return { kind: 'run_preflight', label: 'Check data quality', stage: 'preflight' };
      if (f.openBlockers > 0) return { kind: 'decide_findings', label: `Fix ${plural(f.openBlockers, 'data issue')}`, stage: 'preflight' };
      return { kind: 'decide_findings', label: `Decide ${plural(f.undecidedWarnings, 'warning')}`, stage: 'preflight' };
    case 'map':
      if (f.balanceAccounts === 0) return { kind: 'connect', label: 'Drop the trial balance', stage: 'connect' };
      return { kind: 'match_accounts', label: `Match ${plural(f.balanceAccounts - f.balanceAccountsMatched, 'account')}`, stage: 'map' };
    case 'tie_out':
      if (!f.openingStaged) return { kind: 'load_opening', label: 'Load opening balances', stage: 'tie_out' };
      if (!f.openingPosted) return { kind: 'post_opening', label: 'Post the opening entry', stage: 'tie_out' };
      if (f.tieDifferences > 0) return { kind: 'fix_differences', label: `Fix ${plural(f.tieDifferences, 'difference')}`, stage: 'tie_out' };
      return { kind: 'sign_proof', label: 'Sign balance proof', stage: 'tie_out' };
    case 'shadow_close':
      return { kind: 'skip_practice_close', label: 'Decide on the practice close', stage: 'shadow_close' };
    case 'certified':
      return { kind: 'sign_off', label: 'Sign off and issue', stage: 'certified' };
    case 'live':
      return f.live ? { kind: 'done', label: 'Open the close grid', stage: 'live' } : { kind: 'go_live', label: 'Go live', stage: 'live' };
  }
}

/** Blocker dollars by class, for the Tower (documents carry a count, not dollars). */
export interface BlockerSummary {
  documents: number;
  dataQualityCents: number;
  matchingCents: number;
  balanceCents: number;
  totalCents: number;
  /** One plain phrase for the Tower cell ("$3,140.00 · 2 differences"). */
  phrase: string;
}

export function blockerSummary(f: StageFacts): BlockerSummary {
  const dataQualityCents = f.openBlockerCents;
  const matchingCents = f.balanceAccounts > f.balanceAccountsMatched ? f.unmatchedBalanceCents : 0;
  const balanceCents = f.proofSigned ? 0 : f.tieDifferenceCents;
  const totalCents = dataQualityCents + matchingCents + balanceCents;
  const { current } = deriveStages(f);
  let phrase = 'None';
  if (f.live) phrase = 'None';
  else if (current === 'connect' && f.filesMissing > 0) phrase = `${plural(f.filesMissing, 'file')} missing`;
  else if (current === 'preflight' && f.openBlockers > 0) phrase = `${dollars(dataQualityCents)} · ${plural(f.openBlockers, 'data blocker')}`;
  else if (current === 'map' && matchingCents > 0) phrase = `${dollars(matchingCents)} · ${f.balanceAccounts - f.balanceAccountsMatched} to decide`;
  else if (current === 'tie_out' && balanceCents > 0) phrase = `${dollars(balanceCents)} · ${plural(f.tieDifferences, 'difference')}`;
  else if (totalCents > 0) phrase = dollars(totalCents);
  return { documents: f.filesMissing, dataQualityCents, matchingCents, balanceCents, totalCents, phrase };
}
