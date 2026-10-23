'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Field, Icon, InlineNotice, Input, Select, Textarea, api, money } from '@meritbooks/merit-ui';
import type { HolderCard, HolderCharge, HolderView } from '@/lib/receipts/holder-view';
import type { WorkforceJob } from '@/lib/receipts/workforce-api';
import s from './workforce.module.css';

/**
 * Merit Workforce — Receipts (FPB-workforce-app §4.2, §15). One phone screen:
 * "Receipts needed" → pick a charge → take a photo or choose a file → note / job → send.
 * Also "Upload a receipt" without a charge (it matches itself). Works signed in (`me`) or
 * from the reminder's magic link (`link`); both APIs narrow everything to the cardholder.
 */

type Mode = { kind: 'me' } | { kind: 'link'; token: string };
type ViewResponse = HolderView & { jobs: WorkforceJob[] };
interface UploadResponse {
  saved: number;
  error?: string;
  results: Array<{ ok: boolean; error?: string; duplicate?: boolean; match?: string; merchant?: string | null; amountCents?: number | null; flags?: string[] }>;
}
type Screen = { kind: 'list' } | { kind: 'capture'; charge: HolderCharge | null } | { kind: 'done'; charge: HolderCharge | null; result: UploadResponse['results'][number] };

const endpoints = (m: Mode) =>
  m.kind === 'me'
    ? { view: '/api/w/me', upload: '/api/w/me/upload' }
    : { view: `/api/w/s/${encodeURIComponent(m.token)}`, upload: `/api/w/s/${encodeURIComponent(m.token)}/upload` };

function fmtDate(iso: string): string {
  const [y, mo, d] = iso.split('-').map(Number);
  if (!y || !mo || !d) return iso;
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function WorkforceReceipts({ mode }: { mode: Mode }) {
  const ep = useMemo(() => endpoints(mode), [mode]);
  const [view, setView] = useState<ViewResponse | null>(null);
  const [loadErr, setLoadErr] = useState<{ status: number; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [cardId, setCardId] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [online, setOnline] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.get<ViewResponse>(ep.view);
    setLoading(false);
    if (res.error) {
      setLoadErr({ status: res.status, message: res.error.error });
      return;
    }
    setLoadErr(null);
    setView(res.data);
    setCardId((cur) => cur ?? res.data?.cards[0]?.assignmentId ?? null);
  }, [ep.view]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const up = () => setOnline(navigator.onLine);
    up();
    window.addEventListener('online', up);
    window.addEventListener('offline', up);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', up);
    };
  }, []);

  const card: HolderCard | null = view?.cards.find((c) => c.assignmentId === cardId) ?? view?.cards[0] ?? null;

  return (
    <div className={s.shell}>
      <div className={s.app}>
        <header className={s.top}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/lockups/merit-icon-on-dark.svg" alt="" />
          <span className={s.appName}>Merit Workforce</span>
          <span className={s.who}>
            {view?.holderName ? <b>{view.holderName}</b> : null}
            {card ? <span style={{ display: 'block' }}>{card.companyName}</span> : null}
          </span>
        </header>
        <div className={s.rule} />
        <main className={s.body} id="main">
          {!online && (
            <InlineNotice tone="warn" title="You’re offline.">
              Photos can’t be sent until you’re back online. Nothing you’ve sent is lost.
            </InlineNotice>
          )}
          {loading && !view ? (
            <p className={s.p} role="status">
              Loading your receipts…
            </p>
          ) : loadErr ? (
            <div>
              <h1 className={s.h}>{loadErr.status === 410 ? 'This link has expired' : loadErr.status === 404 ? 'This link isn’t valid' : 'Something went wrong'}</h1>
              <p className={s.p}>{loadErr.status === 410 || loadErr.status === 404 ? 'Open the newest reminder email, or sign in to Merit Workforce to see what you owe.' : loadErr.message}</p>
              {loadErr.status >= 500 && (
                <div className={s.actions}>
                  <Button className={s.big} onClick={() => void load()}>
                    Try again
                  </Button>
                </div>
              )}
            </div>
          ) : !view || view.cards.length === 0 ? (
            <div>
              <h1 className={s.h}>No company card yet</h1>
              <p className={s.p}>When your company assigns you a card, the charges that need a receipt show up here.</p>
            </div>
          ) : screen.kind === 'capture' && card ? (
            <Capture
              card={card}
              charge={screen.charge}
              jobs={view.jobs.filter((j) => j.locationId === card.locationId)}
              uploadUrl={ep.upload}
              onCancel={() => setScreen({ kind: 'list' })}
              onDone={(result) => {
                setScreen({ kind: 'done', charge: screen.charge, result });
                void load();
              }}
            />
          ) : screen.kind === 'done' ? (
            <Done screen={screen} remaining={card?.needed.length ?? 0} onNext={() => setScreen({ kind: 'list' })} />
          ) : card ? (
            <List
              card={card}
              cards={view.cards}
              onPickCard={setCardId}
              onCapture={(charge) => setScreen({ kind: 'capture', charge })}
            />
          ) : null}
        </main>
        <footer className={s.foot}>
          Receipts go to {card?.companyName ?? 'your company'}’s books. Merit Workforce never posts or pays anything.
        </footer>
      </div>
    </div>
  );
}

