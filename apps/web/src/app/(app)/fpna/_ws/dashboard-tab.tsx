'use client';

/**
 * Dashboard tab (AC-W1/W2/W3): the effective dashboard (yours → your role's default → the
 * every-role default → the pack for your role), a switcher (your dashboards, the published
 * default, the five packs), and Edit — add from the catalog, drag or ←/→ to reorder, resize,
 * remove (required cards stay under an "add and move" lock), trend length — then Save, or
 * Publish as a role default (administrators). The preview recomputes on the server.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, InlineNotice, Select, Seg, Tag, api, toast, useQuery } from '@meritbooks/merit-ui';
import { moveCard } from '@/lib/fpna/workspace/dashboard-model';
import type { CardModel, CardSize, DashboardCard, DashboardListResponse, DashboardViewResponse } from '@/lib/fpna/workspace/types';
import { CardPicker } from './card-picker';
import { PackDialog, PublishDialog, SaveDialog, type DashboardDraft } from './dialogs';
import { MetricCard } from './metric-card';
import { monthName } from './format';
import s from './fpna.module.css';

export interface DashboardTabProps {
  /** View params without tab / dashboard / cards. */
  params: Record<string, string>;
  dashboardRef: string | null;
  setDashboardRef: (ref: string | null) => void;
  onDrill: (card: CardModel) => void;
  /** The current request params (summary / export use the same). */
  onParams: (p: Record<string, string>) => void;
  companies: string[];
  weighting: 'full' | 'ownership';
}

const cardsParam = (cards: DashboardCard[]) => cards.map((c) => `${c.metric}:${c.size}`).join(',');

