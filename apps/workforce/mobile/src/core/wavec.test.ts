import { describe, expect, it } from 'vitest';
import type { ApprovalItem, Command, FinancingPlan, InboxPage, KioskSession, PhoneSheet, SellItem, SellOption } from './contract';
import { actionable, decisionDraft, flagsOf, needsReason, refusedHere, shownAmount } from './approvals';
import { byDiscipline, planCache, sheetFileName, toCached } from './drawings';
import { absoluteUrl, pngDataUrl, signDraft, signMissing } from './esign';
import { markDraft, overlayInbox } from './inbox';
import { cleanBadge, idle, identifyRefusal, indirectRunning, KIOSK_IDLE_MS, kioskDraft, pinReady, pressPin, runningOperations, sessionLive } from './kiosk';
import { monthlyPaymentCents, moneyText, optionPrice, parseDollars, planFor } from './money';
import type { QueuedCommand, QueueStatus } from './queue';
import { currentPunch, refusedTaps, roClockDraft, storiesFor, storyDraft, storyLine, storyReady } from './ro';

let n = 0;
const uid = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function q(command: Command, status: QueueStatus = 'pending', reason?: string): QueuedCommand {
  return {
    id: command.id, seq: ++n, kind: command.kind, command, status, attempts: 0, nextAttemptAt: 0, createdAt: 0, updatedAt: 0,
    lastError: null, result: reason ? { id: command.id, kind: command.kind, outcome: 'rejected', reason } : null, fileUri: null, dependsOn: null,
  };
}
const env = (at = '2026-10-24T15:00:00Z') => ({ id: uid(), at });

function item(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: uid(), object_type: 'change_order', object_id: uid(), object_ref: 'CO-4', company: null, job_id: null, job_label: 'J-1 Smith kitchen', title: 'CO-4 Add pantry',
    summary: null, status: 'PENDING', amount_cents: 245000, money_visible: true, facts: {}, step: 1, step_count: 2, round: 1, step_label: 'PM', escalated: false,
    due_at: '2026-10-26T12:00:00Z', overdue: false, submitted_at: '2026-10-24T10:00:00Z', submitted_by: 'Sam', can_act: true, on_behalf_of: null,
    self_approval: false, needs_reason: false, ...over,
  };
}

describe('money at the kitchen table', () => {
  it('monthly payment: amortised, 0 % divides, nonsense is 0', () => {
    expect(monthlyPaymentCents(1_000_000, 9.99, 60)).toBe(21242);
    expect(monthlyPaymentCents(1_200_000, 0, 12)).toBe(100000);
    expect(monthlyPaymentCents(1_000_001, 0, 12)).toBe(83334);
    expect(monthlyPaymentCents(0, 9.99, 60)).toBe(0);
    expect(monthlyPaymentCents(100, 9.99, 0)).toBe(0);
  });

  it('the plan quoted: the option’s own if the amount fits, else the default, else the longest term', () => {
    const plans: FinancingPlan[] = [
      { id: 'a', provider: 'X', name: '12 mo 0%', apr: 0, termMonths: 12, promo: 'Same as cash', minCents: 50000, maxCents: 500000, isDefault: false },
      { id: 'b', provider: 'X', name: '60 mo', apr: 9.99, termMonths: 60, promo: null, minCents: 100000, maxCents: null, isDefault: true },
      { id: 'c', provider: 'X', name: '120 mo', apr: 12.99, termMonths: 120, promo: null, minCents: 500000, maxCents: null, isDefault: false },
    ];
    expect(planFor(plans, 300000, 'a')?.id).toBe('a');
    expect(planFor(plans, 900000, 'a')?.id).toBe('b');
    expect(planFor(plans, 60000, null)?.id).toBe('a');
    expect(planFor(plans, 10000, null)).toBeNull();
  });

  it('option price follows the add-ons ticked on the phone, member price and rebate', () => {
    const o: SellOption = { id: 'o', estimateId: 'e', tier: 'BEST', name: 'Best', description: null, recommended: true, status: 'OPEN', rebateCents: 30000, rebateNote: null, financingPlanId: null, regularCents: 640000, memberCents: 590000 };
    const items: SellItem[] = [
      { id: 'uv', optionId: 'o', description: 'UV light', qty: 1, unitPriceCents: 45000, memberUnitPriceCents: 40000, optional: true, selected: false },
      { id: 'pad', optionId: 'o', description: 'Pad', qty: 1, unitPriceCents: 9900, memberUnitPriceCents: null, optional: true, selected: true },
    ];
    expect(optionPrice(o, items, {}, false)).toMatchObject({ regularCents: 640000, dueCents: 610000, memberSavingsCents: 50000 });
    const p = optionPrice(o, items, { uv: true, pad: false }, true);
    expect(p).toMatchObject({ regularCents: 675100, memberCents: 620100, dueCents: 590100 });
    expect(parseDollars('$1,250.5')).toBe(125050);
    expect(parseDollars('abc')).toBeNull();
    expect(moneyText(125050, 'en')).toBe('$1,250.50');
    expect(moneyText(100000, 'en')).toBe('$1,000');
  });
});

