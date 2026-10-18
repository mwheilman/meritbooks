'use client';

import { useCallback, useState } from 'react';
import { Users, Loader2, AlertCircle, Send, Copy, Check, Mail } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';

/**
 * Wizard step — invite your team through the REAL invitation flow
 * (POST /api/team/invitations, lib/team/invitations.ts): a pending, revocable seat with
 * an emailed sign-up link that materializes the member on first login. Nothing is
 * created silently; when email isn't configured we say so and hand over the link.
 */

interface CompanyOption { id: string; name: string; shortCode: string }

const TEAM_ROLES: { value: string; label: string; desc: string }[] = [
  { value: 'accounting_manager', label: 'Bookkeeper / Accounting Manager', desc: 'Runs the books day to day — can finish onboarding for you' },
  { value: 'company_admin', label: 'Admin', desc: 'Full access to everything, including team and settings' },
  { value: 'cfo', label: 'CFO', desc: 'Financial oversight; approves chart-of-accounts changes' },
  { value: 'merit_controller', label: 'Controller', desc: 'Owns the close and controls' },
  { value: 'assistant_cfo', label: 'Assistant CFO', desc: 'Financial oversight support' },
  { value: 'accounting_specialist', label: 'Accounting Specialist', desc: 'Data entry, categorizing, receipts' },
  { value: 'check_processor', label: 'Check Processor', desc: 'Prints and manages checks only' },
  { value: 'general_admin', label: 'General Admin', desc: 'Administrative access' },
  { value: 'business_user', label: 'Business User (read-only)', desc: 'Dashboards and reports — e.g. your CPA or an owner' },
];

interface TeamMember { id: string; firstName: string; lastName: string; email: string | null; roleLabel: string }
interface TeamMembersResponse { data: TeamMember[] }
interface PendingInvite { id: string; email: string; roleLabel: string; expiresAt: string; isExpired: boolean }
interface InvitationsResponse { data: PendingInvite[]; available: boolean }
interface CreateInviteResponse {
  emailSent?: boolean;
  emailError?: string;
  acceptUrl?: string;
  error?: string;
  code?: string;
}

const inputCls = 'w-full px-3 py-2 bg-surface-900 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-brand-500/50';
const labelCls = 'block text-xs text-slate-500 mb-1.5 font-medium';

