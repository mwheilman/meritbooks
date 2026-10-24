/**
 * Daily log: talk instead of type (the keyboard's dictation mic), weather filled in from where I
 * am, crew and hours, photos attached to this log, and a signature. Saved on the phone first.
 */
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { LogSubmitCommand, Weather } from '@/core/contract';
import { currentFix, localDay } from '@/lib/device';
import { weatherAt } from '@/lib/weather';
import { useApp } from '@/state/app';
import { jobById } from '@/state/selectors';
import { Button, Choice, Field, Notice, Screen, Section } from '@/ui/components';
import { CameraButton, JobPicker, SyncBadge, jobLabel } from '@/ui/chrome';
import { SignaturePad } from '@/ui/SignaturePad';
import { font } from '@/ui/theme';

const num = (s: string): number | null => {
  const n = Number(s.replace(',', '.'));
  return s.trim() && Number.isFinite(n) && n >= 0 ? n : null;
};

export default function DailyLog() {
  const app = useApp();
  const { t, today } = app;
  const [logId, setLogId] = useState(() => app.newId());
  const [jobId, setJobId] = useState<string | null>(app.currentJobId);
  const [body, setBody] = useState('');
  const [weather, setWeather] = useState<Weather | null>(null);
  const [conditions, setConditions] = useState('');
  const [weatherState, setWeatherState] = useState<'loading' | 'auto' | 'none'>('loading');
  const [delay, setDelay] = useState<'no' | 'yes'>('no');
  const [crew, setCrew] = useState('');
  const [hours, setHours] = useState('');
  const [name, setName] = useState(today?.me.name ?? '');
  const [sig, setSig] = useState<string | null>(null);
  const [photos, setPhotos] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);

  useEffect(() => {
    if (!jobId && app.currentJobId) setJobId(app.currentJobId);
  }, [app.currentJobId, jobId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const job = jobById(today, jobId);
      const fix = job?.lat != null && job.lng != null ? { lat: job.lat, lng: job.lng } : await currentFix();
      const w = fix ? await weatherAt(fix) : null;
      if (!alive) return;
      setWeather(w);
      setConditions([w?.conditions, w?.highF != null && w.lowF != null ? `${w.highF}° / ${w.lowF}°F` : null].filter(Boolean).join(', '));
      setWeatherState(w ? 'auto' : 'none');
    })();
    return () => {
      alive = false;
    };
  }, [jobId]); // re-read the weather when the job (and so the site) changes

  const job = jobById(today, jobId);

  const submit = async () => {
    if (!jobId) {
      setMsg({ text: t('pickJobFirst'), tone: 'danger' });
      return;
    }
    if (!body.trim() && num(crew) == null && num(hours) == null && !conditions.trim()) {
      setMsg({ text: t('logNeedsSomething'), tone: 'danger' });
      return;
    }
    if (!name.trim()) {
      setMsg({ text: t('logNeedsSign'), tone: 'danger' });
      return;
    }
    setBusy(true);
    const typed = conditions.trim() !== [weather?.conditions, weather?.highF != null && weather?.lowF != null ? `${weather.highF}° / ${weather.lowF}°F` : null].filter(Boolean).join(', ');
    const w: Weather | null = conditions.trim() || delay === 'yes'
      ? { ...(typed ? { conditions: conditions.trim().slice(0, 80), source: 'typed' as const } : { ...weather, source: 'auto' as const }), ...(delay === 'yes' ? { delay: true } : {}) }
      : null;
    try {
      await app.record<LogSubmitCommand>({
        id: logId, kind: 'log.submit', jobId, logDate: localDay(), logKind: 'DAILY', body: body.trim() || null, weather: w,
        crewCount: num(crew) != null ? Math.round(num(crew)!) : null, hours: num(hours),
        signature: { name: name.trim().slice(0, 120), path: sig, signedAt: new Date().toISOString() },
      });
      setMsg({ text: app.online ? t('saved') : t('savedOffline'), tone: app.online ? 'ok' : 'sky' });
      setLogId(app.newId());
      setBody('');
      setCrew('');
      setHours('');
      setSig(null);
      setPhotos(0);
      setDelay('no');
    } catch (e) {
      setMsg({ text: t('error', { reason: e instanceof Error ? e.message : '' }), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={t('logTitle')}
      right={<SyncBadge />}
      overlay={<CameraButton jobId={jobId} attachTo={{ kind: 'log', commandId: logId }} onTaken={() => setPhotos((n) => n + 1)} />}
      footer={
        <View style={{ gap: 10, paddingRight: 88 }}>
          {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
          <Button big tone="primary" label={t('submitLog')} onPress={() => void submit()} busy={busy} />
        </View>
      }
    >
      <Section title={t('pickJob')}>
        {job ? <Text style={font.strong}>{t('logFor', { job: jobLabel(job) })}</Text> : null}
        <JobPicker jobs={today?.jobs ?? []} value={jobId} onChange={setJobId} />
      </Section>

      <Section title={t('whatHappened')}>
        <Field label={t('whatHappened')} value={body} onChangeText={setBody} multiline maxLength={8000} autoCapitalize="sentences" />
        <Text style={font.muted}>{t('dictateHint')}</Text>
      </Section>

      <Section title={t('weather')}>
        <Field label={t('weather')} value={conditions} onChangeText={setConditions} maxLength={80} />
        <Text style={font.muted}>{weatherState === 'loading' ? '…' : weatherState === 'auto' ? t('weatherAuto') : t('weatherNone')}</Text>
        <Text style={font.strong}>{t('weatherDelay')}</Text>
        <Choice options={[{ value: 'no' as const, label: t('no') }, { value: 'yes' as const, label: t('yes'), tone: 'danger' as const }]} value={delay} onChange={setDelay} />
      </Section>

      <Section title={t('crewCount')}>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}><Field label={t('crewCount')} value={crew} onChangeText={setCrew} keyboardType="number-pad" maxLength={4} /></View>
          <View style={{ flex: 1 }}><Field label={t('hoursWorked')} value={hours} onChangeText={setHours} keyboardType="decimal-pad" maxLength={6} /></View>
        </View>
      </Section>

      <Section title={t('photos')}>
        <Text style={font.muted}>{photos ? t('photoTaken', { n: photos }) : t('noPhotos')}</Text>
      </Section>

      <Section title={t('sign')}>
        <SignaturePad key={logId} label={t('signHere')} clearLabel={t('clearSignature')} onChange={setSig} />
        <Field label={t('typeName')} value={name} onChangeText={setName} autoCapitalize="words" maxLength={120} />
      </Section>
    </Screen>
  );
}
