/** Photos for a job: what this phone took (sent or still waiting), and the camera. */
import { useMemo, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { PhotoCommand } from '@/core/contract';
import { capturePhoto, photoExists } from '@/lib/device';
import { useApp } from '@/state/app';
import { jobById } from '@/state/selectors';
import { Button, Notice, Pill, Screen, Section } from '@/ui/components';
import { JobPicker, SyncBadge, jobLabel } from '@/ui/chrome';
import { color, font, size } from '@/ui/theme';

export default function Photos() {
  const app = useApp();
  const { t, today, queued } = app;
  const params = useLocalSearchParams<{ jobId?: string }>();
  const [jobId, setJobId] = useState<string | null>(params.jobId || app.currentJobId);
  const [msg, setMsg] = useState<string | null>(null);
  const job = jobById(today, jobId);

  const mine = useMemo(
    () => queued.filter((q) => q.command.kind === 'photo.upload' && q.command.jobId === jobId && q.fileUri && photoExists(q.fileUri)).reverse(),
    [queued, jobId],
  );

  const take = async () => {
    if (!jobId) {
      setMsg(t('pickJobFirst'));
      return;
    }
    const id = app.newId();
    const shot = await capturePhoto(id);
    if (!shot.ok) {
      if (shot.reason === 'denied') setMsg(t('cameraDenied'));
      else if (shot.reason === 'too_large') setMsg(t('photoTooLarge'));
      return;
    }
    await app.record<PhotoCommand>({ id, kind: 'photo.upload', jobId }, { fileUri: shot.uri });
    setMsg(t('photoSavedPhone'));
  };

  return (
    <Screen
      title={job ? t('photosFor', { job: jobLabel(job) }) : t('photos')}
      right={<SyncBadge />}
      footer={
        <>
          {msg ? <Notice text={msg} tone="sky" /> : null}
          <Button big tone="primary" label={t('takePhoto')} onPress={() => void take()} />
          <Button label={t('back')} onPress={() => router.back()} />
        </>
      }
    >
      <Section title={t('pickJob')}>
        <JobPicker jobs={today?.jobs ?? []} value={jobId} onChange={setJobId} />
      </Section>
      <Section title={t('photos')}>
        {!mine.length ? <Text style={font.muted}>{t('noPhotos')}</Text> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {mine.map((q) => (
            <View key={q.id} style={{ width: '47%', gap: 6 }}>
              <Image source={{ uri: q.fileUri! }} style={{ width: '100%', aspectRatio: 1, borderRadius: size.radius, backgroundColor: color.faint }} accessibilityIgnoresInvertColors />
              <Pill text={q.status === 'done' ? t('saved') : q.status === 'rejected' ? t('notSavedTitle') : t('stateWaiting')} tone={q.status === 'done' ? 'ok' : q.status === 'rejected' ? 'danger' : 'warn'} />
            </View>
          ))}
        </View>
      </Section>
    </Screen>
  );
}
