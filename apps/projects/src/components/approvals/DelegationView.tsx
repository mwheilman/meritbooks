'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, Check, ConfirmDialog, Field, InlineNotice, Input, MoneyInput, Select, Status, WidgetState, api, count, money, shortDate, toast,
} from '@meritbooks/merit-ui';
import type { ApprovalObjectType, DelegateCandidate, Delegation, MyDelegations } from '@/lib/approvals/types';
import { APPROVAL_OBJECT_TYPES } from '@/lib/approvals/types';
import { OBJECT_LABELS, ROLE_TITLES } from '@/lib/approvals/labels';
import { todayIso } from '@/lib/time';

export interface DelegationViewProps {
  mine: MyDelegations;
  candidates: DelegateCandidate[];
  canManage: boolean;
  readOnly: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Local midnight at the start of a day / the end of a day, as an ISO instant with offset. */
function dayStart(iso: string): string { return new Date(`${iso}T00:00:00`).toISOString(); }
function dayEnd(iso: string): string { return new Date(`${iso}T23:59:59`).toISOString(); }

function DelegationRow({ d, side, onEnd, readOnly }: { d: Delegation; side: 'out' | 'in' | 'managed'; onEnd: (d: Delegation) => void; readOnly: boolean }) {
  const who = side === 'out' ? d.delegate : side === 'in' ? d.delegator : `${d.delegate} for ${d.delegator}`;
  const kind = d.state === 'active' ? 'ready' : d.state === 'scheduled' ? 'track' : 'blocked';
  return (
    <li>
      <span>
        <b>{who}</b>
        <span className="ap-sub" style={{ display: 'block' }}>
          {[`${shortDate(d.starts_at.slice(0, 10))} – ${shortDate(d.ends_at.slice(0, 10))}`,
            d.max_amount_cents != null ? `up to ${money(d.max_amount_cents)}` : 'any amount',
            d.object_types.length ? d.object_types.map((t) => OBJECT_LABELS[t].many).join(', ') : 'everything',
            d.used ? `${count(d.used)} decided` : null, d.reason].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="row" style={{ gap: 12, alignItems: 'center' }}>
        <Status kind={kind}>{d.state === 'active' ? 'Active' : d.state === 'scheduled' ? 'Scheduled' : 'Ended'}</Status>
        {d.state !== 'ended' && !readOnly && <Button onClick={() => onEnd(d)}>End now</Button>}
      </span>
    </li>
  );
}

/**
 * Out-of-office cover. Rules the engine enforces (shown here so nobody is surprised): never
 * yourself; the delegate never approves above their own limit or their own items; owner-tier
 * items need a GM or owner as the delegate.
 */
export function DelegationView({ mine, candidates, canManage, readOnly }: DelegationViewProps) {
  const router = useRouter();
  const today = todayIso();
  const [delegate, setDelegate] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 7));
  const [cap, setCap] = useState<number | null>(null);
  const [types, setTypes] = useState<Set<ApprovalObjectType>>(() => new Set());
  const [notify, setNotify] = useState(true);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [ending, setEnding] = useState<Delegation | null>(null);
  const picked = useMemo(() => candidates.find((c) => c.membership_id === delegate) ?? null, [candidates, delegate]);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!delegate) e.delegate = 'Pick who covers you.';
    if (!DAY.test(from)) e.from = 'Pick a start date.';
    if (!DAY.test(to)) e.to = 'Pick an end date.';
    else if (to < from) e.to = 'The cover ends on or after the day it starts.';
    else if (to < today) e.to = 'That date has passed.';
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const r = await api.post<{ id: string }>('/api/approvals/delegations', {
      delegateMembershipId: delegate, startsAt: from === today ? new Date().toISOString() : dayStart(from), endsAt: dayEnd(to),
      maxAmountCents: cap, objectTypes: [...types], notify, reason: reason.trim() || null,
    });
    setBusy(false);
    if (r.error) { setErr({ form: r.error.error }); return; }
    toast(`Set up cover by ${picked?.name ?? 'your delegate'}`);
    setDelegate(''); setCap(null); setTypes(new Set()); setReason('');
    router.refresh();
  };

  const toggle = (t: ApprovalObjectType, on: boolean) => setTypes((s) => { const n = new Set(s); if (on) n.add(t); else n.delete(t); return n; });

  return (
    <div className="stack">
      <section className="ap-section">
        <div className="ap-section-h"><h2 className="t-section">Set up cover</h2><span className="sp" /></div>
        {readOnly ? (
          <InlineNotice tone="info" title="Read-only view.">Switch to a company to change cover.</InlineNotice>
        ) : candidates.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: 'Nobody can cover your approvals yet', body: 'A teammate needs an approving role at one of your companies first. Ask an owner to give them one in Settings → Team.' }} />
        ) : (
          <form className="ap-form" onSubmit={(ev) => { ev.preventDefault(); void submit(); }}>
            <Field label="Who covers you" error={err.delegate} help={picked ? (picked.roles ?? []).map((r) => ROLE_TITLES[r] ?? r).join(', ') : 'They approve what you could, never above their own limit.'}>
              <Select value={delegate} onChange={(e) => setDelegate(e.target.value)}>
                <option value="">Pick a teammate</option>
                {candidates.map((c) => <option key={c.membership_id} value={c.membership_id}>{c.name ?? 'Teammate'}{c.management ? ' · management' : ''}</option>)}
              </Select>
            </Field>
            <div className="ap-form-2">
              <Field label="From" error={err.from}><Input type="date" value={from} min={today} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="Until (inclusive)" error={err.to}><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
            </div>
            <Field label="Up to (optional)" help="Leave empty for any amount up to their own limit.">
              <MoneyInput valueCents={cap} onChangeCents={setCap} placeholder="No cap" />
            </Field>
            <Field label="Only these (optional)" help="Nothing ticked covers everything.">
              <div className="ap-types">
                {APPROVAL_OBJECT_TYPES.map((t) => <Check key={t} label={OBJECT_LABELS[t].many} checked={types.has(t)} onChange={(e) => toggle(t, e.target.checked)} />)}
              </div>
            </Field>
            <Check label="Tell me what they approve for me" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <Field label="Note (optional)"><Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="On site visits Oct 27 – 31" /></Field>
            {picked && !picked.management && <p className="ap-sub">Owner-only approvals still wait for a general manager or owner.</p>}
            {err.form && <InlineNotice tone="neg" title="Not set up.">{err.form}</InlineNotice>}
            <div className="btn-row"><Button type="submit" variant="primary" disabled={busy}>Set up cover</Button></div>
          </form>
        )}
      </section>

      <section className="ap-section">
        <div className="ap-section-h"><h2 className="t-section">My cover</h2><span className="sp" /><span className="t-cap">{count(mine.outgoing.length)}</span></div>
        {mine.outgoing.length === 0
          ? <WidgetState state={{ kind: 'empty', title: 'You have no cover set up', body: 'Set one up before time off so approvals keep moving.' }} />
          : <ul className="ap-list">{mine.outgoing.map((d) => <DelegationRow key={d.id} d={d} side="out" onEnd={setEnding} readOnly={readOnly} />)}</ul>}
      </section>

      <section className="ap-section">
        <div className="ap-section-h"><h2 className="t-section">I cover for</h2><span className="sp" /><span className="t-cap">{count(mine.incoming.length)}</span></div>
        {mine.incoming.length === 0
          ? <WidgetState state={{ kind: 'done', title: 'You are not covering for anyone', body: 'When someone names you, their items show in your queue marked “for” them.' }} />
          : <ul className="ap-list">{mine.incoming.map((d) => <DelegationRow key={d.id} d={d} side="in" onEnd={setEnding} readOnly={readOnly} />)}</ul>}
      </section>

      {canManage && mine.managed.length > 0 && (
        <section className="ap-section">
          <div className="ap-section-h"><h2 className="t-section">Team cover</h2><span className="sp" /><span className="t-cap">{count(mine.managed.length)}</span></div>
          <ul className="ap-list">{mine.managed.map((d) => <DelegationRow key={d.id} d={d} side="managed" onEnd={setEnding} readOnly={readOnly} />)}</ul>
        </section>
      )}

      <ConfirmDialog
        open={!!ending}
        onClose={() => setEnding(null)}
        tone="danger"
        title="End this cover now"
        confirmLabel="End cover"
        onConfirm={async () => {
          if (!ending) return;
          const r = await api.delete<{ ok: boolean }>(`/api/approvals/delegations/${ending.id}`);
          if (r.error) throw new Error(r.error.error);
          toast('Ended the cover');
          router.refresh();
        }}
      >
        Items go back to the regular approvers right away. What was already decided stays in the history.
      </ConfirmDialog>
    </div>
  );
}