export function TeamStep({ companies }: { companies: CompanyOption[] }) {
  const members = useQuery<TeamMembersResponse>('/api/team/members', undefined, { scope: false });
  const invites = useQuery<InvitationsResponse>('/api/team/invitations', undefined, { scope: false });
  const refetchInvites = invites.refetch;

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState('accounting_manager');
  const [companyIds, setCompanyIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [manualLink, setManualLink] = useState<{ email: string; url: string; reason: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const invitationsUnavailable = invites.data?.available === false;

  const invite = useCallback(async () => {
    setSubmitting(true);
    setFormError('');
    setManualLink(null);
    try {
      const res = await fetch('/api/team/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          role,
          companyIds,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as CreateInviteResponse;
      if (!res.ok) {
        setFormError(body.error ?? 'Could not send that invitation');
        return;
      }
      const sentTo = email.trim();
      if (body.emailSent) {
        addToast('success', `Invitation emailed to ${sentTo}.`);
      } else if (body.acceptUrl) {
        setManualLink({ email: sentTo, url: body.acceptUrl, reason: body.emailError ?? 'Email isn’t set up yet.' });
        addToast('info', `Invitation created for ${sentTo} — share the link below.`);
      }
      setEmail(''); setFirstName(''); setLastName(''); setRole('accounting_manager'); setCompanyIds([]);
      await refetchInvites();
    } catch {
      setFormError('Network error sending the invitation');
    } finally {
      setSubmitting(false);
    }
  }, [email, firstName, lastName, role, companyIds, refetchInvites]);

  const copyLink = useCallback(async () => {
    if (!manualLink) return;
    try {
      await navigator.clipboard.writeText(manualLink.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      addToast('error', 'Could not copy — select the link and copy it manually.');
    }
  }, [manualLink]);

  const roster = members.data?.data ?? [];
  const pending = (invites.data?.data ?? []).filter((i) => !i.isExpired);

  return (
    <div className="space-y-4">
      <div className="card p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Users size={18} className="text-brand-400" /> Invite your team
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            We email each person a sign-up link. When they sign in with that email, they get exactly the access you
            chose. Optional — you can invite people any time from Team &amp; Access.
          </p>
        </div>

        {invitationsUnavailable ? (
          <div className="rounded-lg border border-warning/25 bg-warning/5 p-4 text-sm text-warning-fg flex items-start gap-2" role="status">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>Invitations aren&apos;t switched on for this workspace yet. You can skip this step and invite people later from Team &amp; Access.</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label htmlFor="invite-email" className={labelCls}>Email</label>
                <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="bookkeeper@company.com" />
              </div>
              <div>
                <label htmlFor="invite-first" className={labelCls}>First name <span className="text-slate-600">(optional)</span></label>
                <input id="invite-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label htmlFor="invite-last" className={labelCls}>Last name <span className="text-slate-600">(optional)</span></label>
                <input id="invite-last" value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputCls} />
              </div>
              <div className="col-span-2">
                <label htmlFor="invite-role" className={labelCls}>What will they do?</label>
                <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
                  {TEAM_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <p className="text-[10px] text-slate-600 mt-1">{TEAM_ROLES.find((r) => r.value === role)?.desc}</p>
              </div>
              {companies.length > 1 && (
                <div className="col-span-2">
                  <p className={labelCls}>Company access <span className="text-slate-600">(leave empty for all)</span></p>
                  <div className="flex flex-wrap gap-2">
                    {companies.map((c) => {
                      const on = companyIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setCompanyIds((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                          className={clsx('px-2.5 py-1 rounded-lg text-xs border transition-colors',
                            on ? 'bg-brand-500/10 border-brand-500/30 text-brand-300' : 'bg-surface-900 border-slate-700 text-slate-500 hover:text-slate-300')}
                        >
                          {c.shortCode || c.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {formError && (
              <div className="p-3 rounded-lg bg-danger/10 border border-danger/30 text-sm text-danger-fg flex items-center gap-2" role="alert">
                <AlertCircle size={15} /> {formError}
              </div>
            )}

            {manualLink && (
              <div className="rounded-lg border border-slate-700 bg-surface-950 p-3 space-y-2" role="status">
                <p className="text-xs text-slate-400">
                  {manualLink.reason} Send this link to <span className="text-slate-200">{manualLink.email}</span>:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate text-[11px] font-mono text-slate-300">{manualLink.url}</code>
                  <button type="button" onClick={() => void copyLink()} className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300">
                    {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => void invite()}
              disabled={!emailValid || submitting}
              className={clsx('flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                !emailValid || submitting ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-slate-900 hover:bg-brand-400')}
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send invitation
            </button>
          </>
        )}
      </div>

      <div className="card p-5 space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Invited — waiting to join ({pending.length})</p>
          {invites.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-2"><Loader2 size={14} className="animate-spin" /> Loading invitations…</div>
          ) : invites.error ? (
            <p className="text-xs text-slate-500">Invitations aren&apos;t visible with your permissions — that&apos;s fine, you can skip this step.</p>
          ) : pending.length === 0 ? (
            <p className="text-sm text-slate-500">No one invited yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {pending.map((i) => (
                <li key={i.id} className="flex items-center justify-between rounded-lg bg-surface-900 border border-slate-800 px-3 py-2">
                  <span className="flex items-center gap-2 text-sm text-white"><Mail size={13} className="text-slate-500" /> {i.email}</span>
                  <span className="text-[11px] text-slate-400">{i.roleLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">On the team ({roster.length})</p>
          {members.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-2"><Loader2 size={14} className="animate-spin" /> Loading team…</div>
          ) : members.error ? (
            <p className="text-xs text-slate-500">The team roster isn&apos;t visible with your permissions.</p>
          ) : roster.length === 0 ? (
            <p className="text-sm text-slate-500">Just you so far.</p>
          ) : (
            <ul className="space-y-1.5">
              {roster.map((m) => (
                <li key={m.id} className="flex items-center justify-between rounded-lg bg-surface-900 border border-slate-800 px-3 py-2">
                  <div>
                    <p className="text-sm text-white">{[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || 'Member'}</p>
                    <p className="text-[11px] text-slate-500">{m.email ?? '—'}</p>
                  </div>
                  <span className="text-[11px] text-slate-400">{m.roleLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
