'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Check, ConfirmDialog, Field, InlineNotice, Select, Status, WidgetState, toast } from '@meritbooks/merit-ui';

type Audience = 'customer' | 'vendor' | 'lender' | 'investor';

interface Grant {
  id: string; audience: Audience; display_name: string; email: string | null; phone: string | null; role: 'approver' | 'viewer';
  can_sign: boolean; can_pay: boolean; all_jobs: boolean; status: string; expires_at: string | null; accepted_at: string | null; last_seen_at: string | null; job_ids: string[];
}
interface Contact { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; can_sign: boolean; can_pay: boolean }

const AUDIENCE_WORD: Record<Audience, string> = { customer: 'Customer', vendor: 'Sub / vendor', lender: 'Lender', investor: 'Investor' };
const nameOf = (c: Contact) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Contact';

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, data } : { ok: false, error: data.error ?? 'That did not go through.' };
  } catch {
    return { ok: false, error: 'No connection. Try again.' };
  }
}

/**
 * "Invite to portal" for a job, a customer or a vendor page: who has access (status, last seen,
 * who can sign / pay), invite a contact (held until the company goes live), change rights, remove.
 * The database decides who may do this (customers:edit / commitments:edit / billing:edit).
 */
export function PortalAccessPanel({ companyId, audience, customerId, vendorId, jobId }: {
  companyId: string; audience: Audience; customerId?: string | null; vendorId?: string | null; jobId?: string | null;
}) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [contact, setContact] = useState('');
  const [role, setRole] = useState<'approver' | 'viewer'>('approver');
  const [canPay, setCanPay] = useState(false);
  const [allJobs, setAllJobs] = useState(!jobId);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Grant | null>(null);

  const party = audience === 'vendor' ? vendorId : customerId;
  const load = useCallback(async () => {
    const qs = new URLSearchParams({ companyId, ...(jobId ? { jobId } : {}), ...(audience === 'vendor' && vendorId ? { vendorId } : {}), ...(audience !== 'vendor' && customerId ? { customerId } : {}) });
    const r = await call<{ grants: Grant[] }>(`/api/portal/staff/grants?${qs}`);
    if (!r.ok) { setError(r.error); return; }
    setGrants(r.data.grants.filter((g) => g.audience === audience && g.status === 'active'));
  }, [companyId, jobId, audience, customerId, vendorId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!open || !party) return;
    void call<{ contacts: Contact[] }>(`/api/portal/staff/contacts?${audience === 'vendor' ? 'vendorId' : 'customerId'}=${party}`).then((r) => {
      if (r.ok) { setContacts(r.data.contacts); if (r.data.contacts[0]) { setContact(r.data.contacts[0].id); setCanPay(r.data.contacts[0].can_pay); } }
    });
  }, [open, party, audience]);

  const sendInvite = async () => {
    setBusy(true);
    const r = await call<{ message: { status: string; reason: string | null } | null }>('/api/portal/staff/grants', {
      method: 'POST',
      body: JSON.stringify({ op: `invite_${audience}`, companyId, contactId: contact, jobIds: jobId && !allJobs ? [jobId] : [], allJobs, role, canPay: audience === 'customer' ? canPay : undefined }),
    });
    setBusy(false);
    if (!r.ok) { toast.error(r.error); return; }
    const st = r.data.message?.status;
    toast(st === 'held' ? 'Invited. The message is held until this company goes live for customer messages.' : st === 'suppressed' ? `Invited, but not sent: ${r.data.message?.reason ?? 'suppressed'}` : 'Invitation sent.');
    setOpen(false);
    void load();
  };

  return (
    <section aria-label="Portal access" style={{ padding: 16, background: 'var(--white)', border: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h3 className="t-section" style={{ margin: 0 }}>Portal access · {AUDIENCE_WORD[audience]}</h3>
        {party || audience === 'investor' || audience === 'lender' ? <Button onClick={() => setOpen((o) => !o)} disabled={!party}>Invite to portal</Button> : null}
      </div>
      {error ? <InlineNotice tone="neg" title={error} /> : grants === null ? <WidgetState state={{ kind: 'loading', label: 'Loading portal access…', lines: 2 }} /> : grants.length === 0 ? (
        <p className="t-cap" style={{ marginTop: 8 }}>Nobody has portal access here yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {grants.map((g) => (
            <li key={g.id} style={{ display: 'flex', gap: 12, alignItems: 'baseline', justifyContent: 'space-between', borderTop: '1px solid var(--line)', padding: '8px 0' }}>
              <span>
                <b>{g.display_name}</b>
                <span className="t-cap"> · {g.role === 'approver' ? 'approves' : 'views'}{g.can_sign ? ' · signs' : ''}{g.can_pay ? ' · pays' : ''}{g.all_jobs ? ' · all jobs' : ''}</span>
              </span>
              <Status kind={g.accepted_at ? 'ready' : 'track'} pip={g.accepted_at ? 'closed' : 'open'}>{g.accepted_at ? (g.last_seen_at ? `Seen ${new Date(g.last_seen_at).toLocaleDateString()}` : 'Signed in') : 'Invited'}</Status>
              <Button variant="quiet" onClick={() => setRemoving(g)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <form className="mp-form" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); if (contact) void sendInvite(); }}>
          {contacts.length === 0 ? <InlineNotice tone="warn" title="Add a contact with an email or mobile number first." /> : (
            <Field label="Contact">
              <Select value={contact} onChange={(e) => { setContact(e.target.value); setCanPay(contacts.find((c) => c.id === e.target.value)?.can_pay ?? false); }}>
                {contacts.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}{c.email ? ` · ${c.email}` : c.phone ? ` · ${c.phone}` : ''}</option>)}
              </Select>
            </Field>
          )}
          {audience !== 'investor' && (
            <Field label="Rights">
              <Select value={role} onChange={(e) => setRole(e.target.value as 'approver' | 'viewer')}>
                <option value="approver">Approves and signs</option>
                <option value="viewer">Views only</option>
              </Select>
            </Field>
          )}
          {audience === 'customer' && <Check label="Can pay invoices online" checked={canPay} onChange={(e) => setCanPay(e.target.checked)} />}
          {jobId && <Check label={audience === 'vendor' ? 'All jobs this sub works on' : 'All of this customer’s jobs'} checked={allJobs} onChange={(e) => setAllJobs(e.target.checked)} />}
          <p className="t-cap">They sign in with their email or mobile number — no password. They see only what you share: never cost, margin or internal notes.</p>
          <div className="btn-row">
            <Button type="submit" variant="primary" disabled={busy || !contact}>Send invitation</Button>
            <Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.display_name ?? ''}’s portal access?`}
        confirmLabel="Remove access"
        tone="danger"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const g = removing; setRemoving(null);
          if (!g) return;
          const r = await call(`/api/portal/staff/grants/${g.id}`, { method: 'DELETE' });
          if (!r.ok) { toast.error(r.error); return; }
          toast('Portal access removed.');
          void load();
        }}
      >
        They lose access at once. Their past approvals and messages stay on the record.
      </ConfirmDialog>
    </section>
  );
}
