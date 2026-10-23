'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Bands,
  Button,
  ConfirmDialog,
  InlineNotice,
  ListPager,
  PageHead,
  Pip,
  QueueTable,
  Search,
  Seg,
  Tabs,
  Tag,
  api,
  toast,
  useDebounce,
  useQuery,
  type QueueAction,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { KIND_LABEL } from '@/lib/requests/types';
import { useShellLine } from '@/components/layout/shell-context';
import { RequestPanel } from './request-panel';
import { NewRequestDialog } from './new-request-dialog';
import { PoliciesDrawer } from './policies-drawer';
import {
  KIND_TABS,
  ageDays,
  relative,
  statusLook,
  type ActionResponse,
  type RequestListResponse,
  type RequestListRow,
} from './requests-types';
import s from './requests.module.css';

type Band = 'all' | 'due' | 'escalated' | 'undeliverable';
type View = 'live' | 'closed';
type KindTab = (typeof KIND_TABS)[number]['value'];
type Scope = 'client' | 'all';

const PAGE = 50;

/** The slash track: one stroke per ask so far (filled), brick once escalated. */
function AskTrack({ r }: { r: RequestListRow }) {
  const n = Math.min(r.sends_count, 10);
  return (
    <span className={s.track} aria-hidden="true">
      {Array.from({ length: Math.max(n, 1) }, (_, i) => (
        <i key={i} className={n === 0 ? undefined : r.escalated_at && i === n - 1 ? s.esc : s.done} />
      ))}
    </span>
  );
}

