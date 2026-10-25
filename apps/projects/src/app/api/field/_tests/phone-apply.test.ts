import { beforeEach, describe, expect, it } from 'vitest';
import { buildAccess } from '@/lib/access/derive';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import type { AccessRow, PersonaKey } from '@/lib/access/types';
import { applyBatch, applyRaw, type FieldCtx } from '../_lib/apply';
import { storyBody } from '../_lib/phone-apply';
import { isPhoneKind } from '../_lib/phone-contract';
import { memoryState, memoryStore, type MemoryState } from './memory-store';
import { memoryPhoneStore, phoneState, type PhoneState } from './memory-phone-store';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const REQ = '66666666-6666-4666-8666-666666666666';
const LINE = '77777777-7777-4777-8777-777777777777';
const WO = '88888888-8888-4888-8888-888888888888';
const EST = '99999999-9999-4999-8999-999999999999';
const OPT = 'aaaaaaaa-1111-4111-8111-111111111111';
const OPT2 = 'aaaaaaaa-2222-4222-8222-222222222222';
const ITEM = 'aaaaaaaa-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-24T22:00:00Z');
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let n = 0;
const cid = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = (minAgo = 1) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();

function rowsFor(persona: PersonaKey, loc: string): AccessRow[] {
  const byCap = new Map<string, string[]>();
  for (const g of PERSONA_TEMPLATE_GRANTS[persona]) {
    const [cap, action] = g.split(':') as [string, string];
    byCap.set(cap, [...(byCap.get(cap) ?? []), action]);
  }
  return [...byCap].map(([capability, actions]) => ({ location_id: loc, capability, actions, role_key: persona, role_name: null }));
}

let s: MemoryState;
let p: PhoneState;
function ctx(rows: AccessRow[] = rowsFor('projects_labor', L1), withPhone = true): FieldCtx {
  return {
    store: memoryStore(s), access: buildAccess(rows), userId: 'user_andre', orgId: 'org-1', companyName: () => 'Heartland', now: NOW,
    defaultTz: 'America/Chicago', ...(withPhone ? { phone: memoryPhoneStore(p) } : {}), meta: { ip: '203.0.113.9', userAgent: 'MeritWorkforce/0.2' },
  };
}

beforeEach(() => {
  s = memoryState();
  p = phoneState();
  s.jobs.set(JOB, { jobId: JOB, companyId: L1, siteLat: null, siteLng: null });
});

describe('v2 kinds ride the same sync batch', () => {
  it('knows its kinds and refuses them politely when the server has no phone store', async () => {
    expect(isPhoneKind('approval.decide')).toBe(true);
    expect(isPhoneKind('clock')).toBe(false);
    expect(isPhoneKind('__proto__')).toBe(false);
    const r = await applyRaw(ctx(undefined, false), { id: cid(), kind: 'notification.mark', at: at(), ids: [cid()], state: 'read' });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'NOT_AVAILABLE' });
  });

  it('validation errors come back as plain reasons, never throws', async () => {
    const r = await applyRaw(ctx(), { id: cid(), kind: 'approval.decide', at: at(), requestId: REQ, decision: 'reject', round: 1, step: 1 });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'VALIDATION' });
    expect(r.reason).toMatch(/why/i);
  });
});

