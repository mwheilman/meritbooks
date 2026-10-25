/**
 * My pay this week (flooring installer, FLR-33/34): MY OWN piece-rate tickets — what each install
 * earned, my split, chargebacks netted — and the chargebacks to look at. The server sends only
 * my own tickets (filtered to my employee id on top of RLS). Saved on the phone per week.
 */
import { useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PayWeek } from '@/core/contract';
import type { StringKey } from '@/core/i18n';
import { moneyText } from '@/core/money';
import { isPay } from '@/lib/api';
import { localDay } from '@/lib/device';
import { useApp } from '@/state/app';
import { useCached } from '@/state/cache';
import { agoText, dayLabel, hoursText } from '@/state/selectors';
import { Button, Card, Choice, Notice, Pill, Section, s } from '@/ui/components';
import { SyncBadge } from '@/ui/chrome';
import { color, font } from '@/ui/theme';

const minusWeek = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() - 7);
  return localDay(d.getTime());
};

const STATUS: Readonly<Record<string, StringKey>> = { DRAFT: 'payStatus_DRAFT', FINALIZED: 'payStatus_FINALIZED', APPROVED: 'payStatus_APPROVED', PAID: 'payStatus_PAID' };
const CB: Readonly<Record<string, StringKey>> = { CALLBACK: 'cb_CALLBACK', DAMAGE: 'cb_DAMAGE', MATERIAL_OVERUSE: 'cb_MATERIAL_OVERUSE', NO_SHOW: 'cb_NO_SHOW', OTHER: 'cb_OTHER' };

export default function Pay() {
  const app = useApp();
  const { t, lang } = app;
  const insets = useSafeAreaInsets();
  const [which, setWhich] = useState<'this' | 'last'>('this');
  const week = which === 'this' ? localDay() : minusWeek(localDay());
  const data = useCached<PayWeek>(`pay.${which}`, isPay, () => app.api.payWeek(week), app.online);
  const [pulling, setPulling] = useState(false);
  const w = data.value;
  const m = (c: number | null) => (c == null ? '—' : moneyText(c, lang));

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Text style={font.title} accessibilityRole="header">{t('payWeekTitle')}</Text>
        <SyncBadge />
      </View>
      <ScrollView contentContainerStyle={s.body} refreshControl={<RefreshControl refreshing={pulling} onRefresh={async () => { setPulling(true); await data.refresh(); setPulling(false); }} />}>
        <Choice options={[{ value: 'this' as const, label: t('payThisWeek') }, { value: 'last' as const, label: t('payPrevWeek') }]} value={which} onChange={setWhich} />
        {data.error && w ? <Notice text={t('payLoadFailed', { when: agoText(data.at, lang) })} /> : null}
        {!w ? <Notice text={data.loading ? t('loadingWork') : data.error ?? t('payNone')} tone={data.loading ? 'sky' : 'warn'} /> : null}
        {w ? (
          <>
            <Card tone="sky">
              <Text style={font.eyebrow}>{t('payRange', { from: dayLabel(w.weekStart, lang), to: dayLabel(w.weekEnd, lang) })}</Text>
              <Text style={font.hero}>{moneyText(w.totals.netCents, lang)}</Text>
              <Text style={font.regular}>{`${t('payGross')} ${moneyText(w.totals.grossCents, lang)} · ${t('payChargebacks')} ${moneyText(w.totals.chargebackCents, lang)}`}</Text>
              <Text style={font.strong}>{t('payApproved', { amount: moneyText(w.totals.approvedNetCents, lang) })}</Text>
              <Text style={font.muted}>{t('payOwnOnly')}</Text>
            </Card>
            {!w.tickets.length ? <Text style={font.muted}>{t('payNone')}</Text> : null}
            {w.tickets.length ? (
              <Section title={t('payTickets')}>
                {w.tickets.map((k) => (
                  <Card key={k.id}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                      <Text style={font.strong}>{[k.number, dayLabel(k.completedOn, lang)].filter(Boolean).join(' · ')}</Text>
                      <Pill text={STATUS[k.status] ? t(STATUS[k.status]!) : k.status} tone={k.status === 'APPROVED' || k.status === 'PAID' ? 'ok' : 'warn'} />
                    </View>
                    {k.job ? <Text style={font.regular}>{k.job}</Text> : null}
                    {k.lines.map((l, i) => (
                      <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={[font.muted, { flex: 1 }]}>{`${l.description ?? l.laborCode} · ${hoursText(l.qty)} ${l.unit ?? ''}`.trim()}</Text>
                        <Text style={font.regular}>{m(l.amountCents)}</Text>
                      </View>
                    ))}
                    {k.lines.some((l) => l.overMeasured) ? <Text style={[font.muted, { color: color.warn }]}>{t('payOverMeasured')}</Text> : null}
                    {k.splitPct != null && k.splitPct < 1 ? <Text style={font.muted}>{t('paySplit', { pct: Math.round(k.splitPct * 100) })}</Text> : null}
                    {k.chargebackCents ? <Text style={font.muted}>{`${t('payChargebacks')} −${m(k.chargebackCents)}`}</Text> : null}
                    <Text style={font.title}>{m(k.netCents ?? k.grossCents)}</Text>
                  </Card>
                ))}
              </Section>
            ) : null}
            {w.chargebacks.length ? (
              <Section title={t('payOpenChargebacks')}>
                {w.chargebacks.map((c) => (
                  <Card key={c.id} tone="warn">
                    <Text style={font.strong}>{`${CB[c.reason] ? t(CB[c.reason]!) : c.reason} · ${m(c.amountCents)}`}</Text>
                    {c.description ? <Text style={font.regular}>{c.description}</Text> : null}
                  </Card>
                ))}
              </Section>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <View style={s.footer}><Button label={t('back')} onPress={() => router.back()} /></View>
    </View>
  );
}
