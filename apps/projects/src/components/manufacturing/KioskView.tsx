'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ButtonRow, Field, InlineNotice, Input, Select, Status, api, count } from '@meritbooks/merit-ui';
import { KioskQueue, type KioskEvent, type KioskResult, type KioskStorage } from '@/lib/mfg/kiosk-queue';
import { Failure } from '@/components/ops/common/bits';
import { useBoard } from '@/components/dealer/common/depth';

interface Alerts { alerts: { badges: Array<{ employee_id: string; name: string | null; wrong_pins_24h: number }>; locked_stations: number } }

interface Op { operation_id: string; work_order_id: string; work_order: string; summary: string; job: string; seq: number; operation: string; work_center: string; status: string; assigned_to_me: boolean; qty: number | null }
interface Session { session_token: string; expires_at: string; employee_id: string; name: string; open: Array<{ punch_id: string; operation_id: string | null; indirect_code: string | null; started_at: string; work_order: string | null; operation: string | null }>; operations: Op[] }

const IDLE_MS = 90_000;
const REMAKE = [['MACHINING', 'Machining'], ['MATERIAL_DEFECT', 'Material defect'], ['ASSEMBLY', 'Assembly'], ['FINISH', 'Finish'], ['DAMAGE_SHOP', 'Damaged in shop'], ['MEASURE', 'Wrong measure'], ['DESIGN', 'Design'], ['MISSING', 'Missing part'], ['OTHER', 'Other']] as const;

function storage(): KioskStorage | null {
  try {
    const s = window.localStorage;
    s.setItem('merit.kiosk.probe', '1');
    s.removeItem('merit.kiosk.probe');
    return s;
  } catch {
    return null;
  }
}

/**
 * The shop-floor station: scan a badge (and PIN), start, pause or finish an operation with good and
 * scrap counts, or ask for a remake. Taps queue on the tablet when the network drops and replay in
 * order; the database dedupes, so nothing double-counts. Signs the worker out after 90 seconds idle.
 */