describe('approvals on the phone', () => {
  it('hides what I decided here and crew time listed under Crew; overdue first', () => {
    const a = item({ title: 'A' });
    const b = item({ title: 'B', overdue: true });
    const t = item({ object_type: 'time_entry', title: 'Time' });
    const other = item({ can_act: false });
    const queued = [q({ ...env(), ...decisionDraft(a, 'approve', null) } as Command)];
    const list = actionable([a, b, t, other], queued, new Set([t.object_id]));
    expect(list.map((i) => i.title)).toEqual(['B']);
  });

  it('flags, amounts only when visible, reasons where required, refusals shown', () => {
    const i = item({ overdue: true, facts: { overtime: true, over_budget: true }, self_approval: true });
    expect(flagsOf(i)).toEqual(['overdue', 'overtime', 'over_budget', 'self']);
    expect(shownAmount(item({ money_visible: false }))).toBeNull();
    expect(shownAmount(item())).toBe(245000);
    expect(needsReason(item(), 'approve')).toBe(false);
    expect(needsReason(item(), 'reject')).toBe(true);
    expect(needsReason(i, 'approve')).toBe(true);
    const d = decisionDraft(i, 'approve', ' Owner is the only approver ');
    expect(d).toMatchObject({ round: 1, step: 1, selfReason: 'Owner is the only approver', reason: null });
    const r = q({ ...env(), ...decisionDraft(item(), 'reject', 'No') } as Command, 'rejected', 'Sam already approved');
    expect(refusedHere([r])[0]!.reason).toBe('Sam already approved');
  });
});

describe('drawings cache plan', () => {
  const sheet = (jobId: string, number: string, bytes = 1000): PhoneSheet => ({ sheetId: uid(), jobId, number, title: null, discipline: number[0] ?? null, revisionId: uid(), revisionLabel: '1', setName: 'IFC', issuedOn: null, url: 'https://f/x', bytes });
  it('downloads new revisions, keeps current ones on disk, removes superseded, respects the budget with today first', () => {
    const today = 'job-today';
    const a = sheet(today, 'A-101');
    const b = sheet('job-later', 'S-201', 900);
    const c = sheet(today, 'M-301', 900);
    const old = toCached(sheet(today, 'A-101'), 1);
    const kept = toCached(a, 1);
    const plan = planCache([a, b, c], [kept, old], (r) => r === kept.revisionId, [today], 2000);
    expect(plan.keep.map((k) => k.revisionId)).toEqual([a.revisionId]);
    expect(plan.remove.map((r) => r.revisionId)).toEqual([old.revisionId]);
    expect(plan.download.map((d) => d.number)).toEqual(['M-301']);
    expect(plan.skipped.map((d) => d.number)).toEqual(['S-201']);
  });
  it('file names only from revision ids; sheets grouped by discipline in number order', () => {
    expect(sheetFileName('../../etc/passwd')).toBeNull();
    expect(sheetFileName('AAAAAAAA-0000-4000-8000-000000000001')).toBe('aaaaaaaa-0000-4000-8000-000000000001.pdf');
    const g = byDiscipline([{ discipline: 'A', number: 'A-110' }, { discipline: 'A', number: 'A-12' }, { discipline: null, number: 'G-1' }]);
    expect(g.map(([k, v]) => [k, v.map((x) => x.number)])).toEqual([['A', ['A-12', 'A-110']], ['—', ['G-1']]]);
  });
});

