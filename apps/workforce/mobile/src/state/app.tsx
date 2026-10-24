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
import type { Command, Draft, FieldToday, Geo, JsonCommand } from '@/core/contract';
import { IDLE, isShiftState, step, type ShiftState, type StepInput } from '@/core/clock';
import type { ClockEvent } from '@/core/contract';
import { translate, type Lang, type StringKey } from '@/core/i18n';
import { CommandQueue, type QueueCounts, type QueuedCommand } from '@/core/queue';
import { createApi, isFieldToday, type Api } from '@/lib/api';
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
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

const isLang = (v: unknown): v is Lang => v === 'en' || v === 'es';

export function AppProvider({ children }: { children: ReactNode }) {
  const { getToken, signOut, orgId } = useAuth();
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
      const [cached, s, cs, l] = await Promise.all([
        getJson('today', isFieldToday), getJson('shift', isShiftState), getJson('crewShift', isShiftState), getJson('lang', isLang),
      ]);
      if (!alive) return;
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

  const refresh = useCallback(async () => {
    try {
      const fresh = await api.today();
      setToday(fresh);
      setTodayAt(Date.now());
      setTodayError(null);
      await setJson('today', fresh).catch(() => undefined);
    } catch (e) {
      setTodayError(e instanceof Error ? e.message : 'Could not load your work.');
    } finally {
      setLoading(false);
    }
  }, [api]);

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
        void flush();
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
  }, [flush, refresh]);

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
        if (opts.crew) {
          setCrewShift(st.next);
          await setJson('crewShift', st.next);
        } else {
          setShift(st.next);
          await setJson('shift', st.next);
        }
        if (onlineRef.current) void flush();
        return { ok: true, savedOffline: !onlineRef.current };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'That did not save.' };
      }
    },
    [crewShift, flush, q, shift],
  );

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    void setJson('lang', l);
  }, []);

  const currentJobId = shift.jobId ?? today?.assignments.find((a) => a.day === today.today && a.status !== 'DONE')?.jobId ?? today?.jobs[0]?.id ?? null;

  const signOutEverywhere = useCallback(async () => {
    await wipeLocalData().catch(() => undefined);
    for (const c of queued) if (c.fileUri) removePhoto(c.fileUri);
    setToday(null);
    setShift(IDLE);
    setCrewShift(IDLE);
    await signOut();
  }, [queued, signOut]);

  const value: AppValue = {
    lang, setLang, t, api, today, todayAt, todayError, loading, refresh, queued, counts, online, syncing, authProblem, flush,
    dismiss: (id) => q.dismiss(id), retry: async (id) => { await q.retry(id); void flush(); },
    record, newId, shift, crewShift, clock, currentJobId, signOutEverywhere,
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
