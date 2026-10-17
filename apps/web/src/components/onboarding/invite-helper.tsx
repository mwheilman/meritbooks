'use client';

/**
 * InviteHelper — "Invite my bookkeeper to finish this" (FPB-onboarding §5, principle 8
 * "Delegate anything", blocker B4). Owned by W4; mounted on every onboarding step by W2.
 *
 *   <InviteHelper context="Opening balances for Heritage Interiors" companyId={id} compact />
 *
 * • compact → a small inline link; otherwise a surface-900 card. Both open the same
 *   small dialog: email, first name, role (only roles that can actually run onboarding,
 *   derived from permissions.ts; default Accounting Manager, who can also approve the
 *   opening balances).
 * • Sends through the REAL invitation API (POST /api/team/invitations), which emails a
 *   working /sign-up?invite=… link. The `context` rides along into the email ("Waiting
 *   for you: …") and the action log; with a company, the invitee is given access to it
 *   and named its onboarding owner.
 * • Never pretends: a preflight (GET) learns up front whether this user may invite and
 *   whether email is configured; when email isn't configured the success state says
 *   "invite saved — email not sent" and offers the link to copy.
 *
 * States: idle / checking / form / sending / sent / saved-not-emailed / error /
 * not-allowed. Keyboard: Esc closes, focus moves into the dialog and returns to the
 * trigger, Tab is contained. Design system: emerald accent, surface-900 cards.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { UserPlus, X, Loader2, CheckCircle2, AlertTriangle, Copy, Check, MailWarning } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import {
  onboardingCapableRoles,
  resolveDefaultRole,
  buildInviteRequest,
  inviteErrorMessage,
  isPlausibleEmail,
} from '@/lib/team/invite-helper';
import type { UserRole } from '@/lib/rbac/permissions';

export interface InviteHelperProps {
  /** What the invitee is being asked to finish, e.g. "Opening balances for Heritage Interiors". */
  context: string;
  companyId?: string | null;
  /** Must be a role that can run onboarding; anything else falls back to Accounting Manager. */
  defaultRole?: string;
  /** Inline link (true) vs card (false/undefined). */
  compact?: boolean;
}

interface PreflightResponse { available?: boolean; emailConfigured?: boolean }
interface CreateResponse { emailSent?: boolean; emailError?: string; acceptUrl?: string }

type Phase =
  | { kind: 'checking' }
  | { kind: 'form' }
  | { kind: 'not_allowed'; message: string }
  | { kind: 'sent'; email: string }
  | { kind: 'saved_not_emailed'; email: string; acceptUrl: string | null; reason: string };

