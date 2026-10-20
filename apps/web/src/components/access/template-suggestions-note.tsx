'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Undo2, Users, X } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import type { RoleSuggestion } from '@/lib/access-governance/types';
import { AccessDialog } from './dialog';

/**
 * MeritBooks role suggestions (05-RBAC-SPEC §1.7, §6.1, §6.10) — one quiet, dismissible line
 * above the role library: "MeritBooks suggests 2 updates for Accounting manager and Bookkeeper.
 * Optional; nothing changes unless you add them." See suggestions opens a dialog with each
 * change as one sentence, who it reaches, and Add / Skip (with Undo before saving).
 *
 * Added changes go into the role's Proposed changes; "Save and publish" makes them Current now
 * (with a reason). Screen words are Current / Proposed only — no template or version jargon.
 * Renders nothing when there are no suggestions or the caller can't see them.
 */

type Choice = 'add' | 'skip';

export function TemplateSuggestionsNote({ className }: { className?: string }) {
  const [suggestions, setSuggestions] = useState<RoleSuggestion[] | null>(null);
  const [noteVisible, setNoteVisible] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Record<string, Record<string, Choice>>>({});
  const [publishReason, setPublishReason] = useState('');
  const [busy, setBusy] = useState<'save' | 'publish' | 'dismiss' | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<{ data: { suggestions: RoleSuggestion[]; noteVisible: boolean } }>('/api/access/template-updates');
    if (res.error) {
      setLoadError(res.status !== 403); // 403 = not an access admin → stay silent
      setSuggestions([]);
      return;
    }
    setLoadError(false);
    setSuggestions(res.data!.data.suggestions);
    setNoteVisible(res.data!.data.noteVisible);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open_ = useMemo(() => (suggestions ?? []).filter((s) => s.changes.some((c) => c.decision === null)), [suggestions]);
  const pendingCount = open_.reduce((n, s) => n + s.changes.filter((c) => c.decision === null).length, 0);
  const chosenCount = Object.values(choices).reduce((n, m) => n + Object.keys(m).length, 0);
  const anyAdd = Object.values(choices).some((m) => Object.values(m).includes('add'));

  const choose = (updateId: string, changeId: string, c: Choice | null) =>
    setChoices((prev) => {
      const next = { ...prev, [updateId]: { ...(prev[updateId] ?? {}) } };
      if (c) next[updateId][changeId] = c;
      else delete next[updateId][changeId];
      return next;
    });

  const save = async (publish: boolean) => {
    if (publish && !publishReason.trim()) {
      addToast('error', 'Give a reason for publishing.');
      return;
    }
    setBusy(publish ? 'publish' : 'save');
    let failed = 0;
    for (const [updateId, m] of Object.entries(choices)) {
      const add = Object.entries(m).filter(([, v]) => v === 'add').map(([k]) => k);
      const skip = Object.entries(m).filter(([, v]) => v === 'skip').map(([k]) => k);
      if (!add.length && !skip.length) continue;
      const res = await api.post('/api/access/template-updates/decide', {
        updateId,
        add,
        skip,
        publish: publish && add.length > 0,
        reason: publish ? publishReason.trim() : undefined,
      });
      if (res.error) {
        failed++;
        addToast('error', res.error.error || 'Could not save a suggestion');
      }
    }
    setBusy(null);
    if (!failed) {
      addToast('success', publish ? 'Saved and published. The new access is Current.' : 'Saved. Added changes are waiting in Proposed changes.');
      setChoices({});
      setPublishReason('');
      setOpen(false);
    }
    await load();
  };

  const dismiss = async () => {
    setBusy('dismiss');
    const res = await api.post('/api/access/template-updates/dismiss-note', {});
    setBusy(null);
    if (res.error) {
      addToast('error', res.error.error || 'Could not hide the note');
      return;
    }
    setNoteVisible(false);
  };

  if (suggestions === null) return null; // quiet while loading — it's an optional note
  if (loadError) {
    return (
      <p className={clsx('text-xs text-slate-500', className)}>
        MeritBooks suggestions could not be loaded.{' '}
        <button type="button" className="text-emerald-400 hover:text-emerald-300" onClick={() => void load()}>
          Try again
        </button>
      </p>
    );
  }
  if (!open_.length) return null;

  const names = open_.map((s) => s.roleName);
  const who = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

  return (
    <>
      {noteVisible && (
        <div
          className={clsx(
            'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] px-3 py-2 text-sm',
            className,
          )}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-indigo-300" aria-hidden />
          <span className="text-slate-300">
            MeritBooks suggests {pendingCount} update{pendingCount === 1 ? '' : 's'} for {who}.{' '}
            <span className="text-slate-500">Optional; nothing changes unless you add them.</span>
          </span>
          <span className="ml-auto flex items-center gap-1">
            <button type="button" className="btn-ghost btn-sm text-indigo-300" onClick={() => setOpen(true)}>
              See suggestions
            </button>
            <button type="button" className="btn-ghost btn-sm" aria-label="Hide this note" disabled={busy === 'dismiss'} onClick={dismiss}>
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      )}
      {!noteVisible && (
        <button type="button" className={clsx('text-xs text-slate-500 hover:text-slate-300', className)} onClick={() => setOpen(true)}>
          MeritBooks suggestions ({pendingCount})
        </button>
      )}

      <AccessDialog
        open={open}
        wide
        onClose={() => setOpen(false)}
        title="MeritBooks suggestions"
        description="Each suggestion is optional. Add puts it into the role's Proposed changes; Skip leaves the role as it is."
        footer={
          <>
            <span className="mr-auto text-xs text-slate-500">{chosenCount ? `${chosenCount} chosen` : 'Nothing chosen yet'}</span>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
              Close
            </button>
            <button type="button" className="btn-secondary btn-sm" disabled={!chosenCount || busy !== null} onClick={() => save(false)}>
              {busy === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Save
            </button>
            <button type="button" className="btn-primary btn-sm" disabled={!anyAdd || busy !== null} onClick={() => save(true)}>
              {busy === 'publish' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Save and publish
            </button>
          </>
        }
      >
        <div className="space-y-5">
          {open_.map((s) => (
            <section key={s.id} aria-labelledby={`sugg-${s.id}`}>
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 id={`sugg-${s.id}`} className="text-sm font-semibold text-white">
                  {s.roleName}
                </h3>
                <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                  <Users className="h-3 w-3" aria-hidden />
                  {s.holders === 0 ? 'Nobody holds this role yet' : `Reaches ${s.holders} ${s.holders === 1 ? 'person' : 'people'} once Current`}
                </span>
              </div>
              <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                {s.changes
                  .filter((c) => c.decision === null)
                  .map((c) => {
                    const choice = choices[s.id]?.[c.id];
                    return (
                      <li key={c.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                        <span
                          className={clsx(
                            'text-sm',
                            choice === 'skip' ? 'text-slate-500 line-through' : choice === 'add' ? 'text-emerald-300' : 'text-slate-300',
                          )}
                        >
                          {c.sentence}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {choice ? (
                            <button type="button" className="btn-ghost btn-sm" onClick={() => choose(s.id, c.id, null)}>
                              <Undo2 className="h-3.5 w-3.5" aria-hidden /> Undo
                            </button>
                          ) : (
                            <>
                              <button type="button" className="btn-secondary btn-sm" onClick={() => choose(s.id, c.id, 'add')}>
                                Add
                              </button>
                              <button type="button" className="btn-ghost btn-sm" onClick={() => choose(s.id, c.id, 'skip')}>
                                Skip
                              </button>
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
          {anyAdd && (
            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">Reason (needed only to publish now)</span>
              <input
                className="input"
                value={publishReason}
                maxLength={1000}
                onChange={(e) => setPublishReason(e.target.value)}
                placeholder="e.g. Adopt MeritBooks' fix for loan visibility"
              />
            </label>
          )}
        </div>
      </AccessDialog>
    </>
  );
}
