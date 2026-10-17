'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useClerk, useUser } from '@clerk/nextjs';
import { Building2, Loader2, AlertCircle, ArrowRight, ChevronDown, Globe2, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { deriveOrgSlug } from '@/lib/onboarding/org-setup';

/**
 * /setup — create your organization. That's all (FPB-onboarding B5).
 *
 * One short form: the organization's name and your name. Timezone is detected from
 * the browser; the URL slug is derived automatically (editable under "Advanced").
 * Everything else — companies, chart of accounts, opening balances, bank, team —
 * happens in the ONE onboarding wizard this hands off to. Departments and the
 * internal-charge method are set later in Settings.
 *
 * An existing member whose session simply has no active organization is offered a
 * one-click "continue to <org>" instead of creating a duplicate.
 */

interface ActivatableOrg { clerkOrgId: string; orgId: string; name: string }
interface SetupState {
  hasOrg: boolean;
  orgName?: string;
  activatable?: ActivatableOrg[];
}
interface CreateResponse {
  success?: boolean;
  clerkOrgId?: string;
  activate?: boolean;
  next?: string;
  error?: string;
  details?: string[];
}

const inputCls =
  'w-full px-3 py-2.5 bg-surface-900 border border-slate-700 rounded-lg text-sm text-ink-hi placeholder:text-slate-600 focus:outline-none focus:border-brand-500/60 focus:ring-1 focus:ring-brand-500/20';
const labelCls = 'block text-xs text-slate-400 mb-1.5 font-medium';

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
}

