'use client';

import { useMemo, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  InlineNotice,
  Pip,
  QueueTable,
  Select,
  Tag,
  api,
  toast,
  useQuery,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { usd } from './receipts-types';
import type { ActionResult, CardholderOptions, CardholderRow } from './receipts-types';
import s from './receipts.module.css';

export interface CardholdersTabProps {
  locationId: string | null;
  companyName: string | null;
  refreshKey: number;
  onChanged: () => void;
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
}

function chaseLook(r: CardholderRow): { pip: 'ready' | 'soft' | 'risk'; word: string } {
  if (r.chase_opt_out) return { pip: 'soft', word: 'Opted out' };
  if (r.opt_out_status === 'pending') return { pip: 'risk', word: 'Opt-out waiting' };
  return { pip: 'ready', word: 'Chased' };
}

export function CardholdersTab({ locationId, companyName, refreshKey, onChanged, addOpen, setAddOpen }: CardholdersTabProps) {
  const [key, setKey] = useState(0);
  const [edit, setEdit] = useState<CardholderRow | null>(null);
  const [endRow, setEndRow] = useState<CardholderRow | null>(null);
  const [optOut, setOptOut] = useState<CardholderRow | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, error, isLoading, refetch } = useQuery<{ rows: CardholderRow[] }>(
    '/api/receipts/cardholders',
    { location_id: locationId ?? undefined },
    { key: `${refreshKey}:${key}`, scope: false },
  );
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const done = () => {
    setKey((k) => k + 1);
    onChanged();
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await api.patch<ActionResult>(`/api/receipts/cardholders/${id}`, body);
    if (res.error) {
      toast.error(res.error.error);
      return false;
    }
    toast(res.data?.message ?? 'Saved.');
    done();
    return true;
  };

  const columns = useMemo<QueueColumn<CardholderRow>[]>(
    () => [
      {
        id: 'chase',
        header: 'Chase',
        width: 150,
        cell: (r) => {
          const l = chaseLook(r);
          return (
            <span className="mb-sev">
              <Pip kind={l.pip} />
              {l.word}
            </span>
          );
        },
      },
      {
        id: 'who',
        header: 'Cardholder',
        cell: (r) => (
          <>
            <span className="l1">{r.holder_name}</span>
            <span className="l2">{[r.holder_email, r.holder_phone, r.holder_type === 'external' ? 'Outside person' : null].filter(Boolean).join(' · ') || 'No contact details'}</span>
          </>
        ),
      },
      {
        id: 'card',
        header: 'Card',
        width: 160,
        cell: (r) => <span className="ink-2">{[r.card_label, r.card_last4 ? `••${r.card_last4}` : 'Whole card feed'].filter(Boolean).join(' ')}</span>,
      },
      {
        id: 'open',
        header: 'Owes',
        width: 140,
        numeric: true,
        cell: (r) => (r.open_count ? <span className="tnum">{r.open_count} · {usd(r.open_cents)}</span> : <span className="ink-3">Nothing</span>),
      },
    ],
    [],
  );

  const sel = rows.find((r) => r.id === cursor) ?? null;

  return (
    <div>
      <div className={s.toolbar}>
        <p className="t-cap">
          Who holds each card. A charge on a card here is chased to its holder; charges on a card without one show “No cardholder”.
        </p>
        <div className={s.grow} />
        <Button variant="primary" icon="plus" disabled={!locationId} onClick={() => setAddOpen(true)}>
          Add cardholder
        </Button>
      </div>
      {!locationId && <InlineNotice title="Pick a company in the header to add cardholders.">Cards and cardholders belong to one company.</InlineNotice>}

      {error ? (
        <div className={s.state} role="alert">
          <p className="t-head">Couldn’t load cardholders.</p>
          <p className="ink-2">{error}</p>
          <Button onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : isLoading && !data ? (
        <div className={s.state} role="status">
          <p className="t-cap">Loading cardholders…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className={s.state}>
          <p className="t-head">No cardholders yet.</p>
          <p className="ink-2">Add the people who carry company cards. Their charges over the receipt limit are chased automatically.</p>
        </div>
      ) : (
        <div className={s.split}>
          <QueueTable<CardholderRow>
            aria-label="Cardholders"
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            cursorId={cursor}
            onCursorChange={(id) => setCursor(id)}
            onOpen={(r) => setCursor(r.id)}
            openOnClick
            rowState={(r) => ({ attn: r.opt_out_status === 'pending' })}
          />
          <div className={s.state}>
            {sel ? (
              <>
                <p className="t-head">{sel.holder_name}</p>
                <p className="ink-2">
                  {sel.opt_out_status === 'pending'
                    ? `Opt-out requested: “${sel.opt_out_reason ?? ''}”. Someone other than the requester must approve it.`
                    : sel.chase_opt_out
                      ? `Not chased: ${sel.opt_out_reason ?? 'opted out'}.`
                      : 'Receipts for this card are chased on the receipt policy schedule.'}
                </p>
                <div className={s.actions}>
                  <Button onClick={() => setEdit(sel)}>Edit</Button>
                  {sel.opt_out_status === 'pending' ? (
                    <>
                      <Button variant="primary" onClick={() => void patch(sel.id, { action: 'approve_opt_out' })}>
                        Approve opt-out
                      </Button>
                      <Button onClick={() => void patch(sel.id, { action: 'reject_opt_out' })}>Reject</Button>
                    </>
                  ) : sel.chase_opt_out ? (
                    <Button onClick={() => void patch(sel.id, { action: 'clear_opt_out' })}>Chase again</Button>
                  ) : (
                    <Button variant="quiet" onClick={() => setOptOut(sel)}>
                      Request opt-out
                    </Button>
                  )}
                  <Button variant="danger" onClick={() => setEndRow(sel)}>
                    End assignment
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="t-head">Pick a cardholder</p>
                <p className="ink-2">Edit their contact details or manager, pause chase with an approved opt-out, or end the assignment.</p>
              </>
            )}
          </div>
        </div>
      )}

      {(addOpen || edit) && locationId && (
        <CardholderDialog
          locationId={edit?.location_id ?? locationId}
          companyName={companyName}
          row={edit}
          onClose={() => {
            setAddOpen(false);
            setEdit(null);
          }}
          onSaved={() => {
            setAddOpen(false);
            setEdit(null);
            done();
          }}
        />
      )}
      <ConfirmDialog
        open={!!endRow}
        onClose={() => setEndRow(null)}
        tone="danger"
        title={endRow ? `End ${endRow.holder_name}’s card assignment?` : ''}
        confirmLabel="End assignment"
        onConfirm={async () => {
          if (endRow && (await patch(endRow.id, { action: 'end' }))) setEndRow(null);
        }}
      >
        <p className="ink-2">Their open charges move to “No cardholder”, their Merit Workforce links stop working, and history is kept.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!optOut}
        onClose={() => setOptOut(null)}
        title={optOut ? `Stop chasing ${optOut.holder_name}’s receipts?` : ''}
        confirmLabel="Request opt-out"
        reason={{ label: 'Why?', help: 'A second person with approval rights has to confirm it.', minLength: 5, placeholder: 'Owner — pays personally and submits monthly' }}
        onConfirm={async (reason) => {
          if (optOut && (await patch(optOut.id, { action: 'request_opt_out', reason: reason ?? '' }))) setOptOut(null);
        }}
      />
    </div>
  );
}