export function DashboardTab({ params, dashboardRef, setDashboardRef, onDrill, onParams, companies, weighting }: DashboardTabProps) {
  const [reload, setReload] = useState(0);
  const lists = useQuery<DashboardListResponse & { available: boolean }>('/api/fpna/workspace/dashboards', { dashboard: dashboardRef ?? undefined }, { key: String(reload), scope: false });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardCard[] | null>(null);
  const [spark, setSpark] = useState<'12' | '24' | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [dialog, setDialog] = useState<'save' | 'publish' | 'pack' | 'delete' | null>(null);

  const effective = lists.data?.effective ?? null;
  const viewParams = useMemo(() => {
    const p: Record<string, string> = { ...params, tab: 'dashboard' };
    if (dashboardRef) p.dashboard = dashboardRef;
    if (editing && draft) p.cards = cardsParam(draft);
    if (spark) p.spark = spark;
    return p;
  }, [params, dashboardRef, editing, draft, spark]);
  useEffect(() => onParams(viewParams), [viewParams, onParams]);

  const view = useQuery<DashboardViewResponse>(lists.data ? '/api/fpna/workspace/view' : null, viewParams, { scope: false, key: String(reload) });
  const cards = view.data?.cards ?? [];
  const order: DashboardCard[] = editing && draft ? draft : view.data?.dashboard.cards ?? effective?.cards ?? [];
  const byMetric = new Map(cards.map((c) => [c.metric, c]));
  const lock = effective?.lock ?? null;
  const required = new Set(lock?.level === 'add_move' ? lock.requiredMetrics : []);
  const canEdit = effective?.canPersonalize ?? true;

  const startEdit = () => {
    setDraft([...(view.data?.dashboard.cards ?? effective?.cards ?? [])]);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
    setSpark(null);
  };
  const move = (from: number, to: number) => setDraft((d) => (d ? moveCard(d, from, to) : d));
  const remove = (metric: string) => setDraft((d) => (d && d.length > 1 ? d.filter((c) => c.metric !== metric) : d));
  const resize = (metric: string, size: CardSize) => setDraft((d) => (d ? d.map((c) => (c.metric === metric ? { ...c, size } : c)) : d));
  const add = (metric: string) => {
    setDraft((d) => (d && !d.some((c) => c.metric === metric) && d.length < 48 ? [...d, { metric, size: 's' }] : d));
    toast('Added to the dashboard — save to keep it');
  };

  const current: DashboardDraft = {
    id: effective?.source === 'personal' ? effective.id : null,
    name: effective?.name ?? 'Dashboard',
    packKey: effective?.packKey ?? 'custom',
    cards: order,
    settings: { ...(view.data?.dashboard.settings ?? effective?.settings ?? { basis: 'ytd', comparison: 'prior_year', sparkline: 12 }), ...(spark ? { sparkline: Number(spark) as 12 | 24 } : {}) },
  };

  const deletePersonal = async () => {
    if (!effective?.id) return;
    const r = await api.delete(`/api/fpna/workspace/dashboards/${effective.id}`);
    if (r.error) {
      toast.error(r.error.error);
      return;
    }
    toast(`Deleted “${effective.name}”`);
    setDashboardRef(null);
    setReload((n) => n + 1);
  };

  const options = lists.data
    ? [
        ...lists.data.personal.map((p) => ({ value: p.id, label: `${p.name} (yours)` })),
        { value: 'default', label: 'Default for my role' },
        ...(canEdit ? lists.data.packs.map((p) => ({ value: `pack:${p.key}`, label: `${p.name} pack` })) : []),
      ]
    : [];

  return (
    <div>
      <div className={s.dashBar}>
        {lists.data && (
          <Select aria-label="Dashboard" value={dashboardRef ?? effective?.ref ?? 'default'} onChange={(e) => setDashboardRef(e.target.value === 'default' ? 'default' : e.target.value)} disabled={editing}>
            {!options.some((o) => o.value === (dashboardRef ?? effective?.ref)) && effective && <option value={effective.ref}>{effective.name}</option>}
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        )}
        {effective && (
          <span className={s.lockNote}>
            {effective.source === 'personal' ? 'Your dashboard' : effective.source === 'pack' ? `${effective.name} pack` : `Published for ${effective.lock?.roleKey ? 'your role' : 'everyone'}${effective.lock?.publishedAt ? ` · ${effective.lock.publishedAt.slice(0, 10)}` : ''}`}
            {lock && lock.level !== 'unlocked' && <> · <Tag>{lock.level === 'locked' ? 'Locked by your administrator' : 'Required cards set by your administrator'}</Tag></>}
            {effective.overridden && <> · Your saved copy was replaced by a newer published default.</>}
            {lock?.note && <> · {lock.note}</>}
          </span>
        )}
        <span className={s.controlsGrow} />
        {editing ? (
          <>
            <Seg<'12' | '24'> aria-label="Trend length" value={spark ?? (String(current.settings.sparkline) as '12' | '24')} onChange={setSpark} items={[{ value: '12', label: '12 months' }, { value: '24', label: '24 months' }]} />
            <Button onClick={() => setPicker(true)} icon="plus">Add a measure</Button>
            <Button variant="quiet" onClick={cancelEdit}>Cancel</Button>
            {lists.data?.canPublish && <Button onClick={() => setDialog('publish')}>Publish as default…</Button>}
            <Button variant="primary" onClick={() => setDialog('save')}>Save…</Button>
          </>
        ) : (
          <>
            {effective?.source === 'personal' && <Button variant="quiet" onClick={() => setDialog('delete')}>Delete</Button>}
            <Button variant="quiet" onClick={() => setDialog('pack')} disabled={!view.data}>Add to pack…</Button>
            {canEdit ? <Button onClick={startEdit} disabled={!view.data}>Edit dashboard</Button> : <span className={s.muted}>Locked</span>}
          </>
        )}
      </div>
      {editing && <p className={s.muted} style={{ margin: '0 0 12px' }}>Drag cards to reorder, or focus a card and use ← →. Delete removes a card. Figures update as you edit.</p>}

      {lists.error && <InlineNotice tone="neg" title="Couldn’t load your dashboards.">{lists.error} <Button variant="quiet" onClick={() => setReload((n) => n + 1)}>Try again</Button></InlineNotice>}
      {lists.data && !lists.data.available && <InlineNotice className={s.notice} tone="info" title="Saving dashboards needs the latest update.">You are seeing the built-in pack; saving and publishing switch on once the workspace is updated.</InlineNotice>}
      {view.error && <InlineNotice tone="neg" title="Couldn’t compute the dashboard.">{view.error} <Button variant="quiet" onClick={() => void view.refetch()}>Try again</Button></InlineNotice>}

      {!view.data && !view.error && (
        <div className={s.cards} aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className={s.skeleton} />
          ))}
        </div>
      )}
      {view.data && order.length === 0 && (
        <InlineNotice tone="info" title="This dashboard has no cards yet.">
          <Button onClick={startEdit}>Add measures</Button>
        </InlineNotice>
      )}
      {view.data && (
        <div className={s.cards} aria-busy={view.isLoading}>
          {order.map((c, i) => {
            const m = byMetric.get(c.metric);
            if (!m) return <div key={c.metric} className={s.skeleton} aria-label="Computing" />;
            return (
              <MetricCard
                key={c.metric}
                card={m}
                size={c.size}
                editing={editing}
                index={i}
                count={order.length}
                removable={!required.has(c.metric) && order.length > 1}
                onDrill={onDrill}
                onMove={move}
                onRemove={remove}
                onResize={resize}
                dragIndex={dragIndex}
                setDragIndex={setDragIndex}
              />
            );
          })}
        </div>
      )}
      {view.data && (
        <p className={s.muted} style={{ marginTop: 12 }}>
          {view.data.period.label}
          {view.data.period.comparisonLabel ? ` · compared with ${view.data.period.comparisonLabel}` : ''} · {view.data.scope.companies.length} compan{view.data.scope.companies.length === 1 ? 'y' : 'ies'}
          {view.data.governance.releasedThrough ? ` · released through ${monthName(view.data.governance.releasedThrough)}` : ''}
        </p>
      )}

      <CardPicker open={picker} onClose={() => setPicker(false)} present={new Set(order.map((c) => c.metric))} onAdd={add} />
      <SaveDialog
        open={dialog === 'save'}
        onClose={() => setDialog(null)}
        draft={current}
        onSaved={(id) => {
          setEditing(false);
          setDraft(null);
          setSpark(null);
          setDashboardRef(id);
          setReload((n) => n + 1);
        }}
      />
      <PublishDialog
        open={dialog === 'publish'}
        onClose={() => setDialog(null)}
        draft={current}
        onPublished={() => {
          setEditing(false);
          setDraft(null);
          setReload((n) => n + 1);
        }}
      />
      <PackDialog open={dialog === 'pack'} onClose={() => setDialog(null)} draft={current} dashboardRef={effective?.ref ?? 'default'} companies={companies} weighting={weighting} />
      <ConfirmDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          await deletePersonal();
          setDialog(null);
        }}
        title={`Delete “${effective?.name ?? ''}”?`}
        confirmLabel="Delete dashboard"
        tone="danger"
      >
        Your role’s default comes back. Nothing else changes.
      </ConfirmDialog>
    </div>
  );
}
