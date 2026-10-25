/**
 * Dealer technician (DLR-47/48): clock on and off per repair-order line, switch lines, indirect
 * time (shop, waiting on parts, training, cleanup), and the complaint / cause / correction story on
 * a line by voice (the keyboard's dictation microphone — offline on the phone, no recording kept).
 * Every tap is queued with the time it was tapped. The office reviews a tap that arrives more than
 * 15 minutes late (the screen says so) and refuses one older than 72 hours, ahead of the real time
 * or overlapping another punch (shown here with the reason, never retried); the banner shows what I am on,
 * including taps not yet sent. Hours only.
 */
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RO_INDIRECT, type RoBundle, type RoClockCommand, type RoIndirect, type RoLineStoryCommand } from '@/core/contract';
import { currentPunch, isRoBundle, refusedTaps, roClockDraft, storiesFor, storyDraft, storyLine, storyReady, type Story } from '@/core/ro';
import { tapAge } from '@/core/station';
import { useApp } from '@/state/app';
import { useCached } from '@/state/cache';
import { agoText, hoursText, timeOf } from '@/state/selectors';
import { Button, Card, Field, Notice, Pill, Row, Section, s } from '@/ui/components';
import { CameraButton, SyncBadge } from '@/ui/chrome';
import { font } from '@/ui/theme';

const EMPTY: Story = { complaint: '', cause: '', correction: '' };

