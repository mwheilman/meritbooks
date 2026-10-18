'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  Loader2,
  AlertCircle,
  Plus,
  X,
  Check,
  Paperclip,
  Play,
  ThumbsUp,
  Ban,
  RotateCcw,
  Trash2,
  FileText,
  Clock,
  ClipboardList,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import {
  PBC_STATUSES,
  PBC_STATUS_LABEL,
  PBC_CATEGORIES,
  PBC_CATEGORY_LABEL,
  nextStatuses,
  type PbcStatus,
  type PbcCategory,
} from '@/lib/audit-access/pbc';

// ── API shapes ────────────────────────────────────────────────────────────────────
interface PbcItem {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  periodLabel: string | null;
  status: PbcStatus;
  requestedByName: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  dueDate: string | null;
  documentId: string | null;
  documentName: string | null;
  fulfilledAt: string | null;
  notes: string | null;
  createdAt: string;
  overdue: boolean;
}
interface Assignee {
  id: string;
  name: string;
}
interface PbcCaps {
  view: boolean;
  create: boolean;
  fulfill: boolean;
  accept: boolean;
}
interface PbcResponse {
  data: PbcItem[];
  assignees: Assignee[];
  can: PbcCaps;
}

const STATUS_STYLE: Record<PbcStatus, string> = {
  REQUESTED: 'bg-slate-700/50 text-slate-300',
  IN_PROGRESS: 'bg-blue-500/15 text-blue-300',
  PROVIDED: 'bg-amber-500/15 text-amber-300',
  ACCEPTED: 'bg-emerald-500/15 text-emerald-300',
  WAIVED: 'bg-slate-700/40 text-slate-500',
};

type TabKey = 'ALL' | PbcStatus;

