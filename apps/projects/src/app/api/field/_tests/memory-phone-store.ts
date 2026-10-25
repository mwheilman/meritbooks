/** In-memory PhoneStore for the v2 phone command tests: the same contract as phone-store.ts, no database. */
import type { ApprovalSnapshot, FsEstimateRef, FsSellArgs, KioskEventResult, KioskEventRow, OpenTechPunch, PhoneStore, RoLineRef, WorkOrderRef } from '../_lib/phone-store-types';

export interface PhoneState {
  approvals: Map<string, ApprovalSnapshot>;
  acted: Array<{ id: string; decision: string; reason: string | null }>;
  marks: Array<{ ids: string[]; state: string }>;
  unread: Set<string>;
  kioskLedger: Map<string, KioskEventResult>;
  kioskSessions: Set<string>;
  lines: Map<string, RoLineRef>;
  workOrders: Map<string, WorkOrderRef>;
  open: Map<string, OpenTechPunch>;
  taps: Array<{ op: string; at: string }>;
  tokens: Map<string, 'open' | 'signed' | 'expired' | 'down'>;
  signatures: Array<{ token: string; typedName: string; ip: string | null }>;
  estimates: Map<string, FsEstimateRef>;
  toggles: Array<{ itemId: string; selected: boolean }>;
  sold: FsSellArgs[];
  declined: Array<{ id: string; reason: string }>;
}

export function phoneState(): PhoneState {
  return {
    approvals: new Map(), acted: [], marks: [], unread: new Set(), kioskLedger: new Map(), kioskSessions: new Set(), lines: new Map(), workOrders: new Map(),
    open: new Map(), taps: [], tokens: new Map(), signatures: [], estimates: new Map(), toggles: [], sold: [], declined: [],
  };
}

export function memoryPhoneStore(s: PhoneState): PhoneStore {
  return {
    async approval(id) {
      return s.approvals.get(id) ?? null;
    },
    async actApproval(id, decision, o) {
      const r = s.approvals.get(id)!;
      s.acted.push({ id, decision, reason: o.reason });
      r.history.push({ decision: decision === 'approve' ? 'APPROVE' : 'REJECT', round: r.round, step: r.step, actor: 'Dana Ruiz', channel: 'phone', at: new Date().toISOString() });
      if (decision === 'reject') r.status = 'REJECTED';
      else r.step += 1;
      return { status: decision === 'reject' ? 'rejected' : 'pending', waitingOn: decision === 'reject' ? null : 'the owner' };
    },
    async markNotifications(ids, state) {
      s.marks.push({ ids: [...ids], state });
      let n = 0;
      for (const id of ids) if (s.unread.delete(id)) n += 1;
      return n;
    },
    async kioskEvents(_companyId, events: KioskEventRow[]) {
      return events.map((e) => {
        const prior = s.kioskLedger.get(e.client_event_id);
        if (prior) return { ...prior, replay: true };
        const r: KioskEventResult = s.kioskSessions.has(e.session_token) ? { ok: true } : { ok: false, error: 'PM_KIOSK_SESSION: scan the badge again' };
        s.kioskLedger.set(e.client_event_id, r);
        return r;
      });
    },
    async roLine(id) {
      return s.lines.get(id) ?? null;
    },
    async workOrder(id) {
      return s.workOrders.get(id) ?? null;
    },
    async roOpenPunch(companyId) {
      return s.open.get(companyId) ?? null;
    },
    async roClockOn(lineId, at) {
      const l = s.lines.get(lineId)!;
      s.taps.push({ op: 'on', at });
      s.open.set(l.companyId, { lineId, kind: 'LINE', indirectKind: null, startedAt: at });
    },
    async roClockOff(companyId, at) {
      s.taps.push({ op: 'off', at });
      const had = s.open.delete(companyId);
      return { open: had };
    },
    async roIndirect(companyId, kind, at) {
      s.taps.push({ op: kind, at });
      s.open.set(companyId, { lineId: null, kind, indirectKind: kind, startedAt: at });
    },
    async esignSign(token, input, meta) {
      const t = s.tokens.get(token);
      if (!t) return { ok: false, reason: 'invalid' };
      if (t === 'down') return { ok: false, reason: 'unavailable' };
      if (t === 'expired') return { ok: false, reason: 'expired' };
      if (t === 'signed') return { ok: false, reason: 'used' };
      s.tokens.set(token, 'signed');
      s.signatures.push({ token, typedName: input.typedName, ip: meta.ip });
      return { ok: true, reason: null };
    },
    async fsEstimate(id) {
      return s.estimates.get(id) ?? null;
    },
    async fsToggle(itemId, selected) {
      s.toggles.push({ itemId, selected });
    },
    async fsSell(a) {
      const e = s.estimates.get(a.estimateId)!;
      e.status = 'SOLD';
      e.soldOptionIds = [...a.optionIds];
      s.sold.push(a);
      return { lines: 3, agreementId: a.joinTemplateId ? 'agreement-1' : null, depositRequestId: a.requestDeposit ? 'deposit-1' : null, memberPricing: false };
    },
    async fsDecline(id, reason) {
      s.estimates.get(id)!.status = 'DECLINED';
      s.declined.push({ id, reason });
    },
  };
}
