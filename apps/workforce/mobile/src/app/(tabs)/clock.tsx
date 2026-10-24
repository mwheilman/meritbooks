/**
 * Clock: the job suggested by where I am standing, the cost code from today's schedule, the big
 * button, and (for supervisors / foremen) clocking the crew in and out together. Location is read
 * once at each punch, never in between.
 */
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { buttons, durationText, workedMs } from '@/core/clock';
import type { ClockEvent, Geo } from '@/core/contract';
import { suggestJob, type Suggestion } from '@/core/geo';
import { currentFix } from '@/lib/device';
import { useApp } from '@/state/app';
import { costCodesFor, currentVisit, jobById, scheduleCostCode, timeOf } from '@/state/selectors';
import { Button, Card, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { CameraButton, JobPicker, SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

export default function Clock() {
  const app = useApp();
  const { t, today, shift, crewShift, lang } = app;
  const [here, setHere] = useState<Geo | null>(null);
  const [locating, setLocating] = useState(true);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [jobId, setJobId] = useState<string | null>(shift.jobId);
  const [costCodeId, setCostCodeId] = useState<string | null>(shift.costCodeId);
  const [crewIds, setCrewIds] = useState<string[]>(crewShift.crewEmployeeIds);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    let alive = true;
    void currentFix().then((g) => {
      if (!alive) return;
      setHere(g);
      setLocating(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!today) return;
    const sug = suggestJob(today.jobs, here, today.assignments, today.today);
    setSuggestion(sug);
    if (!jobId && shift.phase === 'idle' && sug) {
      setJobId(sug.job.id);
      setCostCodeId(scheduleCostCode(today, sug.job.id));
    }
  }, [today, here]); // only when the bundle or the fix changes, not on every pick

  const codes = useMemo(() => costCodesFor(today, jobId), [today, jobId]);
  const scheduled = scheduleCostCode(today, jobId);
  const visit = currentVisit(today);
  const b = buttons(shift, !!visit && visit.jobId === jobId);
  const job = jobById(today, shift.phase === 'idle' ? jobId : shift.jobId);
  const pickable = shift.phase === 'idle' || shift.phase === 'en_route';

  const say = (r: { ok: true; savedOffline: boolean } | { ok: false; error: string }) => {
    setMsg(r.ok ? { text: r.savedOffline ? t('savedOffline') : t('saved'), tone: r.savedOffline ? 'sky' : 'ok' } : { text: r.error, tone: 'danger' });
    setTimeout(() => setMsg(null), 3000);
  };

  const press = async (event: ClockEvent, crew = false) => {
    const target = crew ? crewShift : shift;
    if (!jobId && (target.phase === 'idle' || event === 'SWITCH')) {
      setMsg({ text: t('pickJobFirst'), tone: 'danger' });
      return;
    }
    if (crew && target.phase === 'idle' && !crewIds.length) {
      setMsg({ text: t('noCrew'), tone: 'danger' });
      return;
    }
    setBusy(`${crew ? 'crew' : 'me'}:${event}`);
    const startInput = { jobId, costCodeId, assignmentId: !crew && visit && visit.jobId === jobId ? visit.id : null, ...(crew ? { crewEmployeeIds: crewIds } : {}) };
    const r = await app.clock(event, target.phase === 'idle' || event === 'SWITCH' ? startInput : {}, { crew });
    setBusy(null);
    say(r);
  };

  const crewB = buttons(crewShift, false);
  const crewList = today?.crew ?? [];

  return (
    <Screen
      title={t('tabClock')}
      right={<SyncBadge />}
      overlay={<CameraButton jobId={job?.id ?? jobId} />}
      footer={
        <View style={{ gap: 10, paddingRight: 88 }}>
          {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
          <Button big tone={b.primary === 'OUT' ? 'danger' : 'primary'} label={t(b.primary)} busy={busy === `me:${b.primary}`} onPress={() => void press(b.primary)} />
          {b.secondary.length ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {b.secondary.map((e) => <View key={e} style={{ flex: 1 }}><Button label={t(e)} busy={busy === `me:${e}`} onPress={() => void press(e)} /></View>)}
            </View>
          ) : null}
        </View>
      }
    >
      <Card tone={shift.phase === 'working' ? 'sky' : undefined}>
        <Text style={font.hero}>
          {shift.phase === 'working' ? t('onClockFor', { time: durationText(workedMs(shift, now)) })
            : shift.phase === 'break' ? t('onBreakSince', { time: timeOf(shift.breakStartedAt, lang) ?? '' })
            : shift.phase === 'en_route' ? t('onTheWay') : t('offClock')}
        </Text>
        {job ? <Text style={font.regular}>{jobLabel(job)}</Text> : null}
        <Text style={font.muted}>{locating ? '…' : here ? t('locationOnce') : t('locationOff')}</Text>
      </Card>

      {pickable || shift.phase === 'working' ? (
        <Section title={t('pickJob')} right={suggestion && suggestion.job.id === jobId ? <Pill tone="primary" text={suggestion.why === 'here' ? t('suggestedHere') : suggestion.why === 'visit' ? t('suggestedVisit') : t('suggestedOnly')} /> : null}>
          <JobPicker
            jobs={today?.jobs ?? []}
            value={jobId}
            onChange={(id) => {
              setJobId(id);
              setCostCodeId(scheduleCostCode(today, id));
            }}
          />
        </Section>
      ) : null}

      {jobId && (pickable || shift.phase === 'working') ? (
        <Section title={t('pickCostCode')}>
          <Row title={t('noCostCode')} selected={!costCodeId} onPress={() => setCostCodeId(null)} />
          {codes.slice(0, 30).map((c) => (
            <Row key={c.id} title={`${c.code} · ${c.name}`} sub={c.id === scheduled ? t('costCodeFromSchedule') : null} selected={c.id === costCodeId} onPress={() => setCostCodeId(c.id)} />
          ))}
        </Section>
      ) : null}

      {today?.can.crewClock ? (
        <Section title={t('crewClock')}>
          <Text style={font.muted}>{t('crewClockBody')}</Text>
          {!crewList.length ? <Text style={font.muted}>{t('noCrew')}</Text> : null}
          {crewList.map((m) => {
            const on = crewIds.includes(m.employeeId);
            return (
              <Row
                key={`${m.crewId}:${m.employeeId}`}
                title={m.name}
                sub={m.crewName}
                selected={on}
                onPress={crewShift.phase === 'idle' ? () => setCrewIds((ids) => (on ? ids.filter((x) => x !== m.employeeId) : [...ids, m.employeeId])) : undefined}
              />
            );
          })}
          {crewList.length ? (
            <>
              {crewShift.phase !== 'idle' ? <Pill tone="primary" text={t('crewOnClock', { n: crewShift.crewEmployeeIds.length })} /> : null}
              <Button tone={crewB.primary === 'OUT' ? 'danger' : 'primary'} label={t(crewB.primary)} busy={busy === `crew:${crewB.primary}`} onPress={() => void press(crewB.primary, true)} />
              {crewB.secondary.filter((e) => e !== 'SWITCH').map((e) => <Button key={e} label={t(e)} busy={busy === `crew:${e}`} onPress={() => void press(e, true)} />)}
            </>
          ) : null}
        </Section>
      ) : null}
    </Screen>
  );
}
