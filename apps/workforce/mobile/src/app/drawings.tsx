/**
 * Drawings: the CURRENT set for a job, from the phone's own storage — opens with no signal.
 * Sheets by discipline, revision and set name on each; tap a sheet to open it in the phone's PDF
 * viewer (iOS can swipe through the whole set). With signal it checks for newer revisions and
 * replaces superseded sheets; an old revision is never shown as current.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PhoneSheet } from '@/core/contract';
import { byDiscipline, type CachedSheet } from '@/core/drawings';
import { drawingIndex, syncDrawings } from '@/lib/drawingsSync';
import { openPdfs } from '@/lib/files';
import { useApp } from '@/state/app';
import { agoText, drawingJobs, jobById } from '@/state/selectors';
import { Button, Notice, Pill, Row, Section, s } from '@/ui/components';
import { JobPicker, SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

export default function Drawings() {
  const app = useApp();
  const { t, today, extras, lang } = app;
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ jobId?: string }>();
  const [jobId, setJobId] = useState<string | null>(params.jobId || app.currentJobId);
  const [cached, setCached] = useState<CachedSheet[]>([]);
  const [manifest, setManifest] = useState<PhoneSheet[]>([]);
  const [at, setAt] = useState<number | null>(null);
  const [left, setLeft] = useState(0);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' | 'warn' } | null>(null);
  const [pulling, setPulling] = useState(false);

  const reload = useCallback(async () => {
    const i = await drawingIndex();
    setCached(i.sheets);
    setManifest(i.manifest);
    setAt(i.at);
  }, []);

  const sync = useCallback(async () => {
    if (!app.online) return;
    const d = drawingJobs(today, extras?.drawings, app.shift.jobId);
    const jobs = jobId && !d.jobs.includes(jobId) ? [jobId, ...d.jobs] : d.jobs;
    try {
      const r = await syncDrawings(app.api, jobs, [jobId, ...d.priority].filter((x): x is string => !!x), setLeft);
      if (r.skipped) setMsg({ text: t('drawingsSkipped', { n: r.skipped }), tone: 'warn' });
    } catch (e) {
      setMsg({ text: t('cantOpen', { reason: e instanceof Error ? e.message : '' }), tone: 'danger' });
    } finally {
      setLeft(0);
      await reload();
    }
  }, [app.api, app.online, app.shift.jobId, extras?.drawings, jobId, reload, t, today]);

  useEffect(() => {
    void reload().then(() => sync());
    // once per job
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const mine = useMemo(() => cached.filter((c) => c.jobId === jobId), [cached, jobId]);
  const missing = useMemo(() => manifest.filter((m) => m.jobId === jobId && !mine.some((c) => c.revisionId === m.revisionId)), [manifest, mine, jobId]);
  const job = jobById(today, jobId);
  const withSheets = (today?.jobs ?? []).filter((j) => (extras?.drawings[j.id] ?? 0) > 0 || cached.some((c) => c.jobId === j.id));

  const open = async (ids: string[]) => {
    const r = await openPdfs(ids);
    if (!r.ok) setMsg({ text: t('cantOpen', { reason: r.reason }), tone: 'danger' });
  };

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={font.title} accessibilityRole="header" numberOfLines={1}>{job ? t('drawingsFor', { job: jobLabel(job) }) : t('drawingsTitle')}</Text>
        <SyncBadge />
      </View>
      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={async () => { setPulling(true); await sync(); setPulling(false); }} />}
      >
        {!jobId ? <JobPicker jobs={withSheets} value={jobId} onChange={setJobId} /> : null}
        {left > 0 ? <Notice text={t('downloading', { n: left })} tone="sky" /> : null}
        {!app.online ? <Notice text={t('drawingsOffline')} tone="sky" /> : at && mine.length ? <Text style={font.muted}>{t('drawingsCurrent', { when: agoText(at, lang) })}</Text> : null}
        {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
        {jobId && !mine.length && !missing.length && left === 0 ? <Text style={font.muted}>{t('drawingsNone')}</Text> : null}
        {byDiscipline(mine).map(([discipline, list]) => (
          <Section key={discipline} title={discipline}>
            {list.map((c) => (
              <Row
                key={c.revisionId}
                title={[c.number, c.title].filter(Boolean).join(' · ')}
                sub={[c.revisionLabel ? t('revLabel', { rev: c.revisionLabel }) : null, c.setName, c.issuedOn].filter(Boolean).join(' · ')}
                right={<Pill text={t('onPhone')} tone="ok" />}
                onPress={() => void open([c.revisionId])}
              />
            ))}
          </Section>
        ))}
        {missing.length ? (
          <Section title={t('notDownloaded')}>
            {missing.map((m) => <Row key={m.revisionId} title={[m.number, m.title].filter(Boolean).join(' · ')} sub={m.setName} right={<Pill text={t('notDownloaded')} tone="warn" />} />)}
          </Section>
        ) : null}
        {jobId && withSheets.length > 1 ? (
          <Section title={t('pickJob')}>
            <JobPicker jobs={withSheets} value={jobId} onChange={setJobId} />
          </Section>
        ) : null}
      </ScrollView>
      <View style={s.footer}>
        {mine.length > 1 ? <Button big tone="primary" label={t('openAll')} onPress={() => void open(byDiscipline(mine).flatMap(([, l]) => l.map((c) => c.revisionId)))} /> : null}
        {app.online ? <Button label={t('refreshNow')} busy={left > 0} onPress={() => void sync()} /> : null}
        <Button label={t('back')} onPress={() => router.back()} />
      </View>
    </View>
  );
}