describe('approval.decide', () => {
  beforeEach(() => {
    p.approvals.set(REQ, { id: REQ, status: 'PENDING', round: 1, step: 1, canAct: true, title: 'CO-004 Add egress window', history: [] });
  });

  it('approves on the phone channel; a re-send after the step moved on is a duplicate, not a second approval', async () => {
    const cmd = { id: cid(), kind: 'approval.decide', at: at(), requestId: REQ, decision: 'approve', round: 1, step: 1 };
    const a = await applyRaw(ctx(), cmd);
    expect(a).toMatchObject({ outcome: 'applied', serverId: REQ });
    expect(a.note).toMatch(/owner/);
    const b = await applyRaw(ctx(), cmd);
    expect(b.outcome).toBe('duplicate');
    expect(p.acted).toHaveLength(1);
  });

  it('someone else deciding the other way first: my answer is refused with who did it', async () => {
    p.approvals.get(REQ)!.history.push({ decision: 'REJECT', round: 1, step: 1, actor: 'Sam Lee', channel: 'web', at: at(5) });
    p.approvals.get(REQ)!.status = 'REJECTED';
    const r = await applyRaw(ctx(), { id: cid(), kind: 'approval.decide', at: at(), requestId: REQ, decision: 'approve', round: 1, step: 1 });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'APPROVAL_DECIDED' });
    expect(r.reason).toMatch(/Sam Lee/);
  });

  it('not my step, or changed since the phone loaded it, is refused; sending back needs a reason and records it', async () => {
    p.approvals.get(REQ)!.canAct = false;
    expect((await applyRaw(ctx(), { id: cid(), kind: 'approval.decide', at: at(), requestId: REQ, decision: 'approve', round: 1, step: 1 })).code).toBe('NOT_YOUR_STEP');
    p.approvals.get(REQ)!.canAct = true;
    expect((await applyRaw(ctx(), { id: cid(), kind: 'approval.decide', at: at(), requestId: REQ, decision: 'approve', round: 2, step: 1 })).code).toBe('APPROVAL_MOVED');
    const r = await applyRaw(ctx(), { id: cid(), kind: 'approval.decide', at: at(), requestId: REQ, decision: 'reject', reason: 'Wrong window size', round: 1, step: 1 });
    expect(r.outcome).toBe('applied');
    expect(p.acted[0]).toMatchObject({ decision: 'reject', reason: 'Wrong window size' });
  });

  it('an approval the caller cannot see is not found', async () => {
    const r = await applyRaw(ctx(), { id: cid(), kind: 'approval.decide', at: at(), requestId: cid(), decision: 'approve', round: 1, step: 1 });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'NOT_FOUND' });
  });
});

describe('notification.mark', () => {
  it('marks my rows; marking again changes nothing (duplicate)', async () => {
    const id = cid();
    p.unread.add(id);
    const cmd = { id: cid(), kind: 'notification.mark', at: at(), ids: [id, id], state: 'read' };
    expect((await applyRaw(ctx(), cmd)).outcome).toBe('applied');
    expect(p.marks[0]!.ids).toEqual([id]);
    expect((await applyRaw(ctx(), { ...cmd, id: cid() })).outcome).toBe('duplicate');
  });
});

describe('kiosk.event', () => {
  const station: AccessRow[] = [{ location_id: L1, capability: 'projects.production', actions: ['view', 'edit'], role_key: 'shop_lead', role_name: null }];
  const SESSION = 'sess_0123456789abcdef0123';

  it('needs production:edit at THAT company (the station seat)', async () => {
    const r = await applyRaw(ctx(rowsFor('projects_labor', L1)), { id: cid(), kind: 'kiosk.event', at: at(), companyId: L1, sessionToken: SESSION, action: 'START', operationId: cid() });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'FORBIDDEN' });
    const other = await applyRaw(ctx(station), { id: cid(), kind: 'kiosk.event', at: at(), companyId: L2, sessionToken: SESSION, action: 'START', operationId: cid() });
    expect(other.code).toBe('FORBIDDEN');
  });

  it('the command id is the ledger key: a replay answers duplicate; an ended badge session is refused in words', async () => {
    p.kioskSessions.add(SESSION);
    const cmd = { id: cid(), kind: 'kiosk.event', at: at(30), companyId: L1, sessionToken: SESSION, action: 'COMPLETE', operationId: cid(), goodQty: 12, scrapQty: 1 };
    expect((await applyRaw(ctx(station), cmd)).outcome).toBe('applied');
    expect((await applyRaw(ctx(station), cmd)).outcome).toBe('duplicate');
    expect(p.kioskLedger.size).toBe(1);
    const late = await applyRaw(ctx(station), { ...cmd, id: cid(), sessionToken: 'sess_expired_0000000000' });
    expect(late.outcome).toBe('rejected');
    expect(late.reason).toMatch(/scan your badge/i);
  });
});