describe('station mode', () => {
  const s: KioskSession = {
    ok: true, session_token: 'sess_0123456789abcdef', expires_at: '2026-10-24T23:00:00Z', employee_id: 'e', name: 'Luis', operations: [],
    open: [{ punch_id: 'p', operation_id: 'op1', indirect_code: null, started_at: '2026-10-24T13:00:00Z', work_order: 'PRD-1', operation: 'Edge band' }],
  };
  it('PIN pad, badge cleanup, idle sign-out, session expiry', () => {
    let pin = '';
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const) pin = pressPin(pin, k);
    expect(pin).toBe('12345678');
    expect(pressPin(pin, 'del')).toBe('1234567');
    expect(pressPin(pin, 'clear')).toBe('');
    expect(pinReady('123')).toBe(false);
    expect(pinReady('1234')).toBe(true);
    expect(cleanBadge(' 00451\r\n')).toBe('00451');
    expect(cleanBadge('12')).toBeNull();
    expect(idle(0, KIOSK_IDLE_MS)).toBe(true);
    expect(idle(0, KIOSK_IDLE_MS - 1)).toBe(false);
    expect(sessionLive(s, Date.parse('2026-10-24T22:59:00Z'))).toBe(true);
    expect(identifyRefusal('PM_KIOSK_DEVICE_LOCKED')).toBe('locked');
  });
  it('what is running = sign-in snapshot + this badge session’s taps (queued or sent)', () => {
    const tap = (action: 'START' | 'STOP' | 'COMPLETE' | 'INDIRECT_START', operationId?: string, token = s.session_token) =>
      q({ ...env(), ...kioskDraft('L1', { ...s, session_token: token }, action, operationId ? { operationId } : { indirectCode: 'CLEANUP' }) } as Command);
    const queued = [tap('START', 'op2'), tap('COMPLETE', 'op1'), tap('START', 'op3', 'someone-else-session')];
    expect([...runningOperations(s, queued)]).toEqual(['op2']);
    expect(indirectRunning(s, [tap('INDIRECT_START')])).toBe('CLEANUP');
  });
});

