/**
 * Will-call pickups (FS-90): the job POs waiting for me at a supply house, with the pickup code the
 * counter asks for. "I picked these up" records the receipt (and the serial numbers onto my truck)
 * as a queued `fs.willcall.pickup` command, applied once. No money.
 */
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { FsWillCallCommand } from '@/core/contract';
import { pickedUpHere, pickupDraft } from '@/core/forms';
import { useApp } from '@/state/app';
import { hoursText } from '@/state/selectors';
import { Button, Card, Field, Notice, Pill, Screen } from '@/ui/components';
import { SyncBadge } from '@/ui/chrome';
import { font } from '@/ui/theme';

export default function WillCalls() {
  const app = useApp();
  const { t, more, queued } = app;
  const [open, setOpen] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' } | null>(null);
  const done = useMemo(() => pickedUpHere(queued), [queued]);
  const list = more.willCalls.filter((w) => !done.has(w.commitment_id));

  const pick = async (id: string) => {
    const w = list.find((x) => x.commitment_id === id);
    if (!w) return;
    const d = pickupDraft(w, qty, serials);
    if (!d) return setMsg({ text: t('willCallNoCode'), tone: 'danger' });
    await app.record<FsWillCallCommand>(d);
    setOpen(null);
    setQty({});
    setSerials({});
    setMsg({ text: t('willCallSaved'), tone: app.online ? 'ok' : 'sky' });
  };

  return (
    <Screen title={t('willCallTitle')} right={<SyncBadge />}
      footer={<View style={{ gap: 10 }}>{msg ? <Notice text={msg.text} tone={msg.tone} /> : null}<Button label={t('back')} onPress={() => router.back()} /></View>}>
      {!list.length ? <Text style={font.muted}>{t('willCallNone')}</Text> : null}
      {list.map((w) => (
        <Card key={w.commitment_id} tone={w.ready ? 'sky' : undefined}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text style={font.strong}>{[w.number, w.vendor].filter(Boolean).join(' · ')}</Text>
            <Pill text={w.ready ? t('willCallReady') : t('willCallNotReady')} tone={w.ready ? 'ok' : 'warn'} />
          </View>
          {w.title ? <Text style={font.regular}>{w.title}</Text> : null}
          {w.pickup_code ? <Text style={font.hero}>{t('willCallCode', { code: w.pickup_code })}</Text> : <Notice text={t('willCallNoCode')} />}
          {w.note ? <Text style={font.muted}>{w.note}</Text> : null}
          {w.lines.map((l) => {
            const owed = Math.max(0, (l.qty ?? 0) - l.received_qty);
            return (
              <View key={l.line_id} style={{ gap: 6 }}>
                <Text style={font.regular}>{`${l.description} · ${hoursText(owed)}`}</Text>
                {open === w.commitment_id ? (
                  <>
                    <Field label={t('willCallQty', { owed: hoursText(owed) })} value={qty[l.line_id] ?? ''} placeholder={hoursText(owed)} onChangeText={(v) => setQty((q) => ({ ...q, [l.line_id]: v }))} keyboardType="decimal-pad" maxLength={8} />
                    <Field label={t('willCallSerials')} value={serials[l.line_id] ?? ''} onChangeText={(v) => setSerials((s) => ({ ...s, [l.line_id]: v }))} multiline autoCapitalize="characters" autoCorrect={false} />
                  </>
                ) : null}
              </View>
            );
          })}
          {open === w.commitment_id
            ? <Button big tone="primary" label={t('willCallPicked')} onPress={() => void pick(w.commitment_id)} />
            : <Button label={t('willCallPicked')} disabled={!w.pickup_code} onPress={() => setOpen(w.commitment_id)} />}
        </Card>
      ))}
    </Screen>
  );
}
