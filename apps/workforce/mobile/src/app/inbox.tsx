/**
 * Inbox: my notifications from Merit Projects and Merit Books (one suite inbox, core.notifications),
 * already masked per person by the database. Tap one to open its screen here (and mark it read);
 * "Done" clears it. Read / done marks are queued like any write, so they work offline.
 */
import { useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { InboxItem, NotificationMarkCommand } from '@/core/contract';
import { markDraft, overlayInbox } from '@/core/inbox';
import { routeForUrl } from '@/notifications/core';
import { useApp } from '@/state/app';
import { agoText, timeOf } from '@/state/selectors';
import { Button, Card, Notice, Pill, s } from '@/ui/components';
import { SyncBadge } from '@/ui/chrome';
import { color, font } from '@/ui/theme';

export default function Inbox() {
  const app = useApp();
  const { t, lang, inbox, queued } = app;
  const insets = useSafeAreaInsets();
  const [pulling, setPulling] = useState(false);
  const view = useMemo(() => overlayInbox(inbox, queued), [inbox, queued]);

  useEffect(() => {
    if (app.online) void app.refreshSide();
    // once per visit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mark = (ids: string[], state: 'read' | 'done') => {
    if (ids.length) void app.record<NotificationMarkCommand>(markDraft(ids, state), { geo: null });
  };

  const open = (i: InboxItem) => {
    if (!i.readAt) mark([i.id], 'read');
    const target = routeForUrl(i.deepLink);
    if (target.route !== '/' || target.params.job) router.push({ pathname: target.route, params: target.params } as unknown as Href);
  };

  const when = (iso: string) => {
    const d = new Date(iso);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? timeOf(iso, lang) ?? '' : d.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={font.title} accessibilityRole="header">{t('inboxTitle')}</Text>
        <SyncBadge />
      </View>
      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={async () => { setPulling(true); await app.flush(); await app.refreshSide(); setPulling(false); }} />}
      >
        {app.push === 'denied' ? <Notice text={t('pushOff')} /> : null}
        {!app.online && app.inboxAt ? <Notice text={t('inboxSaved', { when: agoText(app.inboxAt, lang) })} tone="sky" /> : null}
        {view.unread ? <Text style={font.strong}>{t('inboxNew', { n: view.unread })}</Text> : null}
        {!view.items.length ? <Text style={font.muted}>{t('inboxEmpty')}</Text> : null}
        {view.items.map((i) => (
          <Card key={i.id} tone={!i.readAt && i.severity !== 'info' ? 'sky' : undefined}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={[font.eyebrow, { color: i.severity === 'critical' ? color.danger : color.muted }]}>{i.jobLabel ?? (i.sourceApp === 'books' ? 'Merit Books' : 'Merit Projects')}</Text>
              <Text style={font.muted}>{when(i.createdAt)}</Text>
            </View>
            <Text style={i.readAt ? font.regular : font.strong}>{i.title}</Text>
            {i.body ? <Text style={font.muted} numberOfLines={4}>{i.body}</Text> : null}
            {i.itemCount > 1 ? <Pill text={`× ${i.itemCount}`} /> : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1.4 }}><Button label={t('openInBooks')} tone="primary" onPress={() => open(i)} /></View>
              <View style={{ flex: 1 }}><Button label={t('markDone')} onPress={() => mark([i.id], 'done')} /></View>
            </View>
          </Card>
        ))}
      </ScrollView>
      <View style={s.footer}>
        {view.unread ? <Button label={t('markAllRead')} onPress={() => mark(view.items.filter((i) => !i.readAt).map((i) => i.id), 'read')} /> : null}
        <Button label={t('back')} onPress={() => router.back()} />
      </View>
    </View>
  );
}
