'use client';

/**
 * Dashboard dialogs: Save my dashboard · Publish as a role default (administrators: lock level
 * + publish mode, IA M-8) · Add to a report pack. Verbs on buttons; the toast repeats the verb.
 */
import { useEffect, useState } from 'react';
import { Button, Dialog, Field, InlineNotice, Input, Radio, Select, Textarea, api, toast, useQuery } from '@meritbooks/merit-ui';
import type { DashboardCard, DashboardSettings, LockLevel, PackKey, PublishMode } from '@/lib/fpna/workspace/types';
import s from './fpna.module.css';

const ROLES: Array<{ value: string; label: string }> = [
  { value: '*', label: 'Every role (the fallback default)' },
  { value: 'company_admin', label: 'Owner / company admin' },
  { value: 'cfo', label: 'CFO' },
  { value: 'merit_controller', label: 'Controller' },
  { value: 'assistant_cfo', label: 'Assistant CFO' },
  { value: 'accounting_manager', label: 'Accounting manager' },
  { value: 'accounting_specialist', label: 'Accounting specialist' },
  { value: 'business_user', label: 'Business user' },
];

const LOCKS: Array<{ value: LockLevel; label: string; help: string }> = [
  { value: 'unlocked', label: 'Unlocked', help: 'People start from this and may change anything on their own copy.' },
  { value: 'add_move', label: 'Add and move', help: 'People may add cards and reorder, but every card you publish stays.' },
  { value: 'locked', label: 'Locked', help: 'Everyone in the role sees exactly this dashboard.' },
];

export interface DashboardDraft {
  id: string | null;
  name: string;
  packKey: PackKey;
  cards: DashboardCard[];
  settings: DashboardSettings;
}

export function SaveDialog({ open, onClose, draft, onSaved }: { open: boolean; onClose: () => void; draft: DashboardDraft; onSaved: (id: string) => void }) {
  const [name, setName] = useState(draft.name);
  const [asNew, setAsNew] = useState(!draft.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(draft.id ? draft.name : `My ${draft.name}`.slice(0, 80));
      setAsNew(!draft.id);
      setError(null);
    }
  }, [open, draft.id, draft.name]);
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await api.post<{ dashboard: { id: string } }>('/api/fpna/workspace/dashboards', { ...(asNew ? {} : { id: draft.id }), name: name.trim(), packKey: draft.packKey, cards: draft.cards, settings: draft.settings });
    setBusy(false);
    if (r.error || !r.data) {
      setError(r.error?.error ?? 'Could not save.');
      return;
    }
    toast(`Saved “${name.trim()}”`);
    onSaved(r.data.dashboard.id);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save my dashboard"
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || name.trim().length === 0}>{busy ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <div className={s.formGrid}>
        <Field label="Name" help="Only you see your dashboards.">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        {draft.id && (
          <div role="radiogroup" aria-label="Save as">
            <Radio name="saveas" label="Update this dashboard" checked={!asNew} onChange={() => setAsNew(false)} />
            <Radio name="saveas" label="Save as a new dashboard" checked={asNew} onChange={() => setAsNew(true)} />
          </div>
        )}
        <p className={s.muted}>{draft.cards.length} cards · {draft.settings.basis.toUpperCase()} · compared with {draft.settings.comparison.replace('_', ' ')} · {draft.settings.sparkline}-month trend</p>
        {error && <InlineNotice tone="neg" title="Not saved.">{error}</InlineNotice>}
      </div>
    </Dialog>
  );
}

