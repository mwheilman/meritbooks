/**
 * Me: my week of hours (what the server has + what is still on this phone), corrections and
 * "send my week", then pay, commissions and receipts — cards Merit Books owns, shown only when
 * the company has Merit Books and Books answers for them. Amounts stay hidden until "Show".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { TimeSubmitCommand, TimeUpdateCommand } from '@/core/contract';
import { totalHours, weekLines, type WeekLine } from '@/core/overlay';
import type { BooksCard, BooksCommissions, BooksPay, BooksReceipts } from '@/lib/api';
import { localDay } from '@/lib/device';
import { useApp } from '@/state/app';
import { dayLabel, hoursText, jobById } from '@/state/selectors';
import { Button, Card, Choice, Field, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d.getTime());
};

export default function Me() {
  const app = useApp();
  const { t, today, lang, queued } = app;
  const [editing, setEditing] = useState<string | null>(null);
  const [newHours, setNewHours] = useState('');
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);
  const [receipts, setReceipts] = useState<BooksCard<BooksReceipts> | null>(null);
  const [pay, setPay] = useState<BooksCard<BooksPay> | null>(null);
  const [commissions, setCommissions] = useState<BooksCard<BooksCommissions> | null>(null);
  const [showAmounts, setShowAmounts] = useState(false);

  const weekStart = today?.weekStart ?? localDay();
  const lines = useMemo(() => weekLines(today?.week ?? [], queued, (iso) => localDay(iso), weekStart, addDays(weekStart, 6)), [today?.week, queued, weekStart]);
  const toSubmit = lines.filter((l) => l.entryId && (l.state === 'DRAFT' || l.state === 'REJECTED') && !l.waiting).map((l) => l.entryId!);

  const loadBooks = useCallback(() => {
    if (!today?.booksPresent || !app.online) return;
    void app.api.receipts().then(setReceipts);
    void app.api.pay().then(setPay);
    void app.api.commissions().then(setCommissions);
  }, [app.api, app.online, today?.booksPresent]);
  useFocusEffect(loadBooks);
  useEffect(() => setShowAmounts(false), [today?.me.employeeId]);

  const say = (text: string, tone: 'ok' | 'danger' | 'sky') => {
    setMsg({ text, tone });
    setTimeout(() => setMsg(null), 3000);
  };

  const saveHours = async (l: WeekLine) => {
    const h = Number(newHours.replace(',', '.'));
    if (!l.entryId || !Number.isFinite(h) || h <= 0 || h > 24) return;
    await app.record<TimeUpdateCommand>({ kind: 'time.update', entryId: l.entryId, hours: Math.round(h * 100) / 100 }, { geo: null });
    setEditing(null);
    say(app.online ? t('saved') : t('savedOffline'), app.online ? 'ok' : 'sky');
  };

  const submitWeek = async () => {
    if (!toSubmit.length) return;
    await app.record<TimeSubmitCommand>({ kind: 'time.submit', entryIds: toSubmit }, { geo: null });
    say(t('weekSent'), 'ok');
  };

  const signOut = () => {
    const doIt = () => void app.signOutEverywhere();
    if (app.counts.waiting) {
      Alert.alert(t('signOut'), `${t('waiting', { n: app.counts.waiting })}. ${t('savedOffline')}`, [
        { text: t('cancel'), style: 'cancel' },
        { text: t('signOut'), style: 'destructive', onPress: doIt },
      ]);
    } else doIt();
  };

  const stateText = (l: WeekLine) => (l.waiting ? t('stateWaiting') : t(`state${l.state}` as const));
  const stateTone = (l: WeekLine) => (l.refused ? 'danger' : l.state === 'APPROVED' ? 'ok' : l.state === 'REJECTED' ? 'danger' : l.waiting ? 'warn' : 'muted') as 'danger' | 'ok' | 'warn' | 'muted';

  const neededCount = receipts?.state === 'ok' ? receipts.value.cards.reduce((s, c) => s + (c.chaseOn ? c.needed.length : 0), 0) : 0;
  const neededCents = receipts?.state === 'ok' ? receipts.value.cards.reduce((s, c) => s + (c.chaseOn ? c.neededTotalCents : 0), 0) : 0;
  const booksCards = today?.booksPresent && (receipts?.state === 'ok' || pay?.state === 'ok' || commissions?.state === 'ok');

  return (
    <Screen title={today?.me.name ?? t('tabMe')} right={<SyncBadge />} footer={msg ? <Notice text={msg.text} tone={msg.tone} /> : undefined}>
      <Section title={t('myWeek')} right={<Text style={font.strong}>{t('weekTotal', { h: hoursText(totalHours(lines)) })}</Text>}>
        {!lines.length ? <Text style={font.muted}>{t('nothingLater')}</Text> : null}
        {lines.map((l) => {
          const j = jobById(today, l.jobId);
          return (
            <View key={l.key} style={{ gap: 8 }}>
              <Row
                title={`${dayLabel(l.workDate, lang)} · ${t('hoursShort', { h: hoursText(l.hours) })}`}
                sub={j ? jobLabel(j) : null}
                right={<Pill text={stateText(l)} tone={stateTone(l)} />}
                onPress={l.entryId && l.state !== 'APPROVED' ? () => { setEditing(editing === l.key ? null : l.key); setNewHours(String(l.hours)); } : undefined}
              />
              {l.refused ? <Notice text={l.refused} tone="danger" /> : null}
              {editing === l.key ? (
                <Card>
                  <Field label={t('newHours')} value={newHours} onChangeText={setNewHours} keyboardType="decimal-pad" maxLength={5} autoFocus />
                  <Button tone="primary" label={t('saveChange')} onPress={() => void saveHours(l)} />
                </Card>
              ) : null}
            </View>
          );
        })}
        {toSubmit.length ? <Button tone="primary" big label={t('submitWeek')} onPress={() => void submitWeek()} /> : null}
      </Section>

      {booksCards ? (
        <Section title={t('payAndReceipts')} right={<Button label={showAmounts ? t('hide') : t('show')} onPress={() => setShowAmounts((v) => !v)} />}>
          {receipts?.state === 'ok' ? (
            <Card tone={neededCount ? 'warn' : 'ok'}>
              <Text style={font.eyebrow}>{t('myReceipts')}</Text>
              <Text style={font.title}>{neededCount ? t('receiptsOwed', { n: neededCount }) : t('receiptsNone')}</Text>
              {neededCount && showAmounts ? <Text style={font.regular}>{money(neededCents)}</Text> : null}
            </Card>
          ) : null}
          {pay?.state === 'ok' ? (
            <Card>
              <Text style={font.eyebrow}>{t('myPay')}</Text>
              {pay.value.nextPayDate ? <Text style={font.title}>{dayLabel(pay.value.nextPayDate, lang)}</Text> : null}
              {pay.value.lastPay && showAmounts ? <Text style={font.regular}>{`${dayLabel(pay.value.lastPay.payDate, lang)} · ${money(pay.value.lastPay.netCents)}`}</Text> : null}
            </Card>
          ) : null}
          {commissions?.state === 'ok' ? (
            <Card>
              <Text style={font.eyebrow}>{t('myCommissions')}</Text>
              <Text style={font.title}>{commissions.value.periodLabel}</Text>
              {showAmounts ? <Text style={font.regular}>{money(commissions.value.netCents)}</Text> : null}
            </Card>
          ) : null}
        </Section>
      ) : null}
      {today?.booksPresent && (pay?.state === 'error' || receipts?.state === 'error') ? <Notice text={t('payUnavailable')} /> : null}

      <Section title={t('language')}>
        <Choice options={[{ value: 'en' as const, label: t('english') }, { value: 'es' as const, label: t('spanish') }]} value={lang} onChange={app.setLang} />
      </Section>

      <Button tone="danger" label={t('signOut')} onPress={signOut} />
    </Screen>
  );
}