export function InviteHelper({ context, companyId = null, defaultRole, compact = false }: InviteHelperProps): JSX.Element {
  const roles = useMemo(() => onboardingCapableRoles(), []);
  const initialRole = useMemo(() => resolveDefaultRole(defaultRole), [defaultRole]);

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [emailConfigured, setEmailConfigured] = useState<boolean | null>(null);

  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [role, setRole] = useState<UserRole>(initialRole);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  const emailInvalid = touched && !isPlausibleEmail(email);
  const selectedRole = roles.find((r) => r.role === role) ?? roles[0];

  const reset = useCallback(() => {
    setEmail(''); setFirstName(''); setRole(initialRole); setTouched(false);
    setError(null); setCopied(false); setSending(false);
  }, [initialRole]);

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the trigger for keyboard users.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  // Preflight on open: may this user invite? Is email configured?
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase({ kind: 'checking' });
    void (async () => {
      const res = await api.get<PreflightResponse>('/api/team/invitations');
      if (cancelled) return;
      if (res.error) {
        if (res.status === 403 || res.status === 401) {
          setPhase({ kind: 'not_allowed', message: inviteErrorMessage(403, res.error.code) });
          return;
        }
        // Unknown preflight failure: still let them try; the POST reports truthfully.
        setEmailConfigured(null);
        setPhase({ kind: 'form' });
        return;
      }
      if (res.data?.available === false) {
        setPhase({ kind: 'not_allowed', message: inviteErrorMessage(503, 'INVITATIONS_UNAVAILABLE') });
        return;
      }
      setEmailConfigured(typeof res.data?.emailConfigured === 'boolean' ? res.data.emailConfigured : null);
      setPhase({ kind: 'form' });
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Focus the first field once the form is shown.
  useEffect(() => {
    if (open && phase.kind === 'form') requestAnimationFrame(() => emailRef.current?.focus());
  }, [open, phase.kind]);

  const onSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!isPlausibleEmail(email)) { emailRef.current?.focus(); return; }
    setSending(true);
    setError(null);
    const body = buildInviteRequest({ email, firstName, role, companyId, context });
    const res = await api.post<CreateResponse>('/api/team/invitations', body);
    setSending(false);
    if (res.error || !res.data) {
      const msg = inviteErrorMessage(res.status, res.error?.code, res.error?.error);
      if (res.status === 403 || res.status === 503) setPhase({ kind: 'not_allowed', message: msg });
      else setError(msg);
      return;
    }
    if (res.data.emailSent) {
      setPhase({ kind: 'sent', email: body.email });
    } else {
      setPhase({
        kind: 'saved_not_emailed',
        email: body.email,
        acceptUrl: res.data.acceptUrl ?? null,
        reason: res.data.emailError || 'Invite saved — but the email couldn’t be sent.',
      });
    }
  }, [email, firstName, role, companyId, context]);

  const copyLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, []);

  // Esc closes; Tab stays inside the dialog.
  const onDialogKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [close]);

  const openDialog = () => { reset(); setOpen(true); };

  const trigger = compact ? (
    <button
      ref={triggerRef}
      type="button"
      onClick={openDialog}
      aria-haspopup="dialog"
      className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-brand-400 hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
    >
      <UserPlus size={13} aria-hidden /> Invite my bookkeeper to finish this
    </button>
  ) : (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-surface-900 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-300">
          <UserPlus size={17} aria-hidden />
        </div>
        <div>
          <p className="text-sm font-medium text-ink-hi">Not the right person for this?</p>
          <p className="mt-0.5 text-xs text-slate-400">Invite your bookkeeper or accountant — they&apos;ll get an email with a link straight to <span className="text-slate-300">{context}</span>.</p>
        </div>
      </div>
      <button
        ref={triggerRef}
        type="button"
        onClick={openDialog}
        aria-haspopup="dialog"
        className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-surface-950 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-brand-500/40 hover:text-ink-hi focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
      >
        Invite my bookkeeper
      </button>
    </div>
  );

  return (
    <>
      {trigger}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${ids}-title`}
            aria-describedby={`${ids}-desc`}
            onKeyDown={onDialogKeyDown}
            className="w-full max-w-md rounded-2xl border border-slate-800 bg-surface-900 p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id={`${ids}-title`} className="text-base font-semibold text-ink-hi">Invite someone to finish this</h2>
                <p id={`${ids}-desc`} className="mt-1 text-xs text-slate-400">
                  They&apos;ll be asked to finish: <span className="text-slate-200">{context}</span>
                </p>
              </div>
              <button type="button" onClick={close} aria-label="Close" className="rounded p-1 text-slate-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">
                <X size={16} aria-hidden />
              </button>
            </div>

            <div className="mt-4">
              {phase.kind === 'checking' && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400" role="status" aria-live="polite">
                  <Loader2 size={16} className="animate-spin text-brand-400" aria-hidden /> Checking…
                </div>
              )}

              {phase.kind === 'not_allowed' && (
                <div className="space-y-4">
                  <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-3 text-sm text-amber-200" role="alert">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {phase.message}
                  </div>
                  <div className="flex justify-end">
                    <button type="button" onClick={close} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:text-ink-hi focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">Close</button>
                  </div>
                </div>
              )}

              {phase.kind === 'form' && (
                <form onSubmit={onSubmit} noValidate className="space-y-3">
                  {emailConfigured === false && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200" role="note">
                      <MailWarning size={14} className="mt-0.5 shrink-0" aria-hidden />
                      Email isn&apos;t set up for this workspace yet, so we&apos;ll save the invite and give you a link to send yourself.
                    </div>
                  )}

                  <div>
                    <label htmlFor={`${ids}-email`} className="mb-1 block text-2xs font-medium uppercase tracking-wider text-slate-500">Email</label>
                    <input
                      ref={emailRef}
                      id={`${ids}-email`}
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onBlur={() => setTouched(true)}
                      aria-invalid={emailInvalid || undefined}
                      aria-describedby={emailInvalid ? `${ids}-email-err` : undefined}
                      placeholder="bookkeeper@firm.com"
                      className={clsx(fieldCls, emailInvalid && 'border-red-500/60')}
                    />
                    {emailInvalid && <p id={`${ids}-email-err`} className="mt-1 text-2xs text-red-400">Enter a valid email address.</p>}
                  </div>

                  <div>
                    <label htmlFor={`${ids}-first`} className="mb-1 block text-2xs font-medium uppercase tracking-wider text-slate-500">First name <span className="normal-case tracking-normal text-slate-600">(optional)</span></label>
                    <input id={`${ids}-first`} type="text" autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Pat" className={fieldCls} />
                  </div>

                  <div>
                    <label htmlFor={`${ids}-role`} className="mb-1 block text-2xs font-medium uppercase tracking-wider text-slate-500">Role</label>
                    <select id={`${ids}-role`} value={role} onChange={(e) => setRole(e.target.value as UserRole)} aria-describedby={`${ids}-role-hint`} className={fieldCls}>
                      {roles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                    </select>
                    <p id={`${ids}-role-hint`} className="mt-1 text-2xs text-slate-500">
                      {selectedRole?.hint} Only roles that can run setup are listed.
                    </p>
                  </div>

                  {error && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300" role="alert">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden /> {error}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button type="button" onClick={close} className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:text-ink-hi focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">Cancel</button>
                    <button
                      type="submit"
                      disabled={sending}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                    >
                      {sending ? <><Loader2 size={13} className="animate-spin" aria-hidden /> Sending…</> : <>Send invite</>}
                    </button>
                  </div>
                </form>
              )}

              {phase.kind === 'sent' && (
                <div className="space-y-4" role="status" aria-live="polite">
                  <div className="flex items-start gap-2 rounded-xl border border-brand-500/30 bg-brand-500/[0.06] px-3.5 py-3 text-sm text-slate-200">
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-brand-400" aria-hidden />
                    <span>Invite emailed to <span className="font-mono text-ink-hi">{phase.email}</span>. They&apos;ll sign up from the link and land right where they need to be.</span>
                  </div>
                  <div className="flex justify-end">
                    <button type="button" onClick={close} className="rounded-lg bg-brand-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">Done</button>
                  </div>
                </div>
              )}

              {phase.kind === 'saved_not_emailed' && (
                <div className="space-y-3" role="status" aria-live="polite">
                  <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-3 text-sm text-amber-200">
                    <MailWarning size={16} className="mt-0.5 shrink-0" aria-hidden />
                    <span>{phase.reason}</span>
                  </div>
                  {phase.acceptUrl && (
                    <div>
                      <label htmlFor={`${ids}-link`} className="mb-1 block text-2xs font-medium uppercase tracking-wider text-slate-500">Invite link for {phase.email}</label>
                      <div className="flex gap-2">
                        <input id={`${ids}-link`} readOnly value={phase.acceptUrl} onFocus={(e) => e.currentTarget.select()} className={clsx(fieldCls, 'font-mono text-xs')} />
                        <button
                          type="button"
                          onClick={() => void copyLink(phase.acceptUrl as string)}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs text-slate-200 hover:border-brand-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
                        >
                          {copied ? <><Check size={13} className="text-brand-400" aria-hidden /> Copied</> : <><Copy size={13} aria-hidden /> Copy</>}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button type="button" onClick={close} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:text-ink-hi focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60">Done</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const fieldCls =
  'w-full rounded-lg border border-slate-700 bg-surface-950 px-3 py-2 text-sm text-ink-hi placeholder:text-slate-600 focus:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40';