function List({ card, cards, onPickCard, onCapture }: { card: HolderCard; cards: HolderCard[]; onPickCard: (id: string) => void; onCapture: (c: HolderCharge | null) => void }) {
  return (
    <div>
      {cards.length > 1 && (
        <Field label="Card">
          <Select value={card.assignmentId} onChange={(e) => onPickCard(e.target.value)}>
            {cards.map((c) => (
              <option key={c.assignmentId} value={c.assignmentId}>
                {c.companyName} · {c.cardLabel}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <h1 className={s.h}>{card.chaseOn ? (card.needed.length ? 'Receipts needed' : 'All caught up') : 'Receipts'}</h1>
      <p className={s.p}>
        {card.chaseOn
          ? card.needed.length
            ? `${card.needed.length} charge${card.needed.length === 1 ? '' : 's'} on ${card.cardLabel} still need a receipt.`
            : `Every charge on ${card.cardLabel} has its receipt. Thank you.`
          : `Send receipts for ${card.cardLabel} here any time — they match themselves to the charge.`}
      </p>

      {card.chaseOn && card.needed.length > 0 && (
        <>
          <div className={s.sum}>
            <span className={s.s}>Owed</span>
            <span className={s.sumAmt}>{money(card.neededTotalCents)}</span>
          </div>
          <ul className={s.lst}>
            {card.needed.map((c) => (
              <li key={c.transactionId}>
                <span className={s.m}>{c.merchant}</span>
                <span className={s.a}>{money(c.amountCents)}</span>
                <span className={s.s}>
                  {fmtDate(c.chargeDate)}
                  {c.asks > 0 ? <span className={c.asks >= 3 ? s.warn : undefined}> · asked {c.asks}×</span> : null}
                  {c.memoRequired ? ' · note needed' : ''}
                </span>
                <span />
                <span className={s.go}>
                  <Button variant="primary" icon="camera" onClick={() => onCapture(c)} aria-label={`Add the receipt for ${c.merchant}, ${money(c.amountCents)}`}>
                    Add receipt
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className={s.actions}>
        <Button className={s.big} icon="upload" onClick={() => onCapture(null)}>
          Upload a receipt
        </Button>
      </div>
      <div className={s.hint}>
        <Icon name="receipt" />
        <span>
          <b>Got an e-receipt?</b> Forward the email {card.receiptsAddress ? <>to <b>{card.receiptsAddress}</b></> : 'to your company’s receipts address'} from the address your reminders go to. It lands here and matches itself.
        </span>
      </div>

      {card.recent.length > 0 && (
        <section className={s.section} aria-labelledby="recent-h">
          <h2 id="recent-h" className="t-section">
            Sent recently
          </h2>
          <ul className={s.lst}>
            {card.recent.slice(0, 8).map((r) => (
              <li key={r.id}>
                <span className={s.m}>{r.matchedTo?.merchant ?? r.merchant ?? 'Receipt'}</span>
                <span className={s.a}>{r.amountCents != null ? money(r.amountCents) : r.matchedTo ? money(r.matchedTo.amountCents) : '—'}</span>
                <span className={s.s}>
                  {fmtDate(r.submittedAt.slice(0, 10))} · {r.matchStatus === 'matched' ? 'matched' : r.matchStatus === 'suggested' ? 'being checked' : 'waiting for its charge'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Capture({
  card,
  charge,
  jobs,
  uploadUrl,
  onCancel,
  onDone,
}: {
  card: HolderCard;
  charge: HolderCharge | null;
  jobs: WorkforceJob[];
  uploadUrl: string;
  onCancel: () => void;
  onDone: (r: UploadResponse['results'][number]) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [memo, setMemo] = useState('');
  const [jobId, setJobId] = useState('');
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const camRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file || !file.type.startsWith('image/') || /heic|heif/i.test(file.type)) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (f: FileList | null) => {
    setErr(null);
    const one = f?.[0] ?? null;
    if (one && one.size > 15 * 1024 * 1024) {
      setErr('That file is over 15 MB. Take a photo instead, or send a smaller file.');
      return;
    }
    setFile(one);
  };

  const send = async () => {
    setErr(null);
    if (!file) return setErr('Take a photo or choose a file first.');
    if (charge?.memoRequired && !memo.trim()) return setErr('Add a short note on what this was for.');
    if (amount && !/^\d{1,9}(\.\d{1,2})?$/.test(amount.trim())) return setErr('Amount like 68.42.');
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    form.set('assignment_id', card.assignmentId);
    if (charge) form.set('transaction_id', charge.transactionId);
    if (memo.trim()) form.set('memo', memo.trim());
    if (jobId) form.set('job_id', jobId);
    if (!charge) {
      if (merchant.trim()) form.set('merchant', merchant.trim());
      if (amount.trim()) form.set('amount', amount.trim());
      if (date) form.set('date', date);
    }
    try {
      const res = await fetch(uploadUrl, { method: 'POST', body: form });
      const body = (await res.json()) as UploadResponse;
      setBusy(false);
      const r = body.results?.[0];
      if (!res.ok || !r?.ok) return setErr(r?.error ?? body.error ?? 'Could not send that. Please try again.');
      onDone(r);
    } catch {
      setBusy(false);
      setErr('No connection. Your photo is still here — try again when you’re online.');
    }
  };

  return (
    <div>
      <h1 className={s.h}>{charge ? 'Add the receipt' : 'Upload a receipt'}</h1>
      {charge ? (
        <div className={s.chg}>
          <div className={s.chgTop}>
            <span>{card.cardLabel}</span>
            <span>{fmtDate(charge.chargeDate)}</span>
          </div>
          <div className={s.chgAmt}>{money(charge.amountCents)}</div>
          <div className={s.m}>{charge.merchant}</div>
        </div>
      ) : (
        <p className={s.p}>We’ll find the card charge it belongs to. Charges can take a day or two to show up.</p>
      )}

      <div className={s.opts}>
        <label className={`${s.pick} ${s.pickPrimary}`}>
          <Icon name="camera" />
          Take a photo
          <input ref={camRef} className="sr" type="file" accept="image/*" capture="environment" onChange={(e) => pick(e.target.files)} />
        </label>
        <label className={s.pick}>
          <Icon name="file-text" />
          Choose a file
          <input className="sr" type="file" accept="image/*,application/pdf" onChange={(e) => pick(e.target.files)} />
        </label>
      </div>

      {file && (
        <div className={s.thumb}>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Your receipt photo" />
          ) : (
            <span className={s.thumbDoc}>
              <Icon name="file-text" size={20} />
            </span>
          )}
          <span>
            <span className={s.m}>{file.name}</span>
            <span className={s.s} style={{ display: 'block' }}>
              {(file.size / 1024 / 1024).toFixed(1)} MB · ready to send
            </span>
          </span>
        </div>
      )}

      <div className={s.form}>
        {!charge && (
          <>
            <Field label="Merchant (optional)">
              <Input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="Shell" autoComplete="off" />
            </Field>
            <div className={s.row2}>
              <Field label="Amount (optional)">
                <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="68.42" />
              </Field>
              <Field label="Date (optional)">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            </div>
          </>
        )}
        <Field label={charge?.memoRequired ? 'What was it for?' : 'What was it for? (optional)'}>
          <Textarea rows={2} value={memo} maxLength={1000} onChange={(e) => setMemo(e.target.value)} placeholder="Fuel for the Johnson install" />
        </Field>
        {jobs.length > 0 && (
          <Field label="Job (optional)">
            <Select value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">No job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {err && (
        <InlineNotice tone="neg" title="Not sent yet." className={s.section}>
          {err}
        </InlineNotice>
      )}

      <div className={s.actions}>
        <Button variant="primary" className={s.big} disabled={busy || !file} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send receipt'}
        </Button>
        <Button variant="quiet" className={s.big} onClick={onCancel} disabled={busy}>
          Back
        </Button>
      </div>
    </div>
  );
}

function Done({ screen, remaining, onNext }: { screen: Extract<Screen, { kind: 'done' }>; remaining: number; onNext: () => void }) {
  const r = screen.result;
  const matched = r.match === 'matched' || r.match === 'attached';
  return (
    <div>
      <div className={s.done} role="status">
        <h1 className={s.h} style={{ marginTop: 0 }}>
          {r.duplicate ? 'Already got this one' : matched ? 'Done — thank you' : 'Received'}
        </h1>
        <p className={s.p}>
          {r.duplicate
            ? 'This receipt was sent before, so nothing changed.'
            : matched
              ? `${screen.charge ? `${screen.charge.merchant} · ${money(screen.charge.amountCents)}` : 'It matched its card charge'}. The reminders for it have stopped.`
              : 'We’ll match it to the card charge as soon as the charge shows up. No need to send it again.'}
        </p>
        {r.flags?.includes('amount_differs') && <p className={s.p}>The total on the receipt differs from the charge; your bookkeeper will take a look.</p>}
      </div>
      <div className={s.actions}>
        <Button variant="primary" className={s.big} onClick={onNext}>
          {remaining > 0 ? `Next receipt (${remaining} left)` : 'Back to my receipts'}
        </Button>
      </div>
    </div>
  );
}