export function RequestsScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { activeCompanyId, activeCompany, isAll } = useActiveCompany();

  const [band, setBand] = useState<Band>('all');
  const [view, setView] = useState<View>('live');
  const [kindTab, setKindTab] = useState<KindTab>('all');
  const [scope, setScope] = useState<Scope>('client');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 250);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));
  const [refreshKey, setRefreshKey] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'cancel' | 'fulfil'; row: RequestListRow } | null>(null);

  const clientFilter = !isAll && scope === 'client' && activeCompanyId ? activeCompanyId : undefined;
  const kinds = KIND_TABS.find((t) => t.value === kindTab)?.kinds ?? null;

  useEffect(() => setOffset(0), [band, view, kindTab, q, clientFilter]);
  useEffect(() => {
    const id = params.get('id');
    if (id) setSelectedId(id);
  }, [params]);

  const { data, error, isLoading, refetch } = useQuery<RequestListResponse>(
    '/api/requests',
    {
      view,
      band: view === 'live' ? band : 'all',
      kind: kinds ? kinds.join(',') : undefined,
      q: q || undefined,
      location_id: clientFilter,
      limit: String(PAGE),
      offset: String(offset),
    },
    { key: String(refreshKey), scope: false },
  );

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const strip = data?.strip;
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useShellLine(
    strip
      ? [
          `${strip.open.toLocaleString()} open`,
          { label: strip.escalated > 0 ? `${strip.escalated} escalated` : 'Nothing escalated', strong: strip.escalated > 0 },
          strip.dueSoon > 0 ? `${strip.dueSoon} going out in the next 24 h` : 'Nothing due in the next 24 h',
        ]
      : null,
    strip ? `${strip.open}:${strip.escalated}:${strip.dueSoon}` : 'none',
  );

  const act = useCallback(
    async (body: Record<string, unknown>, okMsg?: string) => {
      const res = await api.post<ActionResponse>('/api/requests/actions', body);
      if (res.error) {
        toast.error(res.error.error);
        return false;
      }
      toast(okMsg ?? res.data?.message ?? 'Done.');
      refresh();
      return true;
    },
    [refresh],
  );

  const sendNow = useCallback((r: RequestListRow) => void act({ action: 'send_now', id: r.id }), [act]);
  const snooze = useCallback(
    (r: RequestListRow, days: number) => void act({ action: 'snooze', id: r.id, until: new Date(Date.now() + days * 86_400_000).toISOString() }),
    [act],
  );

  const columns = useMemo<QueueColumn<RequestListRow>[]>(
    () => [
      {
        id: 'status',
        header: 'Status',
        width: 128,
        cell: (r) => {
          const look = statusLook(r);
          return (
            <span className="mb-sev">
              <Pip kind={look.pip} />
              {look.word}
            </span>
          );
        },
      },
      {
        id: 'request',
        header: 'Waiting on',
        cell: (r) => (
          <>
            <span className="l1">{r.title}</span>
            <span className="l2">
              {[r.recipient_name ?? r.recipient_email ?? 'No recipient', KIND_LABEL[r.kind], r.recipient_email && r.recipient_name ? r.recipient_email : null].filter(Boolean).join(' · ')}
            </span>
          </>
        ),
      },
      {
        id: 'asks',
        header: 'Asked',
        width: 120,
        cell: (r) => (
          <span title={r.cadence_text}>
            <AskTrack r={r} /> <span className="tnum">{r.sends_count}</span>
            <span className="ink-3"> of {r.max_sends}</span>
          </span>
        ),
      },
      { id: 'age', header: 'Age', width: 72, numeric: true, cell: (r) => <span className="tnum">{ageDays(r.created_at)}d</span> },
      {
        id: 'last',
        header: 'Last asked',
        width: 112,
        cell: (r) => <span className="ink-2">{r.last_sent_at ? relative(r.last_sent_at) : 'Not yet'}</span>,
      },
      {
        id: 'next',
        header: view === 'live' ? 'Next ask' : 'Closed',
        width: 128,
        cell: (r) =>
          view === 'live' ? (
            r.status === 'snoozed' ? (
              <span className="ink-2">Snoozed · {relative(r.snoozed_until)}</span>
            ) : r.bounced_at ? (
              <Tag tone="neg">Fix email</Tag>
            ) : !r.next_send_at && r.sends_count === 0 ? (
              <Tag tone="warn">Waiting for you · Send now</Tag>
            ) : (
              <span className="ink-2">{relative(r.next_send_at)}</span>
            )
          ) : (
            <span className="ink-2">{relative(r.fulfilled_at ?? r.cancelled_at)}</span>
          ),
      },
    ],
    [view],
  );

  const actions = useMemo<QueueAction<RequestListRow>[]>(
    () =>
      view === 'live'
        ? [
            { key: 's', label: 'Send now', run: (rs) => rs[0] && sendNow(rs[0]) },
            { key: 'z', label: 'Snooze 3 days', run: (rs) => rs[0] && snooze(rs[0], 3) },
            { key: 'f', label: 'Mark fulfilled', run: (rs) => rs[0] && setConfirm({ kind: 'fulfil', row: rs[0] }) },
            { key: 'c', label: 'Cancel', run: (rs) => rs[0] && setConfirm({ kind: 'cancel', row: rs[0] }) },
          ]
        : [],
    [view, sendNow, snooze],
  );

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const email = data?.email;

  return (
    <div>
      <PageHead
        eyebrow={['Home', 'Requests']}
        title="Requests"
        actions={
          <>
            <Button variant="quiet" icon="sliders" onClick={() => setSettingsOpen(true)}>
              Cadence &amp; quiet hours
            </Button>
            <Button variant="primary" icon="plus" chord="n" bindChord onClick={() => setNewOpen(true)}>
              New request
            </Button>
          </>
        }
      >
        <p className="t-cap">Everything the books are waiting on from someone else, how hard we’ve asked, and when we’ll ask again.</p>
      </PageHead>

      {email && !email.configured && (
        <InlineNotice tone="warn" title="Email isn’t set up, so nothing is being sent." className="mb-inline-field">
          Requests are recorded and their schedule runs, but each ask is marked “not sent”. {email.reason}
        </InlineNotice>
      )}

      {view === 'live' && (
        <Bands<Band>
          aria-label="Requests by urgency"
          value={band}
          onChange={setBand}
          items={[
            { value: 'all', label: 'Open', count: strip ? strip.open.toLocaleString() : '—', caption: 'Waiting on someone' },
            { value: 'due', label: 'Next 24 h', count: strip ? strip.dueSoon.toLocaleString() : '—', caption: 'Asks about to go out' },
            { value: 'escalated', label: 'Escalated', count: strip ? strip.escalated.toLocaleString() : '—', caption: 'A person has been told' },
            { value: 'undeliverable', label: 'Can’t reach', count: strip ? strip.undeliverable.toLocaleString() : '—', caption: 'Bounced or unsubscribed' },
          ]}
        />
      )}

      <div className={s.toolbar}>
        <Tabs<KindTab>
          aria-label="Request kind"
          value={kindTab}
          onChange={setKindTab}
          items={KIND_TABS.map((t) => ({
            value: t.value,
            label: t.label,
            count:
              view === 'live' && strip
                ? t.kinds
                  ? t.kinds.reduce((n, k) => n + (strip.byKind[k] ?? 0), 0) || undefined
                  : strip.open || undefined
                : undefined,
          }))}
        />
        <div className={s.grow} />
        {!isAll && activeCompany && (
          <Seg<Scope>
            aria-label="Which clients"
            value={scope}
            onChange={setScope}
            items={[
              { value: 'client', label: activeCompany.name },
              { value: 'all', label: 'All clients' },
            ]}
          />
        )}
        <Seg<View>
          aria-label="Open or closed"
          value={view}
          onChange={setView}
          items={[
            { value: 'live', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
        <Search aria-label="Search requests" placeholder="Search title, name or email" value={search} onChange={(e) => setSearch(e.target.value)} slashToFocus />
      </div>

      <div className={s.split}>
        <div>
          {error ? (
            <div className={s.state} role="alert">
              <p className="t-head">Couldn’t load requests.</p>
              <p className="ink-2">{error}</p>
              <Button onClick={() => void refetch()}>Try again</Button>
            </div>
          ) : isLoading && !data ? (
            <div className={s.state} role="status">
              <span className="bar-l" style={{ width: '60%' }} aria-hidden="true" />
              <span className="bar-l" style={{ width: '40%' }} aria-hidden="true" />
              <p className="t-cap">Loading requests…</p>
            </div>
          ) : rows.length === 0 ? (
            <div className={s.state}>
              {view === 'live' && band === 'all' && !q ? (
                <>
                  <p className="t-head">Nobody owes you anything right now.</p>
                  <p className="ink-2">
                    When a vendor is missing a W-9, a client owes an answer, or a teammate has an approval waiting, it shows here with its reminder schedule.
                  </p>
                  <Button variant="primary" icon="plus" onClick={() => setNewOpen(true)} style={{ marginTop: 12 }}>
                    New request
                  </Button>
                </>
              ) : (
                <>
                  <p className="t-head">Nothing matches.</p>
                  <p className="ink-2">Try another tab, band or search.</p>
                </>
              )}
            </div>
          ) : (
            <>
              <QueueTable
                aria-label={`Requests, ${view === 'live' ? 'open' : 'closed'}`}
                columns={columns}
                rows={rows}
                getRowId={(r) => r.id}
                rowState={(r) => ({ attn: statusLook(r).attn, done: view === 'closed' })}
                cursorId={selectedId}
                onCursorChange={(id) => setSelectedId(id)}
                onOpen={(r) => setSelectedId(r.id)}
                openOnClick
                actions={actions}
              />
              {data && (
                <ListPager page={Math.floor(offset / PAGE) + 1} perPage={PAGE} total={data.total} onPage={(p) => setOffset((p - 1) * PAGE)} noun="requests" />
              )}
            </>
          )}
        </div>
        <div className={s.panelWrap}>
          {selectedId ? (
            <RequestPanel
              id={selectedId}
              refreshKey={refreshKey}
              onClose={() => {
                setSelectedId(null);
                router.replace('/requests');
              }}
              onSendNow={(r) => sendNow(r)}
              onSnooze={(r, d) => snooze(r, d)}
              onCancel={(r) => setConfirm({ kind: 'cancel', row: r })}
              onFulfil={(r) => setConfirm({ kind: 'fulfil', row: r })}
            />
          ) : (
            <div className={s.state} style={{ width: '100%' }}>
              <p className="t-head">Pick a request</p>
              <p className="ink-2">Its full history shows here: every ask, which channel, when it went, and what happens next.</p>
              <p className="t-cap" style={{ marginTop: 8 }}>
                J / K to move · S send now · Z snooze · F fulfilled · C cancel
              </p>
            </div>
          )}
        </div>
      </div>

      <NewRequestDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        locationId={!isAll ? activeCompanyId : null}
        clientName={activeCompany?.name ?? null}
        onCreated={(id) => {
          setNewOpen(false);
          setView('live');
          setBand('all');
          setSelectedId(id);
          refresh();
        }}
      />

      <PoliciesDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <ConfirmDialog
        open={confirm?.kind === 'cancel'}
        onClose={() => setConfirm(null)}
        title={`Cancel “${confirm?.row.title ?? ''}”?`}
        confirmLabel="Cancel request"
        cancelLabel="Keep chasing"
        tone="danger"
        reason={{ label: 'Why? (goes on the timeline)', minLength: 3, placeholder: 'Client sent it by hand' }}
        onConfirm={async (reason) => {
          if (confirm) await act({ action: 'cancel', id: confirm.row.id, reason: reason ?? '' });
          setConfirm(null);
        }}
      >
        No more reminders will go out and its links stop working.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === 'fulfil'}
        onClose={() => setConfirm(null)}
        title={`Mark “${confirm?.row.title ?? ''}” fulfilled?`}
        confirmLabel="Mark fulfilled"
        tone="primary"
        reason={{ label: 'Note (optional)', minLength: 0, placeholder: 'Received by email Oct 23' }}
        onConfirm={async (note) => {
          if (confirm) await act({ action: 'fulfil', id: confirm.row.id, note: note || undefined });
          setConfirm(null);
        }}
      >
        The chase stops. Use this when you got what you asked for another way.
      </ConfirmDialog>
    </div>
  );
}