export function PublishDialog({ open, onClose, draft, onPublished }: { open: boolean; onClose: () => void; draft: DashboardDraft; onPublished: () => void }) {
  const [role, setRole] = useState('*');
  const [name, setName] = useState(draft.name);
  const [lock, setLock] = useState<LockLevel>('add_move');
  const [mode, setMode] = useState<PublishMode>('new_users');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(draft.name);
      setError(null);
    }
  }, [open, draft.name]);
  const publish = async () => {
    setBusy(true);
    setError(null);
    const r = await api.post('/api/fpna/workspace/dashboards/publish', {
      roleKey: role === '*' ? null : role,
      name: name.trim(),
      packKey: draft.packKey,
      cards: draft.cards,
      settings: draft.settings,
      lockLevel: lock,
      publishMode: mode,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (r.error) {
      setError(r.status === 403 ? 'Publishing role defaults needs accounting-settings edit rights.' : r.error.error);
      return;
    }
    toast(`Published “${name.trim()}” for ${ROLES.find((x) => x.value === role)?.label ?? role}`);
    onPublished();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={560}
      title="Publish as a role default"
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void publish()} disabled={busy || name.trim().length === 0}>{busy ? 'Publishing…' : 'Publish'}</Button>
        </>
      }
      footNote="Each publish is kept as a new version with who published it and when."
    >
      <div className={s.formGrid}>
        <Field label="For">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div role="radiogroup" aria-label="Lock level">
          {LOCKS.map((l) => (
            <div key={l.value}>
              <Radio name="lock" label={l.label} checked={lock === l.value} onChange={() => setLock(l.value)} />
              <p className={s.muted} style={{ margin: '0 0 8px 32px' }}>{l.help}</p>
            </div>
          ))}
        </div>
        <div role="radiogroup" aria-label="Who gets it">
          <Radio name="mode" label="New people, and anyone without their own copy" checked={mode === 'new_users'} onChange={() => setMode('new_users')} />
          <Radio name="mode" label="Everyone — replace copies people saved before now" checked={mode === 'override'} onChange={() => setMode('override')} />
        </div>
        <Field label="Note (optional)" help="Shown to people under the dashboard name.">
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <InlineNotice tone="neg" title="Not published.">{error}</InlineNotice>}
      </div>
    </Dialog>
  );
}

interface PackRow {
  id: string;
  name: string;
  schedule_cadence: string;
  schedule_active: boolean;
}

export function PackDialog({ open, onClose, draft, dashboardRef, companies, weighting }: { open: boolean; onClose: () => void; draft: DashboardDraft; dashboardRef: string; companies: string[]; weighting: 'full' | 'ownership' }) {
  const q = useQuery<{ available: boolean; packs: PackRow[] }>(open ? '/api/reports/packs' : null, undefined, { scope: false });
  const [packId, setPackId] = useState<string>('new');
  const [newName, setNewName] = useState('Monthly management pack');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    const r = await api.post<{ pack: { id: string; name: string } }>('/api/fpna/workspace/add-to-pack', {
      dashboardRef,
      name: draft.name,
      packKey: draft.packKey,
      cards: draft.cards,
      settings: draft.settings,
      companies,
      weighting,
      ...(packId === 'new' ? { newPackName: newName.trim() } : { packId }),
    });
    setBusy(false);
    if (r.error || !r.data) {
      setError(r.status === 403 ? 'Adding to a pack needs report export rights.' : r.error?.error ?? 'Could not add it.');
      return;
    }
    toast(`Added “${draft.name}” to ${r.data.pack.name}`);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add to a report pack"
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void add()} disabled={busy || (packId === 'new' && newName.trim().length === 0)}>{busy ? 'Adding…' : 'Add to pack'}</Button>
        </>
      }
      footNote="The pack recomputes this dashboard for the last complete month each time it is sent, showing released months only. Sending is set up on the pack."
    >
      <div className={s.formGrid}>
        {q.data && !q.data.available && <InlineNotice tone="warn" title="Report packs aren’t set up in this workspace yet." />}
        <Field label="Pack">
          <Select value={packId} onChange={(e) => setPackId(e.target.value)}>
            <option value="new">A new pack…</option>
            {(q.data?.packs ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.schedule_active ? ` (sent ${p.schedule_cadence.toLowerCase()})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        {packId === 'new' && (
          <Field label="New pack name" help="It starts with last month’s P&L and balance sheet, plus this dashboard.">
            <Input value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} />
          </Field>
        )}
        {error && <InlineNotice tone="neg" title="Not added.">{error}</InlineNotice>}
      </div>
    </Dialog>
  );
}