describe('ro.clock and ro.story', () => {
  beforeEach(() => {
    p.lines.set(LINE, { lineId: LINE, workOrderId: WO, jobId: JOB, companyId: L1, number: 'RO-2026-00042' });
    p.workOrders.set(WO, { id: WO, jobId: JOB, companyId: L1, number: 'RO-2026-00042', kind: 'REPAIR_ORDER' });
  });

  it('clock on a line once; a re-send is a duplicate; clock off twice is a duplicate the second time', async () => {
    const on = { id: cid(), kind: 'ro.clock', at: at(), op: 'clock_on', companyId: L1, lineId: LINE };
    expect((await applyRaw(ctx(), on)).outcome).toBe('applied');
    expect((await applyRaw(ctx(), on)).outcome).toBe('duplicate');
    const off = { id: cid(), kind: 'ro.clock', at: at(), op: 'clock_off', companyId: L1 };
    expect((await applyRaw(ctx(), off)).outcome).toBe('applied');
    expect((await applyRaw(ctx(), off)).outcome).toBe('duplicate');
  });

  it('an offline tap keeps the time it was tapped (p_at / p_end_at), not the time it arrived', async () => {
    const r = await applyRaw(ctx(), { id: cid(), kind: 'ro.clock', at: at(45), offline: true, tz: 'America/Chicago', op: 'indirect', companyId: L1, indirectKind: 'WAITING_PARTS' });
    expect(r.outcome).toBe('applied');
    expect(p.taps).toEqual([{ op: 'WAITING_PARTS', at: at(45) }]);
    await applyRaw(ctx(), { id: cid(), kind: 'ro.clock', at: at(5), op: 'clock_off', companyId: L1 });
    expect(p.taps[1]).toEqual({ op: 'off', at: at(5) });
  });

  it('the database’s clock refusals (stale, ahead, overlap) are final, never retried', async () => {
    const { HttpError } = await import('@/lib/api-errors');
    const store = memoryPhoneStore(p);
    store.roClockOn = async () => { throw new HttpError(409, 'That time overlaps another punch of yours.', 'PM_PUNCH_OVERLAP'); };
    const r = await applyRaw({ ...ctx(), phone: store }, { id: cid(), kind: 'ro.clock', at: at(), op: 'clock_on', companyId: L1, lineId: LINE });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'PM_PUNCH_OVERLAP' });
  });

  it('no time grant at the store → refused', async () => {
    const r = await applyRaw(ctx([]), { id: cid(), kind: 'ro.clock', at: at(), op: 'clock_on', companyId: L1, lineId: LINE });
    expect(r).toMatchObject({ outcome: 'rejected', code: 'FORBIDDEN' });
  });

  it('the 3C story becomes a log on the RO’s job, once', async () => {
    const cmd = { id: cid(), kind: 'ro.story', at: at(), workOrderId: WO, lineId: LINE, complaint: 'Mower stalls under load', cause: 'Clogged fuel filter', correction: 'Replaced filter, tested 20 min' };
    const a = await applyRaw(ctx(), cmd);
    expect(a.outcome).toBe('applied');
    const log = [...s.logs.values()][0]!;
    expect(log.kind).toBe('VISIT');
    expect(log.body).toContain('Cause: Clogged fuel filter');
    expect(log.ext._ro_story).toMatchObject({ work_order_id: WO, line_id: LINE });
    expect((await applyRaw(ctx(), cmd)).outcome).toBe('duplicate');
    expect(s.logs.size).toBe(1);
    expect(storyBody(null, { complaint: 'x' })).toBe('Tech story\nComplaint: x');
  });
});

describe('esign.sign', () => {
  it('signs once with the phone’s IP; the re-send is a duplicate; outages retry; expired is refused', async () => {
    p.tokens.set(TOKEN, 'open');
    const cmd = { id: cid(), kind: 'esign.sign', at: at(), token: TOKEN, typedName: 'Pat Homeowner', signaturePng: PNG, consent: true };
    expect((await applyRaw(ctx(), cmd)).outcome).toBe('applied');
    expect(p.signatures[0]).toMatchObject({ typedName: 'Pat Homeowner', ip: '203.0.113.9' });
    expect((await applyRaw(ctx(), cmd)).outcome).toBe('duplicate');
    p.tokens.set('tok_down_000000000000000000', 'down');
    expect((await applyRaw(ctx(), { ...cmd, id: cid(), token: 'tok_down_000000000000000000' })).outcome).toBe('retry');
    p.tokens.set('tok_late_000000000000000000', 'expired');
    const late = await applyRaw(ctx(), { ...cmd, id: cid(), token: 'tok_late_000000000000000000' });
    expect(late.outcome).toBe('rejected');
    expect(late.reason).toMatch(/expired/i);
  });

  it('consent and a drawn signature are required', async () => {
    const r = await applyRaw(ctx(), { id: cid(), kind: 'esign.sign', at: at(), token: TOKEN, typedName: 'Pat', signaturePng: PNG, consent: false });
    expect(r.code).toBe('VALIDATION');
  });
});

