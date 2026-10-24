/** Punch list for a job: what is open (from the office), what this phone added, and "Add a punch item". */
import { useMemo, useState } from 'react';
import { Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { PunchCreateCommand } from '@/core/contract';
import { useApp } from '@/state/app';
import { jobById } from '@/state/selectors';
import { Button, Card, Field, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { CameraButton, JobPicker, SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

export default function Punch() {
  const app = useApp();
  const { t, today, queued } = app;
  const params = useLocalSearchParams<{ jobId?: string }>();
  const [jobId, setJobId] = useState<string | null>(params.jobId || app.currentJobId);
  const [adding, setAdding] = useState(false);
  const [punchId, setPunchId] = useState(() => app.newId());
  const [title, setTitle] = useState('');
  const [area, setArea] = useState('');
  const [details, setDetails] = useState('');
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);
  const job = jobById(today, jobId);
  const open = (today?.punch ?? []).filter((p) => p.jobId === jobId);
  const local = useMemo(() => queued.filter((q) => q.command.kind === 'punch.create' && q.command.jobId === jobId && q.status !== 'done' && q.status !== 'dismissed'), [queued, jobId]);
  const canAdd = !!today?.can.punch;

  const add = async () => {
    if (!jobId || !title.trim()) return;
    await app.record<PunchCreateCommand>({ id: punchId, kind: 'punch.create', jobId, title: title.trim(), area: area.trim() || null, description: details.trim() || null });
    setMsg({ text: app.online ? t('saved') : t('savedOffline'), tone: app.online ? 'ok' : 'sky' });
    setTitle('');
    setArea('');
    setDetails('');
    setAdding(false);
    setPunchId(app.newId());
  };

  return (
    <Screen
      title={job ? `${t('punch')} · ${jobLabel(job)}` : t('punch')}
      right={<SyncBadge />}
      overlay={adding ? <CameraButton jobId={jobId} attachTo={{ kind: 'punch', commandId: punchId }} /> : undefined}
      footer={
        <>
          {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
          {adding ? <Button big tone="primary" label={t('addPunch')} disabled={!title.trim()} onPress={() => void add()} />
            : canAdd ? <Button big tone="primary" label={t('newPunch')} disabled={!jobId} onPress={() => setAdding(true)} /> : null}
          <Button label={adding ? t('cancel') : t('back')} onPress={() => (adding ? setAdding(false) : router.back())} />
        </>
      }
    >
      {!canAdd ? <Notice text={t('punchNotAllowed')} tone="sky" /> : null}
      {adding ? (
        <Card>
          <Field label={t('punchTitle')} value={title} onChangeText={setTitle} maxLength={200} autoFocus />
          <Field label={t('punchArea')} value={area} onChangeText={setArea} maxLength={120} />
          <Field label={t('punchDetails')} value={details} onChangeText={setDetails} multiline maxLength={4000} />
          <Text style={font.muted}>{t('dictateHint')}</Text>
        </Card>
      ) : (
        <>
          <Section title={t('pickJob')}>
            <JobPicker jobs={today?.jobs ?? []} value={jobId} onChange={setJobId} />
          </Section>
          <Section title={t('punch')}>
            {!open.length && !local.length ? <Text style={font.muted}>{t('nothingLater')}</Text> : null}
            {local.map((q) => q.command.kind === 'punch.create' ? (
              <Row key={q.id} title={q.command.title} sub={q.status === 'rejected' ? q.result?.reason ?? null : t('punchFromPhone')} right={<Pill text={q.status === 'rejected' ? t('notSavedTitle') : t('stateWaiting')} tone={q.status === 'rejected' ? 'danger' : 'warn'} />} />
            ) : null)}
            {open.map((p) => <Row key={p.id} title={p.title} sub={[p.area, p.dueOn].filter(Boolean).join(' · ') || null} right={<Pill text={p.status.replace(/_/g, ' ').toLowerCase()} />} />)}
          </Section>
        </>
      )}
    </Screen>
  );
}
