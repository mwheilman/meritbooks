/**
 * App state: the durable queue and its badge, the cached field bundle (today + 2 days, my week),
 * the shift in progress, language, and the one way screens write: record() → stamp the command
 * with its id, original time, time zone, GPS and offline flag → queue (SQLite) → send when online.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Text, View } from 'react-native';
import { Button } from '@/ui/components';
import { color, font } from '@/ui/theme';
import * as Network from 'expo-network';
import { useAuth, useOrganizationList } from '@clerk/expo';
import type { ApprovalInbox, Command, Draft, FieldExtras, FieldSiteCard, FieldToday, Geo, InboxPage, InstallerDay, JsonCommand, WillCall } from '@/core/contract';
import { isApprovalInbox } from '@/core/approvals';
import { isInboxPage } from '@/core/inbox';
import { IDLE, isShiftState, step, type ShiftState, type StepInput } from '@/core/clock';
import type { ClockEvent } from '@/core/contract';
import { translate, type Lang, type StringKey } from '@/core/i18n';
import { CommandQueue, type QueueCounts, type QueuedCommand } from '@/core/queue';
import { createApi, isExtras, isFieldToday, type Api } from '@/lib/api';

/** C2 / C3 reads cached with today's work (each absent on servers that do not have it yet). */
export interface MoreToday {
  siteCards: FieldSiteCard[];
  installerDay: InstallerDay | null;
  willCalls: WillCall[];
}
const isMore = (v: unknown): v is MoreToday => typeof v === 'object' && v !== null && Array.isArray((v as MoreToday).siteCards) && Array.isArray((v as MoreToday).willCalls);
import { unregisterPush, type RegisterResult } from '@/notifications/push';
import { usePushNotifications } from '@/notifications/usePushNotifications';
import { syncDrawings } from '@/lib/drawingsSync';
import { drawingJobs } from '@/state/selectors';
import { currentFix, deviceLang, deviceTimeZone, newId, removePhoto } from '@/lib/device';
import { getJson, setJson } from '@/lib/kv';
import { SqliteQueueStore } from '@/lib/sqliteQueueStore';
import { database, wipeLocalData } from '@/lib/db';

const KEEP_DONE_MS = 7 * 86_400_000;
const FLUSH_EVERY_MS = 30_000;
const REFRESH_EVERY_MS = 5 * 60_000;

export interface AppValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: StringKey, vars?: Readonly<Record<string, string | number>>) => string;
  api: Api;
  today: FieldToday | null;
  todayAt: number | null;
  todayError: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  queued: QueuedCommand[];
  counts: QueueCounts;
  online: boolean;
  syncing: boolean;
  authProblem: boolean;
  flush: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  /** Stamp and queue a command. Resolves once it is on the phone's disk. */
  record: <C extends Command>(draft: Draft<C> & { id?: string }, opts?: { fileUri?: string | null; dependsOn?: string | null; geo?: Geo | null }) => Promise<C>;
  newId: () => string;
  shift: ShiftState;
  crewShift: ShiftState;
  /** Walk my shift (or the crew's) one step: GPS fix → command → queue. */
  clock: (event: ClockEvent, input: Omit<StepInput, 'id' | 'at' | 'geo'>, opts?: { crew?: boolean }) => Promise<{ ok: true; savedOffline: boolean } | { ok: false; error: string }>;
  /** The job the camera button attaches to: the shift's, else the first job today. */
  currentJobId: string | null;
  signOutEverywhere: () => Promise<void>;
  // ---- Wave C (each cached on the phone; refreshed with today's work)
  /** Site notes, visit details, drawing counts and which phone features I have. */
  extras: FieldExtras | null;
  /** My approvals queue (GET /api/approvals?mine). */
  approvals: ApprovalInbox | null;
  approvalsAt: number | null;
  /** My notification inbox (GET /api/notifications?view=inbox). */
  inbox: InboxPage | null;
  inboxAt: number | null;
  /** Re-read approvals and the inbox now (after a push, on pull-to-refresh). */
  refreshSide: () => Promise<void>;
  /** Push registration outcome: 'denied' shows a hint in the inbox. */
  push: RegisterResult['state'] | null;
  /** Lead-carpenter site cards, the installer's day, will-call pickups. */
  more: MoreToday;
  /** Station mode is on and locked on this tablet (null while the saved state loads). */
  stationLocked: boolean | null;
  setStationLocked: (on: boolean) => Promise<void>;
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

