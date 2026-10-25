import { describe, expect, it } from 'vitest';
import type { Command, FlrChangeCommand, FlrSignoffCommand, FormField, FsSellCommand, JsonCommand, ResReceiptCommand, RoLineStoryCommand, WillCall } from './contract';
import { answersForServer, formBlockers, pickedUpHere, pickupDraft, validateForm } from './forms';
import { MemoryQueueStore } from './memoryStore';
import { CommandQueue, type QueuedCommand, type Transport } from './queue';
import { endpointOf, flooringBody, flooringResult, receiptBody, resolveDocs, singleResult, storyBody, wire } from './routing';

let n = 0;
const id = () => `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = '2026-10-25T15:00:00Z';

describe('routing: one queue, five endpoints', () => {
  it('field-service tools and the sale go to fs-commands, installer calls to flooring, receipts and RO stories to their routes, the rest to sync', () => {
    expect(endpointOf({ kind: 'fs.form.submit' })).toBe('fs');
    expect(endpointOf({ kind: 'fs.willcall.pickup' })).toBe('fs');
    expect(endpointOf({ kind: 'flr.signoff' })).toBe('flooring');
    expect(endpointOf({ kind: 'fs.sell' })).toBe('fs');
    expect(endpointOf({ kind: 'fs.paylink.send' })).toBe('fs');
    expect(endpointOf({ kind: 'fs.decline' })).toBe('sync');
    expect(endpointOf({ kind: 'flr.change' })).toBe('flooring');
    expect(endpointOf({ kind: 'res.receipt' })).toBe('receipt');
    expect(endpointOf({ kind: 'ro.line.story' })).toBe('story');
    expect(endpointOf({ kind: 'ro.clock' })).toBe('sync');
    expect(endpointOf({ kind: 'clock' })).toBe('sync');
  });

  it('a sale carries when the customer signed; one queued before that field existed sends its saved time', () => {
    const sale: FsSellCommand = { id: id(), at, kind: 'fs.sell', estimateId: id(), optionIds: [id()], toggles: [], signedName: 'Pat', depositCents: 0, depositMethod: 'none' };
    expect(wire(sale)).toMatchObject({ signedAt: at });
    expect(wire({ ...sale, signedAt: '2026-10-25T14:58:00Z' })).toMatchObject({ signedAt: '2026-10-25T14:58:00Z' });
  });

  it('the on-site change, the receipt and the RO story carry the command id the server dedupes on', () => {
    const ch: FlrChangeCommand = { id: id(), at, kind: 'flr.change', jobId: 'j1', lines: [{ labor_code: 'FLOOR_PREP', qty: 120 }], signerName: 'Pat', docRefs: [], signatureDocumentId: 'doc-s' };
    expect(flooringBody(ch)).toEqual({ op: 'field_change', commandId: ch.id, jobId: 'j1', lines: ch.lines, signerName: 'Pat', signatureDocumentId: 'doc-s', note: null });
    expect(flooringResult(ch, 200, { field_change_id: 'f', change_order_id: 'co', replayed: true })).toMatchObject({ outcome: 'duplicate', serverId: 'co' });
    const rc: ResReceiptCommand = { id: id(), at, kind: 'res.receipt', jobId: 'j1', photoCommandId: 'p1', amountCents: 4299 };
    expect(receiptBody(rc)).toMatchObject({ clientId: rc.id, photoCommandId: 'p1', amountCents: 4299 });
    expect(singleResult(rc, 200, { receiptId: 'r', status: 'CAPTURED', photoPending: true, duplicate: false })).toMatchObject({ outcome: 'applied', serverId: 'r' });
    expect(singleResult(rc, 200, { receiptId: 'r', duplicate: true }).outcome).toBe('duplicate');
    const st: RoLineStoryCommand = { id: id(), at, kind: 'ro.line.story', workOrderId: 'wo', lineId: 'l1', cause: 'Clogged filter' };
    expect(storyBody(st)).toEqual({ commandId: st.id, lineId: 'l1', complaint: null, cause: 'Clogged filter', correction: null });
    expect(singleResult(st, 422, { error: 'You are not on this repair order.', code: 'FORBIDDEN' })).toMatchObject({ outcome: 'rejected', reason: 'You are not on this repair order.' });
    expect(singleResult(st, 503, {}).outcome).toBe('retry');
  });

  it('the sign-off names its photos by command id; the server document ids are filled in at send time and the refs never go on the wire', () => {
    const sig = id();
    const after = id();
    const lost = id();
    const c: FlrSignoffCommand = { id: id(), at, kind: 'flr.signoff', bookingId: id(), signerName: 'Pat', docRefs: [
      { field: 'signatureDocumentId', photoId: sig }, { field: 'photoDocumentIds', photoId: after }, { field: 'photoDocumentIds', photoId: lost },
    ] };
    const row = (pid: string, status: QueuedCommand['status'], serverId?: string): QueuedCommand => ({
      id: pid, seq: 1, kind: 'photo.upload', command: { id: pid, at, kind: 'photo.upload', jobId: id() }, status, attempts: 0, nextAttemptAt: 0, createdAt: 0, updatedAt: 0,
      lastError: null, result: serverId ? { id: pid, kind: 'photo.upload', outcome: 'applied', serverId } : null, fileUri: null, dependsOn: null,
    });
    const r = resolveDocs(c, [row(sig, 'done', 'doc-sig'), row(after, 'done', 'doc-after'), row(lost, 'rejected')]);
    expect(r).toMatchObject({ signatureDocumentId: 'doc-sig', photoDocumentIds: ['doc-after'] });
    expect('docRefs' in wire(r)).toBe(false);
    expect(flooringBody(r)).toEqual({ op: 'signoff', bookingId: c.bookingId, signerName: 'Pat', signatureDocumentId: 'doc-sig', photoDocumentIds: ['doc-after'], leftover: [], notes: null });
    expect(flooringBody({ ...r, leftover: [{ roll_id: 'roll-1', len_in: 36 }] })).toMatchObject({ leftover: [{ roll_id: 'roll-1', len_in: 36 }] });
  });

  it('flooring answers: 200 applied; a closed booking on a re-send is already done; 5xx retries; other refusals carry the reason', () => {
    const so: FlrSignoffCommand = { id: id(), at, kind: 'flr.signoff', bookingId: id(), signerName: 'Pat', docRefs: [] };
    expect(flooringResult(so, 200, { signoff_id: 's1', booking_id: 'b' })).toMatchObject({ outcome: 'applied', serverId: 's1' });
    expect(flooringResult(so, 422, { error: 'PM_INVALID: the booking is done', code: 'VALIDATION' }).outcome).toBe('duplicate');
    expect(flooringResult(so, 503, {}).outcome).toBe('retry');
    expect(flooringResult(so, 422, { error: 'The customer’s name is required' })).toMatchObject({ outcome: 'rejected', reason: 'The customer’s name is required' });
    expect(flooringBody({ id: id(), at, kind: 'flr.omw', bookingId: 'b1' })).toEqual({ op: 'on_my_way', bookingId: 'b1' });
  });
});

describe('the queue waits for every photo a command names', () => {
  it('sign-off is sent only after its signature and after photos, with their document ids', async () => {
    const store = new MemoryQueueStore();
    const q = new CommandQueue(store, { now: () => 1_000_000 });
    const sent: JsonCommand[] = [];
    const t: Transport = {
      async sendBatch(cs) { sent.push(...cs); return cs.map((c) => ({ id: c.id, kind: c.kind, outcome: 'applied' as const })); },
      async sendPhoto(c) { return { id: c.id, kind: c.kind, outcome: 'applied', serverId: `doc-${c.id.slice(-2)}` }; },
    };
    const p1 = id();
    const p2 = id();
    await q.enqueue({ id: p1, at, kind: 'photo.upload', jobId: id() }, { fileUri: 'file:///photos/a.png' });
    await q.enqueue({ id: p2, at, kind: 'photo.upload', jobId: id() }, { fileUri: 'file:///photos/b.jpg' });
    const so: Command = { id: id(), at, kind: 'flr.signoff', bookingId: id(), signerName: 'Pat', docRefs: [{ field: 'signatureDocumentId', photoId: p1 }, { field: 'photoDocumentIds', photoId: p2 }] };
    await q.enqueue(so);
    const r = await q.flush(t);
    expect(r.applied).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ signatureDocumentId: `doc-${p1.slice(-2)}`, photoDocumentIds: [`doc-${p2.slice(-2)}`] });
    // the stored command is unchanged (the ids are filled in on each send)
    expect((await store.all()).find((c) => c.id === so.id)?.command).not.toHaveProperty('signatureDocumentId');
  });
});

describe('checklists with readings, offline', () => {
  const fields: FormField[] = [
    { key: 'static', label: 'Static pressure', type: 'reading', unit: 'in. w.c.', min: 0.1, max: 0.8, required: true, red_tag_above: 1.2 },
    { key: 'co', label: 'CO', type: 'reading', unit: 'ppm', max: 35, red_tag_above: 100 },
    { key: 'hx', label: 'Heat exchanger', type: 'pass_fail', required: true, red_tag_on_fail: true },
    { key: 'filter', label: 'Filter size', type: 'choice', options: ['16x25', '20x25'] },
    { key: 'clean', label: 'Cleaned', type: 'check' },
  ];
  it('same rules as the server: missing, out of range, red tag', () => {
    expect(validateForm(fields, {}).missing).toEqual(['Static pressure', 'Heat exchanger']);
    const c = validateForm(fields, { static: '0,9', co: '140', hx: 'pass', filter: '14x20' });
    expect(c.outOfRange.map((o) => o.key)).toEqual(['static', 'co']);
    expect(c.redTag).toBe(true);
    expect(c.redTagReason).toBe('CO reading 140 ppm');
    expect(c.missing).toEqual(['Filter size']);
    expect(validateForm(fields, { static: '0.5', hx: 'FAIL' }).redTagReason).toBe('Heat exchanger failed');
  });
  it('readings go as numbers; a red tag needs the customer’s signature and a reason', () => {
    expect(answersForServer(fields, { static: '0,5', clean: true, filter: '' })).toEqual({ static: 0.5, clean: true });
    const red = validateForm(fields, { static: '0.5', hx: 'FAIL' });
    expect(formBlockers(red, { requiresSignature: false, signedName: '', drawn: false, redTagReason: '' })).toEqual(['signature', 'redTag']);
    expect(formBlockers(validateForm(fields, { static: '0.5', hx: 'PASS' }), { requiresSignature: false, signedName: '', drawn: false, redTagReason: '' })).toEqual([]);
  });
});

describe('will-call pickup', () => {
  const w: WillCall = {
    commitment_id: 'po1', number: 'PO-77', title: 'Furnace + coil', status: 'APPROVED', job_id: 'j', vendor: 'Ferguson', pickup_code: '482913', expected_on: null, note: null, ready: true,
    lines: [{ line_id: 'l1', description: 'Furnace', qty: 1, received_qty: 0 }, { line_id: 'l2', description: 'Filters', qty: 6, received_qty: 2 }],
  };
  it('picks up what is still owed unless the tech changed it; serials split on spaces / commas', () => {
    expect(pickupDraft(w, {}, { l1: 'AB123, CD456' })).toEqual({ kind: 'fs.willcall.pickup', commitmentId: 'po1', pickupCode: '482913', lines: [{ lineId: 'l1', qty: 1, serials: ['AB123', 'CD456'] }, { lineId: 'l2', qty: 4, serials: [] }] });
    expect(pickupDraft(w, { l2: '0' }, {})?.lines).toEqual([{ lineId: 'l1', qty: 1, serials: [] }]);
    expect(pickupDraft({ ...w, pickup_code: null }, {}, {})).toBeNull();
    expect([...pickedUpHere([{ command: { kind: 'fs.willcall.pickup', commitmentId: 'po1' } as Command, status: 'pending' }])]).toEqual(['po1']);
  });
});