interface CardholderDialogProps {
  locationId: string;
  companyName: string | null;
  row: CardholderRow | null;
  onClose: () => void;
  onSaved: () => void;
}

function CardholderDialog({ locationId, companyName, row, onClose, onSaved }: CardholderDialogProps) {
  const { data: opts, isLoading } = useQuery<CardholderOptions>('/api/receipts/cardholders/options', { location_id: locationId }, { scope: false });
  const [holderType, setHolderType] = useState<CardholderRow['holder_type']>(row?.holder_type ?? 'employee');
  const [employeeId, setEmployeeId] = useState(row?.employee_id ?? '');
  const [membershipId, setMembershipId] = useState(row?.membership_id ?? '');
  const [name, setName] = useState(row?.holder_name ?? '');
  const [email, setEmail] = useState(row?.holder_email ?? '');
  const [phone, setPhone] = useState(row?.holder_phone ?? '');
  const [accountId, setAccountId] = useState(row?.bank_account_id ?? '');
  const [last4, setLast4] = useState(row?.card_last4 ?? '');
  const [label, setLabel] = useState(row?.card_label ?? '');
  const [manager, setManager] = useState(row?.manager_membership_id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickEmployee = (id: string) => {
    setEmployeeId(id);
    const e = opts?.employees.find((x) => x.id === id);
    if (e) {
      setName(e.name);
      if (e.email) setEmail(e.email);
      if (e.phone) setPhone(e.phone);
    }
  };
  const pickMember = (id: string) => {
    setMembershipId(id);
    const m = opts?.members.find((x) => x.id === id);
    if (m) {
      setName(m.name);
      if (m.email) setEmail(m.email);
    }
  };

  const save = async () => {
    setErr(null);
    if (!name.trim()) return setErr('Add the cardholder’s name.');
    if (!accountId && !/^\d{4}$/.test(last4)) return setErr('Pick the card account or enter the card’s last 4.');
    if (last4 && !/^\d{4}$/.test(last4)) return setErr('The last 4 must be four digits.');
    if (holderType !== 'member' && !email.trim()) return setErr('Add an email so the reminders can reach them.');
    setBusy(true);
    const data = {
      location_id: locationId,
      bank_account_id: accountId || null,
      card_last4: last4 || null,
      card_label: label.trim() || null,
      holder_type: holderType,
      membership_id: holderType === 'member' ? membershipId || null : null,
      employee_id: holderType === 'employee' ? employeeId || null : null,
      holder_name: name.trim(),
      holder_email: email.trim() || null,
      holder_phone: phone.trim() || null,
      holder_timezone: row?.holder_timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      manager_membership_id: manager || null,
    };
    const res = row ? await api.patch<ActionResult>(`/api/receipts/cardholders/${row.id}`, { action: 'update', data }) : await api.post<{ asked: number }>('/api/receipts/cardholders', data);
    setBusy(false);
    if (res.error) return setErr(res.error.error);
    toast(row ? 'Cardholder saved.' : 'Cardholder added. Their charges over the limit are being asked for now.');
    onSaved();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={row ? `Edit ${row.holder_name}` : 'Add a cardholder'}
      dismissOnScrim={false}
      footNote={companyName ? `For ${companyName}` : undefined}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || isLoading} onClick={() => void save()}>
            {busy ? 'Saving…' : row ? 'Save' : 'Add cardholder'}
          </Button>
        </>
      }
    >
      <div className={s.formGrid}>
        {err && (
          <InlineNotice tone="neg" title="Check this.">
            {err}
          </InlineNotice>
        )}
        <Field label="Who holds the card?">
          <Select value={holderType} onChange={(e) => setHolderType(e.target.value as CardholderRow['holder_type'])}>
            <option value="employee">An employee</option>
            <option value="member">A team member who signs in</option>
            <option value="external">Someone else (owner, contractor)</option>
          </Select>
        </Field>
        {holderType === 'employee' && (
          <Field label="Employee">
            <Select value={employeeId} onChange={(e) => pickEmployee(e.target.value)}>
              <option value="">{isLoading ? 'Loading…' : 'Choose an employee'}</option>
              {(opts?.employees ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.title ? ` · ${e.title}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {holderType === 'member' && (
          <Field label="Team member" help="They also get in-app reminders and see their receipts in Merit Workforce when signed in.">
            <Select value={membershipId} onChange={(e) => pickMember(e.target.value)}>
              <option value="">{isLoading ? 'Loading…' : 'Choose a team member'}</option>
              {(opts?.members ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className={s.two}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" help="Reminders go here.">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <div className={s.two}>
          <Field label="Mobile" help={<>Text reminders start when SMS is set up. <Tag>Not set up</Tag></>}>
            <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Manager (gets escalations)">
            <Select value={manager} onChange={(e) => setManager(e.target.value)}>
              <option value="">The bookkeeper</option>
              {(opts?.members ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className={s.three}>
          <Field label="Card feed account">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Any account (match by last 4)</option>
              {(opts?.accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.type === 'CREDIT_CARD' ? '' : ' · debit'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Card last 4" help="Leave blank when the whole feed is one card.">
            <Input inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          </Field>
          <Field label="Card name">
            <Input value={label} placeholder="Ramp" onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