export function KioskView({ companyId }: { companyId: string }) {
  const queue = useMemo(() => (typeof window === 'undefined' ? null : new KioskQueue(companyId, storage())), [companyId]);
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);
  const [badge, setBadge] = useState('');
  const [pin, setPin] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finish, setFinish] = useState<{ op: Op; good: string; scrap: string } | null>(null);
  const [remake, setRemake] = useState<{ op: Op; label: string; reason: string } | null>(null);
  const [openOps, setOpenOps] = useState<Set<string>>(new Set());
  const lead = useBoard<Alerts>(`/api/mfg/kiosk?company=${companyId}`);
  const badgeRef = useRef<HTMLInputElement>(null);
  const idle = useRef<number | null>(null);

  const signOut = useCallback(() => { setSession(null); setFinish(null); setRemake(null); setPin(''); setBadge(''); setTimeout(() => badgeRef.current?.focus(), 0); }, []);
  const touch = useCallback(() => {
    if (idle.current) window.clearTimeout(idle.current);
    idle.current = window.setTimeout(signOut, IDLE_MS);
  }, [signOut]);

  const flush = useCallback(async () => {
    if (!queue) return;
    const out = await queue.flush(async (events: KioskEvent[]) => {
      const r = await api.post<{ results: KioskResult[] }>('/api/mfg/kiosk', { op: 'events', companyId, events });
      if (r.error) return r.status === 0 || r.status >= 500 ? null : events.map(() => ({ ok: false, error: r.error!.error }));
      return r.data?.results ?? [];
    });
    setOffline(out.offline);
    setPending(queue.pending.length);
    const bad = out.results.filter((x) => !x.ok);
    if (bad.length) setErr(String(bad[bad.length - 1]!.error ?? 'A tap was refused.').replace(/^PM_[A-Z_]+:\s*/, ''));
  }, [companyId, queue]);

  useEffect(() => {
    if (!queue) return;
    setPending(queue.pending.length);
    void flush();
    const t = window.setInterval(() => void flush(), 15_000);
    const on = () => void flush();
    window.addEventListener('online', on);
    return () => { window.clearInterval(t); window.removeEventListener('online', on); };
  }, [flush, queue]);

  const identify = async () => {
    setErr(null);
    const r = await api.post<Session>('/api/mfg/kiosk', { op: 'identify', companyId, badge: badge.trim(), pin: pin.trim() || null });
    if (r.error) { setErr(r.error.error); return; }
    setSession(r.data);
    setOpenOps(new Set((r.data?.open ?? []).map((p) => p.operation_id).filter((x): x is string => !!x)));
    touch();
  };

  const tap = async (e: Omit<KioskEvent, 'client_event_id' | 'at' | 'session_token'>, done: string) => {
    if (!session || !queue) return;
    touch();
    setErr(null);
    queue.push({ ...e, session_token: session.session_token });
    if (e.operation_id && (e.action === 'START' || e.action === 'PAUSE' || e.action === 'COMPLETE')) {
      const id = e.operation_id;
      setOpenOps((prev) => { const n = new Set(prev); if (e.action === 'START') n.add(id); else n.delete(id); return n; });
    }
    setPending(queue.pending.length);
    setNotice(done);
    await flush();
  };

  const openOn = (op: Op) => openOps.has(op.operation_id);

  if (!session) {
    return (
      <div className="stack" style={{ maxWidth: 520 }}>
        {offline && <InlineNotice tone="warn" title="The station is offline.">Scanning a badge needs the network. {pending ? `${count(pending)} taps are waiting to send.` : ''}</InlineNotice>}
        {err && <Failure title="Not signed in." text={err} />}
        {(lead.data?.alerts.badges.length ?? 0) > 0 && (
          <InlineNotice tone="warn" title="Shop lead: repeated wrong PINs.">
            {lead.data!.alerts.badges.map((x) => `${x.name ?? 'A worker'} (${x.wrong_pins_24h} in 24 hours)`).join(' · ')}. Check with them; someone may be trying their badge.
          </InlineNotice>
        )}
        <Field label="Scan your badge"><Input ref={badgeRef} autoFocus autoComplete="off" value={badge} onChange={(e) => setBadge(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (document.getElementById('kiosk-pin') as HTMLInputElement | null)?.focus(); } }} style={{ fontSize: 24, height: 56 }} /></Field>
        <Field label="PIN (if your shop uses one)"><Input id="kiosk-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void identify(); } }} style={{ fontSize: 24, height: 56 }} /></Field>
        <Button variant="primary" size="lg" disabled={!badge.trim()} onClick={() => void identify()}>Start</Button>
        <p className="t-cap">{pending ? `${count(pending)} taps waiting to send.` : 'All taps sent.'}</p>
      </div>
    );
  }

  return (
    <div className="stack" onPointerDown={touch} onKeyDown={touch}>
      <div className="ops-toolbar">
        <h2 className="t-section">{session.name}</h2>
        <span className="sp" />
        <Status kind={offline ? 'risk' : 'ready'} pip={offline ? 'risk' : 'ready'}>{offline ? `Offline · ${count(pending)} waiting` : pending ? `${count(pending)} sending` : 'Online'}</Status>
        <Button size="lg" onClick={signOut}>Done</Button>
      </div>
      {notice && <InlineNotice tone="info" title={notice} />}
      {err && <Failure text={err} />}
      {finish && (
        <div className="surface stack">
          <h3 className="t-section">Finish {finish.op.operation} · {finish.op.work_order}</h3>
          <ButtonRow>
            <Field label="Good"><Input inputMode="numeric" value={finish.good} onChange={(e) => setFinish({ ...finish, good: e.target.value })} style={{ fontSize: 24, width: 120, height: 56 }} /></Field>
            <Field label="Scrap"><Input inputMode="numeric" value={finish.scrap} onChange={(e) => setFinish({ ...finish, scrap: e.target.value })} style={{ fontSize: 24, width: 120, height: 56 }} /></Field>
          </ButtonRow>
          <ButtonRow>
            <Button variant="primary" size="lg" onClick={() => { const f = finish; setFinish(null); void tap({ action: 'COMPLETE', operation_id: f.op.operation_id, good_qty: Number(f.good) || 0, scrap_qty: Number(f.scrap) || 0 }, `${f.op.operation} finished`); }}>Finish operation</Button>
            <Button size="lg" variant="quiet" onClick={() => setFinish(null)}>Back</Button>
          </ButtonRow>
        </div>
      )}
      {remake && (
        <div className="surface stack">
          <h3 className="t-section">Remake a part · {remake.op.work_order}</h3>
          <Field label="Part label"><Input value={remake.label} onChange={(e) => setRemake({ ...remake, label: e.target.value })} style={{ fontSize: 20, height: 48 }} /></Field>
          <Field label="Why"><Select value={remake.reason} onChange={(e) => setRemake({ ...remake, reason: e.target.value })}>{REMAKE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <ButtonRow>
            <Button variant="primary" size="lg" disabled={!remake.label.trim()} onClick={() => { const r = remake; setRemake(null); void tap({ action: 'REMAKE', operation_id: r.op.operation_id, part_label: r.label.trim(), remake_reason: r.reason, qty: 1 }, 'Remake requested'); }}>Ask for the remake</Button>
            <Button size="lg" variant="quiet" onClick={() => setRemake(null)}>Back</Button>
          </ButtonRow>
        </div>
      )}
      {session.operations.length === 0 ? <InlineNotice tone="info" title="No operations ready at this station.">Released orders show here when their operations are ready.</InlineNotice> : (
        <ul className="ops-centers" aria-label="Operations">
          {session.operations.map((op) => {
            const on = openOn(op);
            return (
              <li key={op.operation_id}>
                <div><b>{op.work_order}</b> · {op.operation} <span className="t-cap">· {op.work_center} · {op.job}{op.assigned_to_me ? ' · assigned to you' : ''}</span><div className="t-cap">{op.summary}</div></div>
                <ButtonRow>
                  {!on && <Button variant="primary" size="lg" onClick={() => void tap({ action: 'START', operation_id: op.operation_id }, `Started ${op.operation}`)}>Start</Button>}
                  {on && <Button size="lg" onClick={() => void tap({ action: 'PAUSE', operation_id: op.operation_id, reason: 'Paused at station' }, `Paused ${op.operation}`)}>Pause</Button>}
                  {on && <Button variant="primary" size="lg" onClick={() => setFinish({ op, good: String(op.qty ?? ''), scrap: '0' })}>Finish</Button>}
                  <Button variant="quiet" size="lg" onClick={() => setRemake({ op, label: '', reason: 'MACHINING' })}>Remake</Button>
                </ButtonRow>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
