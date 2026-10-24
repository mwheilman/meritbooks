/** What is waiting on this phone and what the office could not accept (with the reason). */
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { QueuedCommand } from '@/core/queue';
import type { StringKey } from '@/core/i18n';
import { useApp } from '@/state/app';
import { Button, Card, Notice, Screen, Section } from '@/ui/components';
import { SyncBadge } from '@/ui/chrome';
import { font } from '@/ui/theme';

const KIND: Readonly<Record<QueuedCommand['kind'], StringKey>> = {
  clock: 'tabClock', 'time.update': 'fixHours', 'time.submit': 'submitWeek', 'log.submit': 'logTitle',
  'checklist.submit': 'checklists', 'punch.create': 'punch', 'crew.approve': 'crewTitle', 'photo.upload': 'takePhoto',
};

function label(q: QueuedCommand, t: (k: StringKey) => string): string {
  if (q.command.kind === 'clock') return t(q.command.event);
  return t(KIND[q.kind]);
}

export default function Queue() {
  const app = useApp();
  const { t, queued, lang } = app;
  const rejected = queued.filter((q) => q.status === 'rejected');
  const waiting = queued.filter((q) => q.status === 'pending' || q.status === 'sending');
  const when = (q: QueuedCommand) => new Date(q.command.at).toLocaleString(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return (
    <Screen
      title={t('waitingTitle')}
      right={<SyncBadge />}
      footer={
        <>
          {waiting.length ? <Button big tone="primary" label={t('sendNow')} busy={app.syncing} onPress={() => void app.flush()} /> : null}
          <Button label={t('back')} onPress={() => router.back()} />
        </>
      }
    >
      {!app.online ? <Notice text={t('offline')} tone="sky" /> : null}
      {app.authProblem ? <Notice text={t('signInAgain')} tone="danger" /> : null}
      {rejected.length ? (
        <Section title={t('notSavedTitle')}>
          <Text style={font.muted}>{t('notSavedBody')}</Text>
          {rejected.map((q) => (
            <Card key={q.id} tone="danger">
              <Text style={font.strong}>{`${label(q, t)} · ${when(q)}`}</Text>
              <Text style={font.regular}>{q.result?.reason ?? q.lastError ?? ''}</Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}><Button label={t('tryAgain')} onPress={() => void app.retry(q.id)} /></View>
                <View style={{ flex: 1 }}><Button tone="danger" label={t('clear')} onPress={() => void app.dismiss(q.id)} /></View>
              </View>
            </Card>
          ))}
        </Section>
      ) : null}
      <Section title={t('waitingTitle')}>
        {!waiting.length ? <Text style={font.muted}>{t('allSaved')}</Text> : null}
        {waiting.map((q) => (
          <Card key={q.id}>
            <Text style={font.strong}>{`${label(q, t)} · ${when(q)}`}</Text>
            {q.lastError ? <Text style={font.muted}>{q.lastError}</Text> : null}
          </Card>
        ))}
      </Section>
    </Screen>
  );
}
