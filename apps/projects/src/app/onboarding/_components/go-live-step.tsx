'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { Button, Check, InlineNotice, PageHead, Tag, WidgetState, count, toast } from '@meritbooks/merit-ui';
import type { CompanyBrief } from '@/lib/onboarding/types';
import type { HeldMessage } from '@/lib/notify/types';
import { getJson, postJson } from '@/components/imports/api';

interface GoLiveResponse { live: boolean; liveAt: string | null; held: HeldMessage[] }

/**
 * Step 9 — the go-live switch. Until now nothing reached a customer: reminders, on-my-way texts and
 * pay links waited (core.outbound_messages "held"). Review them, keep the ones still right, and turn
 * customer messages on.
 */
export function GoLiveStep({ company, busy, error, onFinish, onBack, primaryRef }: {
  company: CompanyBrief;
  busy: boolean;
  error: string | null;
  onFinish: () => void;
  onBack: () => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [data, setData] = useState<GoLiveResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [going, setGoing] = useState(false);
  useEffect(() => { primaryRef.current = () => { if (!busy && !going) onFinish(); }; });

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await getJson<GoLiveResponse>(`/api/onboarding/go-live?companyId=${company.id}`);
      if (!live) return;
      if (!r.ok) { setLoadError(r.error); return; }
      setData(r.data);
      setKeep(new Set(r.data.held.map((m) => m.id)));
    })();
    return () => { live = false; };
  }, [company.id]);

  const goLive = async () => {
    if (!data) return;
    setGoing(true);
    const release = data.held.filter((m) => keep.has(m.id)).map((m) => m.id);
    const discard = data.held.filter((m) => !keep.has(m.id)).map((m) => m.id);
    const r = await postJson<{ live: boolean; released: number; discarded: number; still_held: number }>('/api/onboarding/go-live', { companyId: company.id, release, discard });
    setGoing(false);
    if (!r.ok) { toast(r.error, { tone: 'neg' }); return; }
    toast(`${company.name} is live. ${count(r.data.released)} ${r.data.released === 1 ? 'message' : 'messages'} on the way${r.data.discarded ? `, ${count(r.data.discarded)} dropped` : ''}.`);
    onFinish();
  };

  return (
    <>
      <PageHead eyebrow={['Set up', company.name]} title="Go live">
        <p className="ob-lede">Customer messages are paused while you set up. When you’re ready, turn them on; the ones that waited go out now.</p>
      </PageHead>
      {loadError ? <InlineNotice tone="warn" title={loadError}>You can go live later from Settings → Notifications.</InlineNotice> : !data ? (
        <div className="ob-skel" aria-busy="true"><span className="t-cap">Checking held messages…</span></div>
      ) : data.live ? (
        <InlineNotice tone="info" title={`${company.name} is already live for customer messages.`} />
      ) : (
        <section className="ob-card" aria-labelledby="gl-h">
          <div className="ob-card-h"><h3 id="gl-h">Waiting to go out</h3><span className="t-cap tnum">{count(data.held.length)}</span></div>
          {data.held.length === 0 ? (
            <WidgetState state={{ kind: 'empty', title: 'Nothing is waiting', body: 'No customer message was held. Going live turns reminders and texts on from here.' }} />
          ) : (
            <ul className="ob-results">
              {data.held.map((m) => (
                <li key={m.id}>
                  <Check aria-label={`Send ${m.subject ?? 'message'} to ${m.toAddress}`} checked={keep.has(m.id)}
                    onChange={(e) => { const next = new Set(keep); if (e.currentTarget.checked) next.add(m.id); else next.delete(m.id); setKeep(next); }} />
                  <span>
                    <span className="l1">{m.subject ?? (m.bodyMasked ? 'Customer message' : (m.body ?? '').slice(0, 80))}</span>
                    <span className="l2">{m.channel === 'sms' ? 'Text' : 'Email'} to {m.toAddress}{m.statusReason ? ` · ${m.statusReason}` : ''}</span>
                  </span>
                  <Tag>{keep.has(m.id) ? 'Send' : 'Drop'}</Tag>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {error && <div style={{ marginTop: 16 }}><InlineNotice tone="neg" title={error} /></div>}
      <div className="ob-foot">
        <Button variant="quiet" chord="escape" onClick={onBack}>Back</Button>
        <span className="sp" />
        <Button variant="quiet" disabled={busy || going} onClick={onFinish}>Not yet</Button>
        <Button variant="primary" size="lg" chord="enter" disabled={busy || going || !data || data.live} onClick={goLive}>{going ? 'Going live…' : 'Go live'}</Button>
      </div>
    </>
  );
}
