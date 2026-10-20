'use client';

/**
 * Account role map (FPB §3.0). Every role the pack posts to, grouped, required
 * first, with its fallback ("if blank, uses …"), the account types it accepts, and
 * whether it's mapped directly or resolved automatically (standard account number or
 * fallback). Changed rows save in one batch: PUT /api/dealer/settings/roles.
 */

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import type { Readiness } from '@/lib/dealer/service/settings';
import { ROLE_SPEC, type DealerRole } from '@/lib/dealer/roles';
import { ROLE_GROUPS, allowedTypesLabel } from '@/lib/dealer/ui/settings-form';
import { dealerMutate, nameOf, useNames, type DealerApiError } from '../../_lib/use-dealer';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel, Pill, Section } from '../../_components/ui';

type RoleState = Readiness['roles'][number];

export function AccountsSection({ readiness, locationId, canEdit, onSaved }: { readiness: Readiness; locationId: string; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<Partial<Record<DealerRole, string | null>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const byRole = useMemo(() => new Map(readiness.roles.map((r) => [r.roleKey as DealerRole, r])), [readiness.roles]);
  const resolvedNames = useNames('accounts', readiness.roles.map((r) => r.accountId));
  const missing = new Set(readiness.missing.filter((m) => m.startsWith('ROLE:')).map((m) => m.slice(5)));
  const changed = Object.keys(draft) as DealerRole[];

  async function save() {
    setBusy(true);
    setError(null);
    const res = await dealerMutate<Readiness>(
      'put',
      '/api/dealer/settings/roles',
      locationId,
      { mappings: changed.map((roleKey) => ({ roleKey, accountId: draft[roleKey] ?? null })) },
      `Saved ${changed.length} account choice${changed.length === 1 ? '' : 's'}`,
    );
    setBusy(false);
    if (res.error) return setError(res.error);
    setDraft({});
    await onSaved();
  }

  return (
    <Section
      id="accounts"
      className="scroll-mt-6"
      title="Accounts"
      description="Which of this client’s accounts each dealer posting uses. Accounts are chosen by role, never by number."
      actions={
        changed.length > 0 ? (
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setDraft({})} disabled={busy}>
              Discard
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Save {changed.length} change{changed.length === 1 ? '' : 's'}
            </button>
          </>
        ) : null
      }
    >
      {error && (
        <div className="px-5 pt-4">
          <ErrorPanel error={error} compact />
        </div>
      )}
      {ROLE_GROUPS.map((g) => {
        const roles = [...g.roles].filter((r) => byRole.has(r)).sort((a, b) => Number(ROLE_SPEC[b].required) - Number(ROLE_SPEC[a].required));
        return (
          <div key={g.title} className="border-b border-slate-800 last:border-b-0">
            <h3 className="bg-surface-950/60 px-5 py-2 text-caption uppercase tracking-caps text-slate-500">{g.title}</h3>
            <ul className="divide-y divide-slate-800/50">
              {roles.map((role) => (
                <RoleRow
                  key={role}
                  role={role}
                  state={byRole.get(role)!}
                  draft={role in draft ? draft[role] ?? null : undefined}
                  missing={missing.has(role)}
                  resolvedLabel={nameOf(resolvedNames, byRole.get(role)?.accountId)}
                  disabled={busy || !canEdit}
                  onChange={(v) =>
                    setDraft((d) => {
                      const next = { ...d };
                      const st = byRole.get(role)!;
                      const original = st.mappedDirectly ? st.accountId : null;
                      if (v === original) delete next[role];
                      else next[role] = v;
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          </div>
        );
      })}
    </Section>
  );
}

function RoleRow({
  role,
  state,
  draft,
  missing,
  resolvedLabel,
  disabled,
  onChange,
}: {
  role: DealerRole;
  state: RoleState;
  draft: string | null | undefined;
  missing: boolean;
  resolvedLabel: string;
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const spec = ROLE_SPEC[role];
  const value = draft !== undefined ? draft : state.mappedDirectly ? state.accountId : null;
  const fallback = spec.fallback ? ROLE_SPEC[spec.fallback].label : null;
  const dirty = draft !== undefined;
  return (
    <li id={`role-${role}`} className={clsx('grid scroll-mt-24 gap-3 px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center', missing && 'bg-amber-500/[0.03]')}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-100">{spec.label}</span>
          {spec.required ? <Pill label="Required" tone={missing ? 'warning' : 'neutral'} dot={missing} /> : <span className="text-2xs text-slate-500">Optional</span>}
          {dirty && <span className="text-2xs text-amber-300">Unsaved</span>}
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          Must be {allowedTypesLabel(spec.allowedTypes)}.
          {fallback && ` If left blank, uses ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}.`}
        </p>
        {!dirty && (
          <p className="mt-0.5 text-xs">
            {state.mappedDirectly ? (
              <span className="text-emerald-400/90">Chosen for this client</span>
            ) : state.accountId ? (
              <span className="text-slate-400">
                Resolved automatically to <span className="text-slate-200">{resolvedLabel}</span> (standard account{fallback ? ' or fallback' : ''})
              </span>
            ) : missing ? (
              <span className="text-amber-300">No account yet — choose one to switch the pack on</span>
            ) : (
              <span className="text-slate-500">Not set</span>
            )}
          </p>
        )}
      </div>
      <LookupPicker
        kind="accounts"
        types={[...spec.allowedTypes]}
        value={value}
        onChange={(v) => onChange(v)}
        disabled={disabled}
        invalid={missing && !value}
        aria-label={`Account for ${spec.label}`}
        placeholder={state.accountId && !state.mappedDirectly ? `Using ${resolvedLabel}` : 'Choose an account…'}
      />
    </li>
  );
}
