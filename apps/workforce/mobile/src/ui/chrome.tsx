/** Pieces every screen shares: the "All saved / 3 waiting" badge, the camera button, the job picker. */
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { FieldJob, PhotoCommand } from '@/core/contract';
import { useApp } from '@/state/app';
import { capturePhoto } from '@/lib/device';
import { Field, Notice, Row } from './components';
import { color, font, size } from './theme';

export function SyncBadge() {
  const { counts, online, syncing, authProblem, t } = useApp();
  const waitingText = counts.waiting === 1 ? t('waitingOne') : t('waiting', { n: counts.waiting });
  const text = counts.rejected ? t('notSaved', { n: counts.rejected })
    : !counts.waiting ? t('allSaved')
    : authProblem ? t('signInAgain')
    : syncing && online ? t('syncing')
    : waitingText;
  const fg = counts.rejected ? color.danger : counts.waiting ? color.warn : color.ok;
  const bg = counts.rejected ? color.dangerBg : counts.waiting ? color.warnBg : color.okBg;
  return (
    <Pressable
      onPress={() => router.push('/queue')}
      accessibilityRole="button"
      accessibilityLabel={online ? text : `${text}, ${t('offlineShort')}`}
      hitSlop={8}
      style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 999, backgroundColor: bg, borderWidth: 1.5, borderColor: fg, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 }}
    >
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: fg }} />
      <Text style={{ fontSize: 16, fontWeight: '700', color: fg }}>{text}</Text>
      {!online ? <Text style={{ fontSize: 16, color: fg }}>· {t('offlineShort')}</Text> : null}
    </Pressable>
  );
}

/** The camera on every screen: one tap, photo saved on the phone, queued for the current job. */
export function CameraButton({ jobId, attachTo, onTaken }: { jobId?: string | null; attachTo?: PhotoCommand['attachTo']; onTaken?: (commandId: string) => void }) {
  const app = useApp();
  const [msg, setMsg] = useState<string | null>(null);
  const target = jobId ?? app.currentJobId;
  const take = async () => {
    if (!target) {
      router.push('/photos');
      return;
    }
    const id = app.newId();
    const shot = await capturePhoto(id);
    if (!shot.ok) {
      if (shot.reason === 'denied') setMsg(app.t('cameraDenied'));
      else if (shot.reason === 'too_large') setMsg(app.t('photoTooLarge'));
      return;
    }
    await app.record<PhotoCommand>({ id, kind: 'photo.upload', jobId: target, attachTo: attachTo ?? null }, { fileUri: shot.uri, dependsOn: attachTo?.commandId ?? null });
    setMsg(app.t('photoSavedPhone'));
    onTaken?.(id);
    setTimeout(() => setMsg(null), 2500);
  };
  return (
    <View style={{ position: 'absolute', right: size.gutter, bottom: size.gutter + 8, alignItems: 'flex-end', gap: 8 }} pointerEvents="box-none">
      {msg ? <View style={{ maxWidth: 280 }}><Notice text={msg} tone="sky" /></View> : null}
      <Pressable
        onPress={() => void take()}
        accessibilityRole="button"
        accessibilityLabel={app.t('takePhoto')}
        style={({ pressed }) => ({ width: 72, height: 72, borderRadius: 36, backgroundColor: color.ink, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1, elevation: 4, shadowColor: color.ink, shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } })}
      >
        <View style={{ width: 30, height: 22, borderRadius: 4, borderWidth: 3, borderColor: color.onPrimary, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 3, borderColor: color.onPrimary }} />
        </View>
        <Text style={{ color: color.onPrimary, fontSize: 14, fontWeight: '700', marginTop: 2 }}>{app.t('takePhoto')}</Text>
      </Pressable>
    </View>
  );
}

export function jobLabel(j: Pick<FieldJob, 'number' | 'name'>): string {
  return [j.number, j.name].filter(Boolean).join(' · ');
}

/** Tap-to-pick job list with search (search shows when there are more than 6). */
export function JobPicker({ jobs, value, onChange }: { jobs: ReadonlyArray<FieldJob>; value: string | null; onChange: (id: string) => void }) {
  const { t } = useApp();
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? jobs.filter((j) => `${j.number ?? ''} ${j.name} ${j.customer ?? ''} ${j.address ?? ''}`.toLowerCase().includes(needle)) : jobs;
    return list.slice(0, 40);
  }, [jobs, q]);
  return (
    <View style={{ gap: 10 }}>
      {jobs.length > 6 ? <Field label={t('searchJobs')} value={q} onChangeText={setQ} autoCorrect={false} returnKeyType="search" /> : null}
      {shown.map((j) => (
        <Row key={j.id} title={jobLabel(j)} sub={[j.customer, j.address, j.company].filter(Boolean).join(' · ') || null} selected={j.id === value} onPress={() => onChange(j.id)} />
      ))}
      {!jobs.length ? <Text style={font.muted}>{t('nothingToday')}</Text> : null}
    </View>
  );
}