export function PbcClient() {
  const [items, setItems] = useState<PbcItem[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [can, setCan] = useState<PbcCaps>({ view: false, create: false, fulfill: false, accept: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [tab, setTab] = useState<TabKey>('ALL');
  const [periodFilter, setPeriodFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Hidden file input, targeted at a specific request id for the attach-and-provide flow.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachTargetRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.get<PbcResponse>('/api/pbc');
    if (res.error) {
      if (res.status === 403) setForbidden(true);
      else setError(res.error.error);
      setLoading(false);
      return;
    }
    const d = res.data!;
    setItems(d.data);
    setAssignees(d.assignees);
    setCan(d.can);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setRowBusy = (id: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { ALL: items.length, REQUESTED: 0, IN_PROGRESS: 0, PROVIDED: 0, ACCEPTED: 0, WAIVED: 0 };
    for (const it of items) c[it.status] += 1;
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (tab !== 'ALL' && it.status !== tab) return false;
      if (periodFilter && (it.periodLabel ?? '').toLowerCase() !== periodFilter.toLowerCase()) return false;
      if (assigneeFilter && it.assignedTo !== assigneeFilter) return false;
      if (overdueOnly && !it.overdue) return false;
      return true;
    });
  }, [items, tab, periodFilter, assigneeFilter, overdueOnly]);

  const periods = useMemo(
    () => Array.from(new Set(items.map((i) => i.periodLabel).filter((v): v is string => !!v))).sort(),
    [items],
  );

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const patch = useCallback(
    async (id: string, body: Record<string, unknown>, successMsg: string) => {
      setRowBusy(id, true);
      const res = await api.patch<{ data: unknown }>(`/api/pbc/${id}`, body);
      setRowBusy(id, false);
      if (res.error) {
        addToast('error', res.error.error || 'Update failed');
        return false;
      }
      addToast('success', successMsg);
      await load();
      return true;
    },
    [load],
  );

  const removeItem = useCallback(
    async (id: string) => {
      if (!confirm('Delete this request? This cannot be undone.')) return;
      setRowBusy(id, true);
      const res = await api.delete(`/api/pbc/${id}`);
      setRowBusy(id, false);
      if (res.error) {
        addToast('error', res.error.error || 'Delete failed');
        return;
      }
      addToast('success', 'Request deleted');
      await load();
    },
    [load],
  );

  const startAttach = (id: string) => {
    attachTargetRef.current = id;
    fileInputRef.current?.click();
  };

  const onFilePicked = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const id = attachTargetRef.current;
      e.target.value = ''; // reset so the same file can be re-picked
      attachTargetRef.current = null;
      if (!file || !id) return;

      setRowBusy(id, true);
      // 1. Upload into the shared documents bucket, linked to this PBC request.
      const form = new FormData();
      form.append('file', file);
      form.append('entity_type', 'pbc_request');
      form.append('entity_id', id);
      form.append('doc_type', 'OTHER');
      const upRes = await fetch('/api/documents', { method: 'POST', body: form });
      if (!upRes.ok) {
        setRowBusy(id, false);
        const j = await upRes.json().catch(() => ({}));
        addToast('error', j.error || 'Upload failed');
        return;
      }
      const upJson = (await upRes.json()) as { document?: { id?: string } };
      const documentId = upJson.document?.id;
      if (!documentId) {
        setRowBusy(id, false);
        addToast('error', 'Upload did not return a document');
        return;
      }
      setRowBusy(id, false);
      // 2. Attach the doc + mark the request PROVIDED.
      await patch(id, { documentId, status: 'PROVIDED' }, 'Document attached — marked provided');
    },
    [patch],
  );

  const viewDoc = useCallback(async (documentId: string) => {
    const res = await api.get<{ url?: string; signedUrl?: string }>(`/api/documents/${documentId}/signed-url?download=0`);
    if (res.error) {
      addToast('error', res.error.error || 'Could not open document');
      return;
    }
    const url = res.data?.url ?? res.data?.signedUrl;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else addToast('error', 'No document URL returned');
  }, []);

  // ── Render states ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading audit requests…
      </div>
    );
  }
  if (forbidden) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-slate-800 bg-surface-900 p-8 text-center">
        <ClipboardList className="mx-auto mb-3 h-8 w-8 text-slate-500" />
        <h3 className="text-lg font-semibold text-white">No access to audit requests</h3>
        <p className="mt-2 text-sm text-slate-400">
          The PBC list is available to compliance / audit roles. Ask an administrator for access.
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300">
        <AlertCircle className="h-4 w-4" /> {error}
        <button onClick={() => void load()} className="ml-auto rounded bg-red-900/40 px-2 py-1 text-xs hover:bg-red-900/60">
          Retry
        </button>
      </div>
    );
  }

  const tabs: TabKey[] = ['ALL', ...PBC_STATUSES];

  return (
    <div className="space-y-4">
      <input ref={fileInputRef} type="file" className="hidden" onChange={onFilePicked} />

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                tab === t ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-400 hover:bg-surface-900',
              )}
            >
              {t === 'ALL' ? 'All' : PBC_STATUS_LABEL[t]}
              <span className="ml-1.5 tabular-nums text-slate-500">{counts[t]}</span>
            </button>
          ))}
        </div>
        {can.create && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600"
          >
            <Plus className="h-4 w-4" /> New request
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select
          value={periodFilter}
          onChange={(e) => setPeriodFilter(e.target.value)}
          className="rounded-lg border border-slate-700 bg-surface-900 px-2.5 py-1.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
        >
          <option value="">All periods</option>
          {periods.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={assigneeFilter}
          onChange={(e) => setAssigneeFilter(e.target.value)}
          className="rounded-lg border border-slate-700 bg-surface-900 px-2.5 py-1.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
        >
          <option value="">All assignees</option>
          {assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-600 bg-surface-900 text-emerald-500 focus:ring-emerald-500/50"
          />
          Overdue only
        </label>
        {(periodFilter || assigneeFilter || overdueOnly || tab !== 'ALL') && (
          <button
            type="button"
            onClick={() => {
              setPeriodFilter('');
              setAssigneeFilter('');
              setOverdueOnly(false);
              setTab('ALL');
            }}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Clear
          </button>
        )}
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-surface-900/50 py-16 text-center">
          <ClipboardList className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          <p className="text-sm text-slate-400">
            {items.length === 0 ? 'No audit requests yet.' : 'No requests match these filters.'}
          </p>
          {can.create && items.length === 0 && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600"
            >
              <Plus className="h-4 w-4" /> Raise the first request
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-surface-900">
          {filtered.map((it, i) => (
            <PbcRow
              key={it.id}
              item={it}
              assignees={assignees}
              can={can}
              busy={busy.has(it.id)}
              first={i === 0}
              onStatus={(status) => void patch(it.id, { status }, `Marked ${PBC_STATUS_LABEL[status].toLowerCase()}`)}
              onAssign={(assignedTo) =>
                void patch(it.id, { assignedTo: assignedTo || null }, assignedTo ? 'Assigned' : 'Unassigned')
              }
              onAttach={() => startAttach(it.id)}
              onViewDoc={() => it.documentId && void viewDoc(it.documentId)}
              onDelete={() => void removeItem(it.id)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateRequestModal
          assignees={assignees}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            setShowCreate(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────────
function PbcRow({
  item,
  assignees,
  can,
  busy,
  first,
  onStatus,
  onAssign,
  onAttach,
  onViewDoc,
  onDelete,
}: {
  item: PbcItem;
  assignees: Assignee[];
  can: PbcCaps;
  busy: boolean;
  first: boolean;
  onStatus: (s: PbcStatus) => void;
  onAssign: (id: string) => void;
  onAttach: () => void;
  onViewDoc: () => void;
  onDelete: () => void;
}) {
  const nexts = nextStatuses(item.status);
  return (
    <div className={clsx('flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between', !first && 'border-t border-slate-800')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-white">{item.title}</span>
          <span className={clsx('rounded px-1.5 py-0.5 text-[10px] font-medium uppercase', STATUS_STYLE[item.status])}>
            {PBC_STATUS_LABEL[item.status]}
          </span>
          {item.overdue && (
            <span className="inline-flex items-center gap-0.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
              <Clock className="h-2.5 w-2.5" /> Overdue
            </span>
          )}
        </div>
        {item.description && <p className="mt-1 text-xs text-slate-400">{item.description}</p>}
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
          {item.category && <span>{PBC_CATEGORY_LABEL[item.category as PbcCategory] ?? item.category}</span>}
          {item.periodLabel && <span>Period: {item.periodLabel}</span>}
          {item.dueDate && (
            <span className={clsx('tabular-nums', item.overdue && 'text-red-400')}>Due {item.dueDate}</span>
          )}
          {item.requestedByName && <span>By {item.requestedByName}</span>}
          {item.documentName && (
            <button type="button" onClick={onViewDoc} className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300">
              <FileText className="h-3 w-3" /> {item.documentName}
            </button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        {can.fulfill && (
          <select
            value={item.assignedTo ?? ''}
            disabled={busy}
            onChange={(e) => onAssign(e.target.value)}
            title="Assign a client user"
            className="rounded-lg border border-slate-700 bg-surface-950 px-2 py-1 text-[11px] text-slate-200 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
          >
            <option value="">Unassigned</option>
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}

        {can.fulfill && nexts.includes('IN_PROGRESS') && (
          <ActionBtn icon={<Play className="h-3 w-3" />} label="Start" onClick={() => onStatus('IN_PROGRESS')} busy={busy} />
        )}
        {can.fulfill && nexts.includes('PROVIDED') && (
          <ActionBtn icon={<Paperclip className="h-3 w-3" />} label="Attach & provide" onClick={onAttach} busy={busy} accent />
        )}
        {can.accept && nexts.includes('ACCEPTED') && (
          <ActionBtn icon={<ThumbsUp className="h-3 w-3" />} label="Accept" onClick={() => onStatus('ACCEPTED')} busy={busy} accent />
        )}
        {can.accept && nexts.includes('WAIVED') && (
          <ActionBtn icon={<Ban className="h-3 w-3" />} label="Waive" onClick={() => onStatus('WAIVED')} busy={busy} />
        )}
        {can.accept && (nexts.includes('REQUESTED') || (item.status === 'ACCEPTED' && nexts.includes('IN_PROGRESS'))) && (
          <ActionBtn
            icon={<RotateCcw className="h-3 w-3" />}
            label="Reopen"
            onClick={() => onStatus(item.status === 'ACCEPTED' ? 'IN_PROGRESS' : 'REQUESTED')}
            busy={busy}
          />
        )}
        {can.fulfill && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            title="Delete request"
            className="inline-flex items-center rounded-lg border border-red-900/50 p-1.5 text-red-300 hover:bg-red-950/40 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />}
      </div>
    </div>
  );
}

function ActionBtn({
  icon,
  label,
  onClick,
  busy,
  accent,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  busy: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={clsx(
        'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50',
        accent
          ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
          : 'border border-slate-700 text-slate-300 hover:bg-surface-950',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Create modal ──────────────────────────────────────────────────────────────────
function CreateRequestModal({
  assignees,
  onClose,
  onCreated,
}: {
  assignees: Assignee[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<PbcCategory | ''>('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (title.trim().length < 2) {
      addToast('error', 'Give the request a title (2+ characters).');
      return;
    }
    setSaving(true);
    const res = await api.post<{ data: unknown }>('/api/pbc', {
      title: title.trim(),
      description: description.trim() || undefined,
      category: category || undefined,
      periodLabel: periodLabel.trim() || undefined,
      dueDate: dueDate || undefined,
      assignedTo: assignedTo || undefined,
    });
    setSaving(false);
    if (res.error) {
      addToast('error', res.error.error || 'Could not create request');
      return;
    }
    addToast('success', 'Request raised');
    onCreated();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-surface-950 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">New audit request</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4">
          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. June bank statements — Operating account"
              className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
            />
          </Field>
          <Field label="Description" optional>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What exactly do you need, and why?"
              className="w-full resize-none rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" optional>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as PbcCategory | '')}
                className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="">—</option>
                {PBC_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {PBC_CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Period" optional>
              <input
                value={periodLabel}
                onChange={(e) => setPeriodLabel(e.target.value)}
                placeholder="FY2026 / 2026-06"
                className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due date" optional>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </Field>
            <Field label="Assign to" optional>
              <select
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Unassigned</option>
                {assignees.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-surface-900">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Raise request
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, optional, children }: { label: string; optional?: boolean; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-300">
        {label} {optional && <span className="text-slate-500">(optional)</span>}
      </label>
      {children}
    </div>
  );
}