export default function RepairOrders() {
  const app = useApp();
  const { t, lang, queued } = app;
  const insets = useSafeAreaInsets();
  const data = useCached<RoBundle>('ro.bundle', isRoBundle, () => app.api.ro(), app.online);
  const b = data.value;
  const [openRo, setOpenRo] = useState<string | null>(null);
  const [story, setStory] = useState<Story>(EMPTY);
  const [storyLineId, setStoryLineId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);
  const [pulling, setPulling] = useState(false);

  const punch = useMemo(() => currentPunch(b, queued), [b, queued]);
  // the office reviews a tap that arrives more than 15 min after it was tapped (and refuses one over 72 h)
  const late = queued.filter((q) => q.command.kind === 'ro.clock' && (q.status === 'pending' || q.status === 'sending') && tapAge(q.command.at, Date.now()) !== 'fresh').length;
  const lineBy = useMemo(() => new Map((b?.lines ?? []).map((l) => [l.id, l])), [b?.lines]);
  const roBy = useMemo(() => new Map((b?.ros ?? []).map((r) => [r.id, r])), [b?.ros]);
  const onLine = punch?.lineId ? lineBy.get(punch.lineId) : undefined;
  const onRo = onLine ? roBy.get(onLine.workOrderId) : undefined;
  const store = punch?.companyId ?? b?.stores[0]?.companyId ?? null;

  const say = (text: string, tone: 'ok' | 'danger' | 'sky' = app.online ? 'ok' : 'sky') => {
    setMsg({ text, tone });
    setTimeout(() => setMsg(null), app.online ? 2500 : 6000);
  };

  const tap = async (op: RoClockCommand['op'], companyId: string, extra: { lineId?: string; indirectKind?: RoIndirect } = {}) => {
    try {
      await app.record<RoClockCommand>(roClockDraft(op, companyId, extra));
      say(app.online ? t('saved') : t('roTimeKept'));
    } catch (e) {
      say(t('error', { reason: e instanceof Error ? e.message : '' }), 'danger');
    }
  };

  const saveStory = async (woId: string) => {
    if (!storyReady(story)) return say(t('storyNeedsSomething'), 'danger');
    const lineId = storyLineId ?? storyLine(woId, b?.lines ?? [], punch);
    if (!lineId) return say(t('roLinePick'), 'danger');
    await app.record<RoLineStoryCommand>(storyDraft(woId, lineId, story), { geo: null });
    setStory(EMPTY);
    setStoryLineId(null);
    say(t('storySaved'));
  };

  const bannerTitle = !punch ? t('roOff')
    : punch.kind === 'LINE' ? t('roOnLine', { line: [onRo?.number, onLine?.description].filter(Boolean).join(' · ') || '—' })
    : t(`indirect_${punch.kind}`);

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={font.title} accessibilityRole="header">{t('roTitle')}</Text>
        <SyncBadge />
      </View>
      <ScrollView
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={async () => { setPulling(true); await app.flush(); await data.refresh(); setPulling(false); }} />}
      >
        {!b ? <Notice text={data.loading ? t('loadingWork') : t('roLoadFailed')} tone={data.loading ? 'sky' : 'warn'} /> : null}
        {b && !app.online && data.at ? <Notice text={t('inboxSaved', { when: agoText(data.at, lang) })} tone="sky" /> : null}

        {late ? <Notice text={late === 1 ? t('roLate') : t('roLateN', { n: late })} /> : null}
        {refusedTaps(queued).map((r) => (
          <Card key={r.id} tone="danger">
            <Text style={font.regular}>{t('clockRefused', { reason: r.reason })}</Text>
            {tapAge(r.at, Date.now()) === 'stale' || /stale|72/i.test(r.reason) ? <Text style={font.regular}>{t('roStale')}</Text> : null}
            <Text style={font.muted}>{timeOf(r.at, lang) ?? ''}</Text>
            <Button label={t('clear')} onPress={() => void app.dismiss(r.id)} />
          </Card>
        ))}

        <Card tone={punch ? 'sky' : undefined}>
          <Text style={font.title}>{bannerTitle}</Text>
          {punch ? <Text style={font.muted}>{t('roSince', { time: timeOf(punch.since, lang) ?? '' })}{punch.waiting ? ` · ${t('stateWaiting')}` : ''}</Text> : null}
          {punch && store ? <Button big tone="danger" label={t('roClockOff')} onPress={() => void tap('clock_off', punch.companyId)} /> : null}
        </Card>

        {b && !b.ros.length ? <Text style={font.muted}>{t('roNone')}</Text> : null}
        {b?.ros.map((ro) => {
          const lines = b.lines.filter((l) => l.workOrderId === ro.id);
          const expanded = openRo === ro.id;
          const saved = storiesFor(ro.id, queued);
          return (
            <Section key={ro.id} title={[ro.number, ro.summary].filter(Boolean).join(' · ')} right={ro.mine ? <Pill text={t('roMine')} tone="primary" /> : null}>
              {lines.map((l) => {
                const on = punch?.lineId === l.id;
                return (
                  <Row
                    key={l.id}
                    title={[l.laborOp, l.description].filter(Boolean).join(' · ')}
                    sub={l.flagHours != null ? t('flatHours', { h: hoursText(l.flagHours) }) : null}
                    selected={on}
                    right={on ? <Pill text={t('saved')} tone="ok" /> : <Pill text={punch ? t('roSwitch') : t('roClockOn')} tone="primary" />}
                    onPress={on ? undefined : () => void tap('clock_on', ro.companyId, { lineId: l.id })}
                  />
                );
              })}
              {lines.length ? <Button label={t('story')} onPress={() => { setOpenRo(expanded ? null : ro.id); setStory(EMPTY); setStoryLineId(null); }} /> : null}
              {expanded ? (
                <Card>
                  <Text style={font.muted}>{t('storyHint')}</Text>
                  {lines.length > 1 ? (
                    <View style={{ gap: 6 }}>
                      <Text style={font.strong}>{t('roLinePick')}</Text>
                      {lines.map((l) => {
                        const chosen = (storyLineId ?? storyLine(ro.id, b.lines, punch)) === l.id;
                        return <Row key={l.id} title={[l.laborOp, l.description].filter(Boolean).join(' · ')} selected={chosen} onPress={() => setStoryLineId(l.id)} />;
                      })}
                    </View>
                  ) : null}
                  <Field label={t('complaint')} value={story.complaint} onChangeText={(v) => setStory((x) => ({ ...x, complaint: v }))} multiline maxLength={2000} autoFocus />
                  <Field label={t('cause')} value={story.cause} onChangeText={(v) => setStory((x) => ({ ...x, cause: v }))} multiline maxLength={2000} />
                  <Field label={t('correction')} value={story.correction} onChangeText={(v) => setStory((x) => ({ ...x, correction: v }))} multiline maxLength={2000} />
                  <Button tone="primary" big label={t('saveStory')} onPress={() => void saveStory(ro.id)} />
                </Card>
              ) : null}
              {saved.map((x) => (
                <Card key={x.id}>
                  <Text style={font.muted}>{`${timeOf(x.at, lang) ?? ''}${x.waiting ? ` · ${t('stateWaiting')}` : ''}`}</Text>
                  {x.story.complaint ? <Text style={font.regular}>{`${t('complaint')}: ${x.story.complaint}`}</Text> : null}
                  {x.story.cause ? <Text style={font.regular}>{`${t('cause')}: ${x.story.cause}`}</Text> : null}
                  {x.story.correction ? <Text style={font.regular}>{`${t('correction')}: ${x.story.correction}`}</Text> : null}
                </Card>
              ))}
            </Section>
          );
        })}

        {store ? (
          <Section title={t('indirectTitle')}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {RO_INDIRECT.map((k) => (
                <View key={k} style={{ flexBasis: '47%', flexGrow: 1 }}>
                  <Button label={t(`indirect_${k}`)} tone={punch?.kind === k ? 'primary' : 'secondary'} onPress={() => void tap('indirect', store, { indirectKind: k })} />
                </View>
              ))}
            </View>
          </Section>
        ) : null}
      </ScrollView>
      <View style={[s.footer, { paddingRight: 104 }]}>
        {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
        <Button label={t('back')} onPress={() => router.back()} />
      </View>
      <CameraButton jobId={onRo?.jobId ?? null} />
    </View>
  );
}