describe('fs.sell and fs.decline', () => {
  beforeEach(() => {
    p.estimates.set(EST, { id: EST, companyId: L1, jobId: JOB, workOrderId: WO, number: 'EST-2026-00007', status: 'PRESENTED', soldOptionIds: [] });
  });

  it('sells with add-on toggles, the drawn signature document and a pay-link deposit; a re-send is a duplicate', async () => {
    const sigId = cid();
    s.documents.set('doc-sig', { id: 'doc-sig', storage_path: `org-1/projects/field/${JOB}/${sigId}.png`, file_name: 's.png', mime_type: 'image/png', size_bytes: 10, entity_type: 'pm.projects', entity_id: JOB, notes: null });
    const cmd = {
      id: cid(), kind: 'fs.sell', at: at(), estimateId: EST, optionIds: [OPT2], toggles: [{ itemId: ITEM, selected: true }], signedName: 'Pat Homeowner',
      signaturePhotoId: sigId, financingPlanId: null, joinTemplateId: cid(), depositCents: 50000, depositMethod: 'link',
    };
    const r = await applyRaw(ctx(), cmd);
    expect(r.outcome).toBe('applied');
    expect(p.toggles).toEqual([{ itemId: ITEM, selected: true }]);
    expect(p.sold[0]).toMatchObject({ optionIds: [OPT2], signatureDocumentId: 'doc-sig', requestDeposit: true, depositCents: 50000 });
    expect(r.note).toMatch(/pay link/);
    expect((await applyRaw(ctx(), cmd)).outcome).toBe('duplicate');
    expect(p.sold).toHaveLength(1);
  });

  it('a check deposit records the reference; no deposit sends zero; a missing signature photo is noted, not fatal', async () => {
    const r = await applyRaw(ctx(), { id: cid(), kind: 'fs.sell', at: at(), estimateId: EST, optionIds: [OPT], signedName: 'Pat', signaturePhotoId: cid(), depositCents: 20000, depositMethod: 'check', depositRef: '#1042' });
    expect(r.outcome).toBe('applied');
    expect(p.sold[0]).toMatchObject({ depositRef: 'Check #1042', requestDeposit: false, signatureDocumentId: null });
    expect(r.note).toMatch(/typed name/);
  });

  it('sold with a different choice → refused; decline after sold → refused; decline is idempotent', async () => {
    p.estimates.get(EST)!.status = 'SOLD';
    p.estimates.get(EST)!.soldOptionIds = [OPT];
    expect((await applyRaw(ctx(), { id: cid(), kind: 'fs.sell', at: at(), estimateId: EST, optionIds: [OPT2], signedName: 'Pat' })).code).toBe('ESTIMATE_SOLD');
    expect((await applyRaw(ctx(), { id: cid(), kind: 'fs.decline', at: at(), estimateId: EST, reason: 'Too much' })).code).toBe('ESTIMATE_SOLD');
    p.estimates.get(EST)!.status = 'PRESENTED';
    const d = { id: cid(), kind: 'fs.decline', at: at(), estimateId: EST, reason: 'Getting other quotes' };
    expect((await applyRaw(ctx(), d)).outcome).toBe('applied');
    expect((await applyRaw(ctx(), d)).outcome).toBe('duplicate');
  });

  it('a batch keeps order: the signature photo id resolves for the sale after it', async () => {
    const out = await applyBatch(ctx(), [
      { id: cid(), kind: 'notification.mark', at: at(), ids: [cid()], state: 'done' },
      { id: cid(), kind: 'fs.sell', at: at(), estimateId: EST, optionIds: [OPT], signedName: 'Pat' },
    ]);
    expect(out.map((r) => r.outcome)).toEqual(['duplicate', 'applied']);
  });
});
