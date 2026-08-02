'use client';

import { useMemo, useState } from 'react';
import {
  Loader2,
  AlertCircle,
  ShieldAlert,
  ShieldCheck,
  Power,
  Sparkles,
  SlidersHorizontal,
  Bot,
  Lock,
  X,
  Save,
} from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader } from '@/components/ui';

// ── Types (mirror GET /api/autonomy) ────────────────────────────────────────────

type AutonomyMode = 'OFF' | 'PROPOSE' | 'AUTO_UNDER_LIMIT';
type AutonomyCategory = 'processing' | 'control';

interface AutonomyFeature {
  feature: string;
  label: string;
  description: string;
  category: AutonomyCategory;
  mode: AutonomyMode;
  materialityLimitCents: number | null;
  isDefault: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface KillSwitchState {
  engaged: boolean;
  engagedBy: string | null;
  engagedAt: string | null;
  reason: string | null;
}

interface AutonomyState {
  killSwitch: KillSwitchState;
  features: AutonomyFeature[];
}

interface AutonomyEnvelope {
  data: AutonomyState;
}

// ── Presentation ────────────────────────────────────────────────────────────────

const MODE_META: Record<AutonomyMode, { label: string; blurb: string; badge: string }> = {
  OFF: {
    label: 'Off',
    blurb: 'The capability is disabled — it will not run.',
    badge: 'bg-slate-600/20 text-slate-400 border border-slate-600/30',
  },
  PROPOSE: {
    label: 'Propose',
    blurb: 'The AI drafts; a human reviews and approves. Nothing auto-applies.',
    badge: 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/30',
  },
  AUTO_UNDER_LIMIT: {
    label: 'Auto under limit',
    blurb: 'High-confidence actions at or under the cap auto-apply; the rest go to review.',
    badge: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30',
  },
};

const CATEGORY_META: Record<AutonomyCategory, { label: string; icon: typeof Bot; blurb: string }> = {
  processing: {
    label: 'Processing & data entry',
    icon: Sparkles,
    blurb: 'AI that eliminates manual bookkeeping — categorization, intake, drafting entries.',
  },
  control: {
    label: 'Financial controls',
    icon: ShieldCheck,
    blurb: 'Continuous controls that detect exceptions and draft remediations for a human.',
  },
};

const MODE_ORDER: AutonomyMode[] = ['OFF', 'PROPOSE', 'AUTO_UNDER_LIMIT'];

// ── Per-feature editor ────────────────────────────────────────────────────────

function FeatureCard({
  feature,
  onSaved,
}: {
  feature: AutonomyFeature;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<AutonomyMode>(feature.mode);
  const [capDollars, setCapDollars] = useState<string>(
    feature.materialityLimitCents != null ? String(feature.materialityLimitCents / 100) : '',
  );
  const [saving, setSaving] = useState(false);

  const meta = MODE_META[feature.mode];

  async function save() {
    setSaving(true);
    let materialityLimitCents: number | null = null;
    if (mode === 'AUTO_UNDER_LIMIT') {
      const dollars = Number(capDollars);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        addToast('error', 'Enter a positive materiality cap to enable auto-under-limit.');
        setSaving(false);
        return;
      }
      materialityLimitCents = Math.round(dollars * 100);
    }
    const res = await api.put<{ data: unknown }>('/api/autonomy', {
      feature: feature.feature,
      mode,
      materialityLimitCents,
    });
    if (res.error) {
      addToast('error', res.error.error || 'Could not save dial');
      setSaving(false);
      return;
    }
    addToast('success', `${feature.label} → ${MODE_META[mode].label}`);
    setSaving(false);
    setEditing(false);
    onSaved();
  }

  function cancel() {
    setMode(feature.mode);
    setCapDollars(
      feature.materialityLimitCents != null ? String(feature.materialityLimitCents / 100) : '',
    );
    setEditing(false);
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-white">{feature.label}</p>
            <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium', meta.badge)}>
              {meta.label}
            </span>
            {feature.mode === 'AUTO_UNDER_LIMIT' && feature.materialityLimitCents != null && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                ≤ {formatMoney(feature.materialityLimitCents)}
              </span>
            )}
            {feature.isDefault && (
              <span className="rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] text-slate-500">
                default
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">{feature.description}</p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/40 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-400"
          >
            <SlidersHorizontal size={13} /> Edit
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-3 border-t border-slate-800 pt-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {MODE_ORDER.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={clsx(
                  'rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                  mode === m
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-white'
                    : 'border-slate-700 bg-slate-800/30 text-slate-400 hover:text-slate-200',
                )}
              >
                <span className="block font-medium">{MODE_META[m].label}</span>
                <span className="mt-0.5 block text-[10px] leading-tight text-slate-500">
                  {MODE_META[m].blurb}
                </span>
              </button>
            ))}
          </div>

          {mode === 'AUTO_UNDER_LIMIT' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Materiality cap (auto-apply only at or under this amount)
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-slate-500">$</span>
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={capDollars}
                  onChange={(e) => setCapDollars(e.target.value)}
                  placeholder="1000"
                  className="w-40 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-emerald-500/50 focus:outline-none"
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Kill-switch confirm dialog ──────────────────────────────────────────────────

function KillSwitchDialog({
  engaging,
  onClose,
  onConfirm,
  busy,
}: {
  engaging: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div
            className={clsx(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              engaging ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400',
            )}
          >
            {engaging ? <ShieldAlert size={20} /> : <ShieldCheck size={20} />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-white">
              {engaging ? 'Engage the kill switch?' : 'Disengage the kill switch?'}
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              {engaging
                ? 'This immediately suspends ALL autonomous AI action across your organization. Nothing the AI proposes will auto-apply — every capability drops to human review — until you disengage it.'
                : 'Autonomous action resumes per each capability’s configured dial. Capabilities set to Auto under limit can auto-apply again.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {engaging && (
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-slate-500">
              Reason (optional — recorded in the audit log)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. investigating an anomalous batch of auto-categorizations"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-emerald-500/50 focus:outline-none"
            />
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-400 hover:text-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason)}
            disabled={busy}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50',
              engaging ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500',
            )}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {engaging ? 'Engage kill switch' : 'Disengage'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Console ─────────────────────────────────────────────────────────────────────

export function AutonomyConsole() {
  const { data, isLoading, error, refetch } = useQuery<AutonomyEnvelope>('/api/autonomy');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toggling, setToggling] = useState(false);

  const state = data?.data;
  const killSwitch = state?.killSwitch;
  const features = useMemo(() => state?.features ?? [], [state]);

  const grouped = useMemo(() => {
    const groups: Record<AutonomyCategory, AutonomyFeature[]> = { processing: [], control: [] };
    for (const f of features) groups[f.category].push(f);
    return groups;
  }, [features]);

  async function toggleKillSwitch(reason: string) {
    if (!killSwitch) return;
    setToggling(true);
    const res = await api.post<{ data: { engaged: boolean } }>('/api/autonomy', {
      engaged: !killSwitch.engaged,
      reason: reason.trim() || undefined,
    });
    if (res.error) {
      addToast('error', res.error.error || 'Could not toggle kill switch');
      setToggling(false);
      return;
    }
    addToast('success', killSwitch.engaged ? 'Kill switch disengaged' : 'Kill switch engaged');
    setToggling(false);
    setDialogOpen(false);
    await refetch();
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    );
  }
  if (error || !state || !killSwitch) {
    return (
      <div className="card p-10 text-center">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-red-400" />
        <p className="text-sm text-red-400">{error || 'Could not load the autonomy control plane.'}</p>
        <button
          onClick={() => refetch()}
          className="mt-4 rounded-lg bg-slate-800 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Autonomy"
        description="Govern what every AI capability may do on its own — and stop it all with one switch."
      />

      {/* Global kill switch */}
      <div
        className={clsx(
          'card border p-5',
          killSwitch.engaged ? 'border-red-500/40 bg-red-500/[0.04]' : 'border-slate-800',
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={clsx(
                'flex h-11 w-11 items-center justify-center rounded-lg',
                killSwitch.engaged ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400',
              )}
            >
              {killSwitch.engaged ? <Lock size={20} /> : <ShieldCheck size={20} />}
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Global kill switch</p>
              <p className="text-xs text-slate-400">
                {killSwitch.engaged
                  ? 'ENGAGED — all autonomous AI action is suspended org-wide.'
                  : 'Disengaged — capabilities act per their configured dial below.'}
              </p>
              {killSwitch.engaged && killSwitch.reason && (
                <p className="mt-1 text-xs text-red-300/80">Reason: {killSwitch.reason}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className={clsx(
              'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors',
              killSwitch.engaged ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500',
            )}
          >
            <Power size={15} />
            {killSwitch.engaged ? 'Disengage' : 'Engage kill switch'}
          </button>
        </div>
      </div>

      {/* Feature dials, grouped */}
      {(['processing', 'control'] as AutonomyCategory[]).map((cat) => {
        const items = grouped[cat];
        if (items.length === 0) return null;
        const cmeta = CATEGORY_META[cat];
        const CIcon = cmeta.icon;
        return (
          <div key={cat} className="space-y-3">
            <div className="flex items-center gap-2">
              <CIcon size={16} className="text-indigo-300" />
              <h2 className="text-sm font-semibold text-white">{cmeta.label}</h2>
              <span className="text-xs text-slate-500">· {cmeta.blurb}</span>
            </div>
            <div
              className={clsx(
                'grid gap-3',
                killSwitch.engaged && 'opacity-60',
              )}
            >
              {items.map((f) => (
                <FeatureCard key={f.feature} feature={f} onSaved={refetch} />
              ))}
            </div>
          </div>
        );
      })}

      {killSwitch.engaged && (
        <p className="text-center text-xs text-slate-500">
          Dials remain editable while the kill switch is engaged, but they take effect only once it is
          disengaged.
        </p>
      )}

      {dialogOpen && (
        <KillSwitchDialog
          engaging={!killSwitch.engaged}
          busy={toggling}
          onClose={() => (toggling ? null : setDialogOpen(false))}
          onConfirm={toggleKillSwitch}
        />
      )}
    </div>
  );
}