const isLang = (v: unknown): v is Lang => v === 'en' || v === 'es';

export function AppProvider({ children }: { children: ReactNode }) {
  const { getToken, signOut, orgId, userId } = useAuth();
  const orgs = useOrganizationList({ userMemberships: true });
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const api = useMemo(() => createApi(async (o) => (await tokenRef.current(o?.skipCache ? { skipCache: true } : undefined)) ?? null), []);

  const queue = useMemo(() => {
    // SQLite is the durable store; memory only if the database cannot open (the badge then says so).
    const store = new SqliteQueueStore();
    return new CommandQueue(store, { onFileReleased: removePhoto });
  }, []);
  const q = queue;
  /** 'failed': the saved work would not open — blocking screen, nothing deleted, "Try again". */
  const [dbState, setDbState] = useState<'opening' | 'ready' | 'failed'>('opening');
  const [dbAttempt, setDbAttempt] = useState(0);

  const [lang, setLangState] = useState<Lang>(deviceLang());
  const [today, setToday] = useState<FieldToday | null>(null);
  const [todayAt, setTodayAt] = useState<number | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [queued, setQueued] = useState<QueuedCommand[]>([]);
  const [counts, setCounts] = useState<QueueCounts>({ waiting: 0, rejected: 0, delayed: 0 });
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [authProblem, setAuthProblem] = useState(false);
  const [shift, setShift] = useState<ShiftState>(IDLE);
  const [crewShift, setCrewShift] = useState<ShiftState>(IDLE);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const [extras, setExtras] = useState<FieldExtras | null>(null);
  const [approvals, setApprovals] = useState<ApprovalInbox | null>(null);
  const [approvalsAt, setApprovalsAt] = useState<number | null>(null);
  const [inbox, setInbox] = useState<InboxPage | null>(null);
  const [inboxAt, setInboxAt] = useState<number | null>(null);
  const [push, setPush] = useState<RegisterResult['state'] | null>(null);
  const [more, setMore] = useState<MoreToday>({ siteCards: [], installerDay: null, willCalls: [] });
  const [stationLocked, setStationLockedState] = useState<boolean | null>(null);

  // ---- push: register this phone after sign-in, open the right screen when a push is tapped
  const pushToken = useCallback(async (o?: { skipCache?: boolean }) => (await tokenRef.current(o?.skipCache ? { skipCache: true } : undefined)) ?? null, []);
  const onRegistered = useCallback((r: RegisterResult) => setPush(r.state), []);
  usePushNotifications({ getToken: pushToken, userId: userId ?? null, onRegistered });

  const langRef = useRef(lang);
  langRef.current = lang;
  const t = useCallback((key: StringKey, vars?: Readonly<Record<string, string | number>>) => translate(lang, key, vars), [lang]);

  // ---- one org for the phone session: Projects and Books both resolve the tenant from it
  useEffect(() => {
    if (orgId || !orgs.isLoaded) return;
    const first = orgs.userMemberships.data?.[0];
    if (first && orgs.setActive) void orgs.setActive({ organization: first.organization.id });
  }, [orgId, orgs.isLoaded, orgs.userMemberships.data, orgs.setActive]);

  // ---- boot: open the database, restore cache, shift, language, recover in-flight commands
  useEffect(() => {
    let alive = true;
    (async () => {
      setDbState('opening');
      try {
        await database();
      } catch {
        if (alive) setDbState('failed');
        return;
      }
      if (alive) setDbState('ready');
      const [cached, s, cs, l, ex, ap, ib] = await Promise.all([
        getJson('today', isFieldToday), getJson('shift', isShiftState), getJson('crewShift', isShiftState), getJson('lang', isLang),
        getJson('extras', isExtras), getJson('approvals', isApprovalInbox), getJson('inbox', isInboxPage),
      ]);
      const [mo, st] = await Promise.all([getJson('more', isMore), getJson('kiosk.locked', (v): v is boolean => typeof v === 'boolean')]);
      if (mo && alive) setMore(mo.value);
      if (alive) setStationLockedState(st?.value ?? false);
      if (!alive) return;
      if (ex) setExtras(ex.value);
      if (ap) {
        setApprovals(ap.value);
        setApprovalsAt(ap.updatedAt);
      }
      if (ib) {
        setInbox(ib.value);
        setInboxAt(ib.updatedAt);
      }
      if (cached) {
        setToday(cached.value);
        setTodayAt(cached.updatedAt);
      }
      if (s) setShift(s.value);
      if (cs) setCrewShift(cs.value);
      if (l) setLangState(l.value);
      await queue.recover().catch(() => 0);
      await queue.prune(KEEP_DONE_MS).catch(() => 0);
      setLoading(!cached);
    })();
    return () => {
      alive = false;
    };
  }, [queue, dbAttempt]);

  // ---- badge: re-read the queue on every change
  useEffect(() => {
    const load = async () => {
      const [list, c] = await Promise.all([q.list(), q.counts()]);
      setQueued(list);
      setCounts(c);
    };
    void load();
    return q.subscribe(() => void load());
  }, [q]);

  const refreshSide = useCallback(async () => {
    await Promise.all([
      api.approvals().then(async (a) => {
        setApprovals(a);
        setApprovalsAt(Date.now());
        await setJson('approvals', a).catch(() => undefined);
      }).catch(() => undefined),
      api.inbox().then(async (p) => {
        setInbox(p);
        setInboxAt(Date.now());
        await setJson('inbox', p).catch(() => undefined);
      }).catch(() => undefined),
    ]);
  }, [api]);

  const refreshExtras = useCallback(async (t: FieldToday) => {
    // today's visits and jobs first (the server caps the lists)
    const visitJobs = t.assignments.map((a) => a.jobId);
    const jobs = [...new Set([...visitJobs, ...t.jobs.map((j) => j.id)])].slice(0, 60);
    try {
      const x = await api.extras(t.assignments.map((a) => a.workOrderId), jobs);
      setExtras(x);
      await setJson('extras', x).catch(() => undefined);
      // C2 / C3 reads (best effort; a server without them answers 404 and the saved copy stays)
      const lang = langRef.current;
      const [sites, day, tools] = await Promise.all([
        jobs.length ? api.siteCards(jobs, lang).then((r) => r.cards).catch(() => null) : Promise.resolve([] as FieldSiteCard[]),
        api.installerDay().catch(() => null),
        api.fsTools().then((r) => r.willCalls).catch(() => null),
      ]);
      setMore((cur) => {
        const next: MoreToday = { siteCards: sites ?? cur.siteCards, installerDay: day ?? cur.installerDay, willCalls: tools ?? cur.willCalls };
        void setJson('more', next).catch(() => undefined);
        return next;
      });
      // keep the current drawing set of my jobs on the phone (background, best effort)
      if (x.features.drawings) {
        const d = drawingJobs(t, x.drawings);
        if (d.jobs.length) void syncDrawings(api, d.jobs, d.priority).catch(() => undefined);
      }
    } catch {
      // keep the saved copy
    }
  }, [api]);

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.today();
      setToday(fresh);
      setTodayAt(Date.now());
      setTodayError(null);
      await setJson('today', fresh).catch(() => undefined);
      void refreshExtras(fresh);
      void refreshSide();
    } catch (e) {
      setTodayError(e instanceof Error ? e.message : 'Could not load your work.');
    } finally {
      setLoading(false);
    }
  }, [api, refreshExtras, refreshSide]);

  const flushing = useRef(false);
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    setSyncing(true);
    try {
      const r = await q.flush(api.transport);
      setAuthProblem(r.authProblem);
      if (r.offline) setOnline(false);
      if (r.applied > 0) void refresh();
    } catch {
      // the queue keeps everything; the next tick tries again
    } finally {
      flushing.current = false;
      setSyncing(false);
    }
  }, [api, q, refresh]);

  // ---- connectivity, foreground and timers
  useEffect(() => {
    void Network.getNetworkStateAsync().then((n) => setOnline(n.isConnected !== false && n.isInternetReachable !== false)).catch(() => undefined);
    const sub = Network.addNetworkStateListener((n) => {
      const up = n.isConnected !== false && n.isInternetReachable !== false;
      setOnline(up);
      if (up) void flush();
    });
    const app = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        // unlocked / back in front: write anything held in memory, put interrupted sends back, then send
        void q.resume().catch(() => undefined).then(() => flush());
        void refresh();
      }
    });
    const tick = setInterval(() => {
      if (onlineRef.current) void flush();
    }, FLUSH_EVERY_MS);
    const re = setInterval(() => {
      if (onlineRef.current) void refresh();
    }, REFRESH_EVERY_MS);
    void refresh();
    void flush();
    return () => {
      sub.remove();
      app.remove();
      clearInterval(tick);
      clearInterval(re);
    };
  }, [flush, refresh, q]);

  const record = useCallback(
    async <C extends Command>(draft: Draft<C> & { id?: string }, opts: { fileUri?: string | null; dependsOn?: string | null; geo?: Geo | null } = {}): Promise<C> => {
      const geo = opts.geo !== undefined ? opts.geo : draft.geo !== undefined ? draft.geo : await currentFix();
      const command = { ...draft, id: draft.id ?? newId(), at: new Date().toISOString(), tz: deviceTimeZone(), geo: geo ?? null, offline: !onlineRef.current } as unknown as C;
      await q.enqueue(command, { fileUri: opts.fileUri ?? null, dependsOn: opts.dependsOn ?? null });
      if (onlineRef.current) void flush();
      return command;
    },
    [flush, q],
  );

  const clock = useCallback<AppValue['clock']>(
    async (event, input, opts = {}) => {
      const cur = opts.crew ? crewShift : shift;
      const id = newId();
      const at = new Date().toISOString();
      const geo = await currentFix();
      try {
        const st = step(cur, event, { ...input, id, at, geo });
        if (st.command) {
          const command: JsonCommand = { ...st.command, tz: deviceTimeZone(), offline: !onlineRef.current };
          await q.enqueue(command);
        }
        // the punch itself is in the queue (held in memory if the disk refused); the shift state is a convenience copy
        if (opts.crew) {
          setCrewShift(st.next);
          await setJson('crewShift', st.next).catch(() => undefined);
        } else {
          setShift(st.next);
          await setJson('shift', st.next).catch(() => undefined);
        }
        if (onlineRef.current) void flush();
        return { ok: true, savedOffline: !onlineRef.current };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'That did not save.' };
      }
    },
    [crewShift, flush, q, shift],
  );

  const setStationLocked = useCallback(async (on: boolean) => {
    setStationLockedState(on);
    await setJson('kiosk.locked', on).catch(() => undefined);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    void setJson('lang', l);
  }, []);

  const currentJobId = shift.jobId ?? today?.assignments.find((a) => a.day === today.today && a.status !== 'DONE')?.jobId ?? today?.jobs[0]?.id ?? null;

  const signOutEverywhere = useCallback(async () => {
    // stop pushes to this phone for this person BEFORE the session (and the saved registration) go
    await unregisterPush(pushToken).catch(() => undefined);
    await wipeLocalData().catch(() => undefined);
    for (const c of queued) if (c.fileUri) removePhoto(c.fileUri);
    setToday(null);
    setExtras(null);
    setApprovals(null);
    setInbox(null);
    setMore({ siteCards: [], installerDay: null, willCalls: [] });
    setShift(IDLE);
    setCrewShift(IDLE);
    await signOut();
  }, [pushToken, queued, signOut]);

  const value: AppValue = {
    lang, setLang, t, api, today, todayAt, todayError, loading, refresh, queued, counts, online, syncing, authProblem, flush,
    dismiss: (id) => q.dismiss(id), retry: async (id) => { await q.retry(id); void flush(); },
    record, newId, shift, crewShift, clock, currentJobId, signOutEverywhere,
    extras, approvals, approvalsAt, inbox, inboxAt, refreshSide, push, more, stationLocked, setStationLocked,
  };
  if (dbState === 'failed') {
    return <OpenFailed t={t} onRetry={() => setDbAttempt((n) => n + 1)} />;
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}


function OpenFailed({ t, onRetry }: { t: (key: StringKey) => string; onRetry: () => void }) {
  return (
    <View style={{ flex: 1, padding: 24, gap: 16, justifyContent: 'center', backgroundColor: color.bg }} accessibilityRole="alert">
      <Text style={font.title}>{t('dbFailedTitle')}</Text>
      <Text style={font.regular}>{t('dbFailedBody')}</Text>
      <Button big tone="primary" label={t('tryAgain')} onPress={onRetry} />
    </View>
  );
}
