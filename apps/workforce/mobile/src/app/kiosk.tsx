/**
 * Station mode (MFG-30 shop-floor kiosk) on a shared tablet, signed in as the station seat
 * (production:edit). Badge (scanner or keypad) + PIN → the worker's operations, assigned first →
 * Start / Pause / Stop / Done with good and scrap counts, or indirect time → "I'm done" (or 45 s
 * idle) signs them out for the next person. Badge sign-in is online (lockout lives in the
 * database); every tap after it is queued with its own time and replays in order when Wi-Fi is
 * back (the database dedupes on the command id). Three taps, gloves, no money, no other screens.
 *
 * Locked (security review M3): once on, station mode survives restarts and every other route is
 * sent back here (app/_layout.tsx StationGuard). Leaving needs the tablet's own screen lock
 * (passcode / biometrics, expo-local-authentication); a tablet without one — or a seat that is
 * only a station — leaves by signing the station seat out, once nothing is waiting to send.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, Pressable, ScrollView, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { router, Stack } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as LocalAuthentication from 'expo-local-authentication';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { KioskEventCommand, KioskSession } from '@/core/contract';
import { cleanBadge, idle, identifyRefusal, indirectRunning, kioskDraft, pinReady, pressPin, runningOperations, sessionLive, type PinKey } from '@/core/kiosk';
import { exitPlan, stationOnly } from '@/core/station';
import { getJson, setJson } from '@/lib/kv';
import { useApp } from '@/state/app';
import { Button, Card, Field, Notice, Pill, Row, s } from '@/ui/components';
import { SyncBadge } from '@/ui/chrome';
import { color, font, size } from '@/ui/theme';

const KEYS: PinKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];
const CODES = ['CLEANUP', 'MAINTENANCE', 'TRAINING', 'MEETING'] as const;
const isStation = (v: unknown): v is { companyId: string } => typeof v === 'object' && v !== null && typeof (v as { companyId?: unknown }).companyId === 'string';

export default function Kiosk() {
  useKeepAwake();
  const app = useApp();
  const { t, extras, queued } = app;
  const insets = useSafeAreaInsets();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [badge, setBadge] = useState('');
  const [stage, setStage] = useState<'badge' | 'pin' | 'worker'>('badge');
  const [pin, setPin] = useState('');
  const [session, setSession] = useState<KioskSession | null>(null);
  const [qtyFor, setQtyFor] = useState<string | null>(null);
  const [good, setGood] = useState('');
  const [scrap, setScrap] = useState('');
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);
  const [busy, setBusy] = useState(false);
  const lastTap = useRef(Date.now());
  const badgeInput = useRef<TextInputInstance>(null);

  // the station remembers its shop
  useEffect(() => {
    void getJson('kiosk.station', isStation).then((v) => {
      if (v) setCompanyId(v.value.companyId);
      else if (extras?.stations.length === 1) setCompanyId(extras.stations[0]!.companyId);
    });
  }, [extras?.stations]);
  useEffect(() => {
    if (companyId) void setJson('kiosk.station', { companyId }).catch(() => undefined);
  }, [companyId]);

  // hardware back never leaves station mode by accident
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const signOut = (text: string = t('kioskSignedOut')) => {
    setSession(null);
    setStage('badge');
    setBadge('');
    setPin('');
    setQtyFor(null);
    setMsg({ text, tone: 'sky' });
    setTimeout(() => badgeInput.current?.focus(), 200);
  };

  // walk away → signed out; the badge session ending → signed out
  useEffect(() => {
    if (!session) return undefined;
    const i = setInterval(() => {
      if (!sessionLive(session, Date.now())) signOut(t('kioskSessionOver'));
      else if (idle(lastTap.current, Date.now())) signOut();
    }, 5_000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const touch = () => {
    lastTap.current = Date.now();
  };

  const identify = async () => {
    if (!companyId) return;
    const b = cleanBadge(badge);
    if (!b || !pinReady(pin)) return;
    setBusy(true);
    const r = await app.api.kioskIdentify(companyId, b, pin);
    setBusy(false);
    setPin('');
    if (r.ok) {
      touch();
      setSession(r.session);
      setStage('worker');
      setMsg(null);
      return;
    }
    const why = identifyRefusal(r.code);
    setMsg({ text: why === 'other' ? t('kioskErr_other', { reason: r.message }) : t(`kioskErr_${why}`), tone: 'danger' });
    if (why !== 'pin') {
      setStage('badge');
      setBadge('');
    }
  };

  const send = async (action: KioskEventCommand['action'], extra: Parameters<typeof kioskDraft>[3] = {}) => {
    if (!session || !companyId) return;
    touch();
    await app.record<KioskEventCommand>(kioskDraft(companyId, session, action, extra), { geo: null });
    setMsg({ text: t('kioskSaved'), tone: 'ok' });
    setTimeout(() => setMsg(null), 1500);
  };

  const running = useMemo(() => (session ? runningOperations(session, queued) : new Set<string>()), [session, queued]);
  const indirect = session ? indirectRunning(session, queued) : null;
  const waiting = queued.filter((q) => q.kind === 'kiosk.event' && (q.status === 'pending' || q.status === 'sending')).length;
  const ops = session?.operations ?? [];
  const mine = ops.filter((o) => o.assigned_to_me || running.has(o.operation_id));
  const others = ops.filter((o) => !o.assigned_to_me && !running.has(o.operation_id));

  // lock the tablet to station mode from the moment it opens
  useEffect(() => {
    if (app.stationLocked === false) void app.setStationLocked(true);
  }, [app]);

  const leave = async () => {
    const level = await LocalAuthentication.getEnrolledLevelAsync().catch(() => 0);
    const plan = exitPlan(Number(level), app.counts.waiting, stationOnly(app.today, extras));
    if (plan === 'wait-for-queue') {
      setMsg({ text: t('kioskExitWait', { n: app.counts.waiting }), tone: 'danger' });
      return;
    }
    if (plan === 'device-auth') {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: t('kioskExitAuth'), cancelLabel: t('cancel'), disableDeviceFallback: false }).catch(() => ({ success: false }));
      if (!r.success) {
        setMsg({ text: t('kioskExitDenied'), tone: 'danger' });
        return;
      }
      await app.setStationLocked(false);
      router.replace('/');
      return;
    }
    Alert.alert(t('kioskExit'), t('kioskExitSignsOut'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('signOut'), style: 'destructive', onPress: () => void app.signOutEverywhere() },
    ]);
  };

  const opRow = (o: KioskSession['operations'][number]) => {
    const on = running.has(o.operation_id);
    const asking = qtyFor === o.operation_id;
    return (
      <Card key={o.operation_id} tone={on ? 'sky' : undefined}>
        <Text style={font.title}>{`${o.operation} · ${o.work_center}`}</Text>
        <Text style={font.regular}>{[o.work_order, o.job, o.summary].filter(Boolean).join(' · ')}</Text>
        {on ? <Pill text={t('kioskRunning')} tone="primary" /> : null}
        {asking ? (
          <View style={{ gap: 10 }}>
            <Field label={t('kioskGood')} value={good} onChangeText={(v) => { touch(); setGood(v); }} keyboardType="number-pad" maxLength={7} autoFocus />
            <Field label={t('kioskScrap')} value={scrap} onChangeText={(v) => { touch(); setScrap(v); }} keyboardType="number-pad" maxLength={7} />
            <Button big tone="ok" label={t('kioskComplete')} onPress={() => {
              const g = good.trim() ? Number(good) : null;
              const sc = scrap.trim() ? Number(scrap) : null;
              void send('COMPLETE', { operationId: o.operation_id, goodQty: g != null && Number.isFinite(g) ? g : null, scrapQty: sc != null && Number.isFinite(sc) ? sc : null });
              setQtyFor(null);
              setGood('');
              setScrap('');
            }} />
          </View>
        ) : on ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Button big label={t('kioskPause')} onPress={() => void send('PAUSE', { operationId: o.operation_id })} /></View>
            <View style={{ flex: 1 }}><Button big tone="danger" label={t('kioskStop')} onPress={() => void send('STOP', { operationId: o.operation_id })} /></View>
            <View style={{ flex: 1 }}><Button big tone="ok" label={t('kioskComplete')} onPress={() => { touch(); setQtyFor(o.operation_id); }} /></View>
          </View>
        ) : (
          <Button big tone="primary" label={t('kioskStart')} onPress={() => void send('START', { operationId: o.operation_id })} />
        )}
      </Card>
    );
  };

  return (
    <View style={[s.screen, { paddingTop: insets.top }]} onTouchStart={touch}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <View style={s.header}>
        <Text style={font.title} accessibilityRole="header">{session ? t('kioskHello', { name: session.name ?? '' }) : t('kioskTitle')}</Text>
        <SyncBadge />
      </View>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
        {waiting ? <Notice text={t('kioskQueued', { n: waiting })} tone="sky" /> : null}

        {!companyId ? (
          <View style={{ gap: 10 }}>
            <Text style={font.title}>{t('kioskPickCompany')}</Text>
            {(extras?.stations ?? []).map((c) => <Row key={c.companyId} title={c.name} onPress={() => setCompanyId(c.companyId)} />)}
          </View>
        ) : stage === 'badge' ? (
          <View style={{ gap: 16 }}>
            <Text style={font.hero}>{t('kioskScan')}</Text>
            {!app.online ? <Notice text={t('kioskErr_offline')} /> : null}
            <TextInput
              ref={badgeInput}
              value={badge}
              onChangeText={setBadge}
              onSubmitEditing={() => { if (cleanBadge(badge)) setStage('pin'); }}
              autoFocus
              autoCapitalize="characters"
              autoCorrect={false}
              secureTextEntry
              accessibilityLabel={t('kioskBadge')}
              placeholder={t('kioskBadge')}
              placeholderTextColor={color.muted}
              style={{ minHeight: size.bigButton, borderWidth: 2, borderColor: color.ink, borderRadius: size.radius, paddingHorizontal: 16, fontSize: 28, color: color.ink }}
            />
            <Button big tone="primary" label={t('next')} disabled={!cleanBadge(badge)} onPress={() => setStage('pin')} />
          </View>
        ) : stage === 'pin' ? (
          <View style={{ gap: 16 }}>
            <Text style={font.hero}>{t('kioskPin')}</Text>
            <Text style={[font.hero, { letterSpacing: 12, textAlign: 'center' }]} accessibilityLabel={`${pin.length}`}>{'●'.repeat(pin.length) || ' '}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {KEYS.map((k) => (
                <Pressable key={k} onPress={() => setPin((p) => pressPin(p, k))} accessibilityRole="button" accessibilityLabel={k}
                  style={({ pressed }) => ({ flexBasis: '30%', flexGrow: 1, minHeight: 84, borderWidth: 2, borderColor: color.ink, borderRadius: size.radius, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.faint : color.bg })}>
                  <Text style={{ fontSize: k.length > 1 ? 20 : 34, fontWeight: '800', color: color.ink }}>{k === 'del' ? '⌫' : k === 'clear' ? t('clear') : k}</Text>
                </Pressable>
              ))}
            </View>
            <Button big tone="primary" label={t('kioskGo')} busy={busy} disabled={!pinReady(pin) || !app.online} onPress={() => void identify()} />
            <Button label={t('back')} onPress={() => { setStage('badge'); setPin(''); }} />
          </View>
        ) : session ? (
          <View style={{ gap: 16 }}>
            {!ops.length ? <Notice text={t('kioskNoOps')} /> : null}
            {mine.length ? <Text style={font.eyebrow}>{t('kioskYourWork')}</Text> : null}
            {mine.map(opRow)}
            {others.length ? <Text style={font.eyebrow}>{t('kioskOtherWork')}</Text> : null}
            {others.slice(0, 20).map(opRow)}
            <Text style={font.eyebrow}>{t('kioskIndirect')}</Text>
            {indirect ? (
              <Button big tone="danger" label={t('kioskIndirectStop', { code: CODES.includes(indirect as (typeof CODES)[number]) ? t(`kcode_${indirect as (typeof CODES)[number]}`) : indirect })} onPress={() => void send('INDIRECT_STOP', { indirectCode: indirect })} />
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                {CODES.map((c) => <View key={c} style={{ flexBasis: '47%', flexGrow: 1 }}><Button label={t(`kcode_${c}`)} onPress={() => void send('INDIRECT_START', { indirectCode: c })} /></View>)}
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>
      <View style={s.footer}>
        {session ? <Button big tone="primary" label={t('kioskDone')} onPress={() => signOut()} /> : <Button label={t('kioskExit')} onPress={() => void leave()} />}
      </View>
    </View>
  );
}
