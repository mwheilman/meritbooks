/**
 * Today: the current assignment with ONE big state button (On my way → Clock in → Break →
 * Clock out), the rest of today and the next two days. Works offline from the cached bundle.
 * No money anywhere.
 */
import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { buttons, durationText, workedMs } from '@/core/clock';
import type { ClockEvent } from '@/core/contract';
import { useApp } from '@/state/app';
import { agoText, currentVisit, dayLabel, jobById, scheduleCostCode, tasksOn, timeOf, visitsOn } from '@/state/selectors';
import { Button, Card, Notice, Pill, Row, Section, s } from '@/ui/components';
import { CameraButton, SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

export default function Today() {
  const app = useApp();
  const { t, today, shift, lang } = app;
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);

  const visit = currentVisit(today);
  const shiftJob = jobById(today, shift.jobId);
  const visitJob = jobById(today, visit?.jobId);
  const job = shiftJob ?? visitJob;
  const b = buttons(shift, !!visit);
  const todayIso = today?.today ?? '';
  const laterVisits = visitsOn(today, todayIso).filter((v) => v.id !== visit?.id && v.status !== 'DONE' && v.status !== 'CANCELLED');
  const todayTasks = tasksOn(today, todayIso);
  const upcoming = (today?.days ?? []).slice(1);

  const press = async (event: ClockEvent) => {
    if (!job && (event === 'EN_ROUTE' || event === 'IN')) {
      router.push('/clock');
      return;
    }
    if (event === 'SWITCH') {
      router.push('/clock');
      return;
    }
    setBusy(true);
    const r = await app.clock(event, shift.phase === 'idle'
      ? { jobId: job?.id ?? null, assignmentId: visit && visit.jobId === job?.id ? visit.id : null, costCodeId: scheduleCostCode(today, job?.id ?? null) }
      : {});
    setBusy(false);
    setMsg(r.ok ? { text: r.savedOffline ? t('savedOffline') : t('saved'), tone: r.savedOffline ? 'sky' : 'ok' } : { text: r.error, tone: 'danger' });
    setTimeout(() => setMsg(null), 3000);
  };

  const status = shift.phase === 'working' ? t('onClockFor', { time: durationText(workedMs(shift, now)) })
    : shift.phase === 'break' ? t('onBreakSince', { time: timeOf(shift.breakStartedAt, lang) ?? '' })
    : shift.phase === 'en_route' ? t('onTheWay')
    : t('offClock');

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={font.title} accessibilityRole="header">{t('tabToday')}</Text>
        <SyncBadge />
      </View>
      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={async () => { setPulling(true); await app.refresh(); await app.flush(); setPulling(false); }} />}
      >
        {!today && app.loading ? <Notice text={t('loadingWork')} tone="sky" /> : null}
        {!today && !app.loading ? <Notice text={app.todayError ? `${t('neverLoaded')} (${app.todayError})` : t('neverLoaded')} /> : null}
        {today && app.todayError ? <Notice text={t('loadFailed', { when: agoText(app.todayAt, lang) })} /> : null}

        <Section title={t('now')} right={today ? <Text style={font.muted}>{dayLabel(todayIso, lang)}</Text> : null}>
          {job ? (
            <Card tone={shift.phase === 'working' ? 'sky' : undefined}>
              {visit && visit.jobId === job.id ? <Text style={font.eyebrow}>{[timeOf(visit.start, lang), timeOf(visit.end, lang)].filter(Boolean).join(' – ') || t('visit')}</Text> : null}
              <Text style={font.hero}>{visit && visit.jobId === job.id ? visit.title : jobLabel(job)}</Text>
              <Text style={font.regular}>{[visit && visit.jobId === job.id ? jobLabel(job) : null, job.customer].filter(Boolean).join(' · ')}</Text>
              {job.address ? <Text style={font.muted}>{job.address}</Text> : null}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                <Pill text={status} tone={shift.phase === 'working' ? 'primary' : shift.phase === 'break' ? 'warn' : 'muted'} />
                {shift.phase === 'working' && shift.shiftStartedAt ? <Pill text={t('clockedInAt', { time: timeOf(shift.shiftStartedAt, lang) ?? '' })} /> : null}
              </View>
            </Card>
          ) : today ? (
            <Card><Text style={font.regular}>{t('nothingToday')}</Text></Card>
          ) : null}
        </Section>

        {today ? (
          <Section title={t('restOfToday')}>
            {laterVisits.length === 0 && todayTasks.length === 0 ? <Text style={font.muted}>{t('nothingLater')}</Text> : null}
            {laterVisits.map((v) => {
              const j = jobById(today, v.jobId);
              return <Row key={v.id} title={v.title} sub={[timeOf(v.start, lang), j ? jobLabel(j) : null].filter(Boolean).join(' · ')} right={<Pill text={t('visit')} />} />;
            })}
            {todayTasks.slice(0, 12).map((k) => {
              const j = jobById(today, k.jobId);
              return <Row key={k.id} title={k.title} sub={j ? jobLabel(j) : null} right={<Pill text={t('task')} tone={k.status === 'IN_PROGRESS' ? 'primary' : k.status === 'BLOCKED' ? 'danger' : 'muted'} />} />;
            })}
          </Section>
        ) : null}

        {upcoming.length ? (
          <Section title={t('nextDays')}>
            {upcoming.map((d) => {
              const vs = visitsOn(today, d);
              const ks = tasksOn(today, d).filter((k) => k.startOn === d || k.dueOn === d);
              if (!vs.length && !ks.length) return null;
              return (
                <View key={d} style={{ gap: 8 }}>
                  <Text style={font.strong}>{dayLabel(d, lang)}</Text>
                  {vs.map((v) => <Row key={v.id} title={v.title} sub={[timeOf(v.start, lang), jobLabel(jobById(today, v.jobId) ?? { number: null, name: '' })].filter(Boolean).join(' · ')} />)}
                  {ks.map((k) => <Row key={k.id} title={k.title} sub={jobLabel(jobById(today, k.jobId) ?? { number: null, name: '' })} />)}
                </View>
              );
            })}
          </Section>
        ) : null}

        {today?.jobs.length ? (
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <View style={{ flex: 1, minWidth: 150 }}><Button label={t('checklists')} onPress={() => router.push({ pathname: '/checklist', params: { jobId: job?.id ?? '' } })} /></View>
            <View style={{ flex: 1, minWidth: 150 }}><Button label={t('punch')} onPress={() => router.push({ pathname: '/punch', params: { jobId: job?.id ?? '' } })} /></View>
            <View style={{ flex: 1, minWidth: 150 }}><Button label={t('photos')} onPress={() => router.push({ pathname: '/photos', params: { jobId: job?.id ?? '' } })} /></View>
          </View>
        ) : null}
      </ScrollView>

      <View style={[s.footer, { paddingRight: 104 }]}>
        {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
        <Button big tone={b.primary === 'OUT' ? 'danger' : 'primary'} label={t(b.primary)} onPress={() => void press(b.primary)} busy={busy} />
        {b.secondary.length ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {b.secondary.map((e) => <View key={e} style={{ flex: 1 }}><Button label={t(e)} onPress={() => void press(e)} disabled={busy} /></View>)}
          </View>
        ) : null}
      </View>
      <CameraButton jobId={job?.id ?? null} />
    </View>
  );
}