describe('dealer RO clock + 3C', () => {
  it('the banner = server snapshot + taps since, in order', () => {
    const bundle = { serverTime: '2026-10-24T14:00:00Z', open: { companyId: 'L1', lineId: 'l1', kind: 'LINE', startedAt: '2026-10-24T13:00:00Z' } };
    expect(currentPunch(bundle, [])).toMatchObject({ lineId: 'l1', waiting: false });
    const on2 = q({ ...env('2026-10-24T14:30:00Z'), ...roClockDraft('clock_on', 'L1', { lineId: 'l2' }) } as Command);
    const wait = q({ ...env('2026-10-24T15:00:00Z'), ...roClockDraft('indirect', 'L1', { indirectKind: 'WAITING_PARTS' }) } as Command);
    expect(currentPunch(bundle, [on2])).toMatchObject({ lineId: 'l2', waiting: true });
    expect(currentPunch(bundle, [on2, wait])).toMatchObject({ kind: 'WAITING_PARTS', lineId: null });
    const off = q({ ...env('2026-10-24T15:10:00Z'), ...roClockDraft('clock_off', 'L1') } as Command);
    expect(currentPunch(bundle, [on2, wait, off])).toBeNull();
    const oldDone = q({ ...env('2026-10-24T12:00:00Z'), ...roClockDraft('clock_off', 'L1') } as Command, 'done');
    expect(currentPunch(bundle, [oldDone])).toMatchObject({ lineId: 'l1' });
  });
  it('a story needs one of the three Cs; drafts trim; saved stories list under the RO', () => {
    expect(storyReady({ complaint: ' ', cause: '', correction: '' })).toBe(false);
    const d = storyDraft('wo', 'l1', { complaint: ' Stalls ', cause: '', correction: 'New filter' });
    expect(d).toMatchObject({ kind: 'ro.line.story', lineId: 'l1', complaint: 'Stalls', cause: null, correction: 'New filter' });
    expect(storiesFor('wo', [q({ ...env(), ...d } as Command)])).toHaveLength(1);
    const lines = [{ id: 'a', workOrderId: 'wo', description: 'Diag', laborOp: null, flagHours: 1, status: 'APPROVED' }, { id: 'b', workOrderId: 'wo', description: 'Fix', laborOp: null, flagHours: 2, status: 'APPROVED' }];
    expect(storyLine('wo', lines, { lineId: 'b' })).toBe('b');
    expect(storyLine('wo', lines, null)).toBe('a');
    expect(storyLine('other', lines, null)).toBeNull();
  });
  it('clock taps the office refused are listed with the reason (never retried)', () => {
    const r = q({ ...env(), ...roClockDraft('clock_on', 'L1', { lineId: 'l2' }) } as Command, 'rejected', 'That time overlaps another punch of yours.');
    expect(refusedTaps([r])).toEqual([{ id: r.id, at: r.command.at, reason: 'That time overlaps another punch of yours.' }]);
  });
});

describe('inbox overlay', () => {
  const page: InboxPage = {
    unread: 2, nextBefore: null,
    items: [
      { id: 'n1', kind: 'approval', eventType: 'approval.requested', sourceApp: 'projects', severity: 'attention', title: 'CO-4 needs you', body: null, deepLink: '/approvals', jobId: null, jobLabel: null, itemCount: 1, readAt: null, doneAt: null, createdAt: '2026-10-24T10:00:00Z' },
      { id: 'n2', kind: 'info', eventType: null, sourceApp: 'projects', severity: 'info', title: 'Delivery at 10', body: null, deepLink: null, jobId: null, jobLabel: null, itemCount: 1, readAt: null, doneAt: null, createdAt: '2026-10-24T09:00:00Z' },
    ],
  };
  it('marks made on the phone show at once: read lowers the count, done hides the row', () => {
    const r = overlayInbox(page, [q({ ...env(), ...markDraft(['n1'], 'read') } as Command)], 'now');
    expect(r.unread).toBe(1);
    expect(r.items[0]!.readAt).toBe('now');
    const d = overlayInbox(page, [q({ ...env(), ...markDraft(['n2', 'n2'], 'done') } as Command)]);
    expect(d.items.map((i) => i.id)).toEqual(['n1']);
    expect(d.unread).toBe(1);
    expect(overlayInbox(null, []).items).toEqual([]);
  });
});

describe('customer signature', () => {
  it('PNG data URL from the pad, size-capped; what is still missing; absolute file URL only on our origin', () => {
    expect(pngDataUrl('iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(pngDataUrl('not base64!')).toBeNull();
    expect(pngDataUrl('A'.repeat(400_001))).toBeNull();
    expect(signMissing({ consent: false, name: 'P', drawn: false })).toEqual(['consent', 'name', 'signature']);
    expect(signDraft('tok', ' Pat ', 'data:image/png;base64,AA==')).toMatchObject({ typedName: 'Pat', consent: true });
    expect(absoluteUrl('https://p.test/', '/api/sign/public/t/file')).toBe('https://p.test/api/sign/public/t/file');
    expect(absoluteUrl('https://p.test', '//evil.test/x')).toBeNull();
  });
});