export default function SetupPage() {
  const { setActive } = useClerk();
  const { user, isLoaded: userLoaded } = useUser();

  const [state, setState] = useState<SetupState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [yourName, setYourName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [timezone] = useState(detectTimezone);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch('/api/setup');
      if (!res.ok) throw new Error('setup state unavailable');
      const d = (await res.json()) as SetupState;
      if (d.hasOrg) {
        window.location.replace('/onboarding');
        return;
      }
      setState(d);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Prefill "your name" from the sign-in profile (only until the user edits it).
  useEffect(() => {
    if (!userLoaded || nameTouched) return;
    const full = [user?.firstName, user?.lastName].filter(Boolean).join(' ');
    if (full) setYourName(full);
  }, [userLoaded, user, nameTouched]);

  const derivedSlug = useMemo(() => (orgName.trim() ? deriveOrgSlug(orgName) : ''), [orgName]);
  const effectiveSlug = slugTouched ? slug : derivedSlug;
  const slugValid = !effectiveSlug || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(effectiveSlug);
  const valid = orgName.trim().length > 0 && slugValid;

  const activateAndGo = useCallback(async (clerkOrgId: string, next: string) => {
    // Make the org active in the Clerk session so every request carries its claim,
    // then hard-navigate so the app shell re-initializes with the new tenant.
    await setActive({ organization: clerkOrgId });
    window.location.assign(next);
  }, [setActive]);

  const submit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step: 'organization',
          name: orgName.trim(),
          your_name: yourName.trim() || undefined,
          slug: effectiveSlug || undefined,
          timezone,
        }),
      });
      const d = (await res.json().catch(() => ({}))) as CreateResponse;
      if (!res.ok) {
        setError(d.details?.join(' · ') || d.error || 'Could not create your organization.');
        setSubmitting(false);
        return;
      }
      if (d.activate && d.clerkOrgId) {
        await activateAndGo(d.clerkOrgId, d.next ?? '/onboarding');
        return;
      }
      window.location.assign(d.next ?? '/onboarding');
    } catch {
      setError('Network error — check your connection and try again.');
      setSubmitting(false);
    }
  }, [valid, submitting, orgName, yourName, effectiveSlug, timezone, activateAndGo]);

  // ── Loading / error ─────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="card p-8 text-center space-y-3" role="alert">
        <AlertCircle className="w-7 h-7 mx-auto text-danger-fg" />
        <p className="text-sm text-slate-300">We couldn&apos;t check your account setup.</p>
        <button onClick={() => void load()} className="inline-flex items-center gap-1.5 text-sm text-brand-400 hover:text-brand-300">
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex items-center justify-center py-24" aria-busy="true">
        <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  const activatable = state.activatable ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink-hi tracking-tight">Welcome to MeritBooks</h1>
        <p className="text-sm text-slate-400 mt-1.5">
          {activatable.length > 0
            ? 'You already belong to an organization. Pick up where you left off.'
            : 'Name your organization and we’ll take you straight to setting up your books. About a minute.'}
        </p>
      </div>

      {activatable.length > 0 && (
        <div className="card p-5 space-y-2">
          {activatable.map((o) => (
            <button
              key={o.clerkOrgId}
              type="button"
              disabled={submitting}
              onClick={() => { setSubmitting(true); void activateAndGo(o.clerkOrgId, '/').catch(() => { setSubmitting(false); setError('Could not switch to that organization.'); }); }}
              className="w-full flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-surface-950 px-4 py-3 text-left hover:border-brand-500/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
            >
              <span className="flex items-center gap-2.5">
                <Building2 size={16} className="text-brand-400" />
                <span className="text-sm text-ink-hi">{o.name}</span>
              </span>
              <span className="flex items-center gap-1 text-xs text-brand-300">Continue <ArrowRight size={13} /></span>
            </button>
          ))}
          {error && <p className="text-xs text-danger-fg" role="alert">{error}</p>}
        </div>
      )}

      {activatable.length === 0 && (
        <form onSubmit={submit} className="card p-6 space-y-5" noValidate>
          <div>
            <label htmlFor="org-name" className={labelCls}>Organization name</label>
            <input
              id="org-name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className={inputCls}
              placeholder="Acme Holdings"
              autoFocus
              maxLength={200}
              required
            />
            <p className="text-[11px] text-slate-600 mt-1">
              The umbrella over your books. You&apos;ll add each company (its own set of books) in the next step.
            </p>
          </div>

          <div>
            <label htmlFor="your-name" className={labelCls}>Your name</label>
            <input
              id="your-name"
              value={yourName}
              onChange={(e) => { setNameTouched(true); setYourName(e.target.value); }}
              className={inputCls}
              placeholder="Jane Doe"
              maxLength={200}
              autoComplete="name"
            />
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Globe2 size={13} className="text-slate-500" />
            Times shown in <span className="text-slate-300 font-mono">{timezone}</span>
            <span className="text-slate-600">(detected from your browser — change any time in Settings)</span>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              <ChevronDown size={13} className={clsx('transition-transform', showAdvanced && 'rotate-180')} /> Advanced
            </button>
            {showAdvanced && (
              <div className="mt-3">
                <label htmlFor="org-slug" className={labelCls}>Organization ID (URL slug)</label>
                <input
                  id="org-slug"
                  value={effectiveSlug}
                  onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50)); }}
                  className={clsx(inputCls, 'font-mono', !slugValid && 'border-danger/60')}
                  placeholder="acme-holdings"
                  aria-invalid={!slugValid}
                />
                <p className={clsx('text-[11px] mt-1', slugValid ? 'text-slate-600' : 'text-danger-fg')}>
                  {slugValid ? 'Lowercase letters, numbers and dashes. We make it unique automatically.' : 'Use lowercase letters, numbers and single dashes.'}
                </p>
              </div>
            )}
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-danger/10 border border-danger/30 text-sm text-danger-fg flex items-start gap-2" role="alert">
              <AlertCircle size={15} className="shrink-0 mt-0.5" /> {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!valid || submitting}
            className={clsx('w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
              !valid || submitting ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-brand-500 text-white hover:bg-brand-400')}
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
            {submitting ? 'Creating your organization…' : 'Continue to set up your books'}
          </button>
        </form>
      )}
    </div>
  );
}
