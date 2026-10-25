/**
 * Snap a receipt (residential RES-62): a crew member photographs a receipt for something bought for
 * the job; the office codes it and hands it to Merit Books. Works offline: the photo and the
 * receipt are both queued; the receipt names its photo by command id and the server links them when
 * the photo lands (POST /api/field/receipts, clientId = the command id, deduped in the database).
 * The amount is the worker's own purchase.
 */
import { useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { PhotoCommand, ResReceiptCommand } from '@/core/contract';
import { parseDollars } from '@/core/money';
import { capturePhoto, localDay } from '@/lib/device';
import { useApp } from '@/state/app';
import { jobById } from '@/state/selectors';
import { Button, Field, Notice, Pill, Screen } from '@/ui/components';
import { SyncBadge, jobLabel } from '@/ui/chrome';
import { font } from '@/ui/theme';

export default function Receipt() {
  const app = useApp();
  const { t, today } = app;
  const { jobId = app.currentJobId ?? '' } = useLocalSearchParams<{ jobId?: string }>();
  const job = jobById(today, jobId);
  const [clientId] = useState(() => app.newId());
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(localDay());
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'danger' | 'sky' | 'warn' } | null>(null);
  const [sent, setSent] = useState(false);

  const shoot = async () => {
    const id = app.newId();
    const shot = await capturePhoto(id);
    if (!shot.ok) {
      if (shot.reason === 'denied') setMsg({ text: t('cameraDenied'), tone: 'danger' });
      return;
    }
    await app.record<PhotoCommand>({ id, kind: 'photo.upload', jobId, caption: 'Receipt', attachTo: null }, { fileUri: shot.uri });
    setPhotoId(id);
  };

  const send = async () => {
    if (!photoId) return setMsg({ text: t('receiptNeedPhoto'), tone: 'danger' });
    const cents = amount.trim() ? parseDollars(amount) : null;
    if (amount.trim() && cents == null) return setMsg({ text: t('depositBad'), tone: 'danger' });
    setBusy(true);
    try {
      await app.record<ResReceiptCommand>({
        id: clientId, kind: 'res.receipt', jobId, photoCommandId: photoId, vendorName: vendor.trim() || null, amountCents: cents,
        purchasedOn: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, memo: memo.trim() || null,
      }, { dependsOn: photoId });
      setSent(true);
      setMsg({ text: app.online ? t('receiptSaved') : t('receiptQueued'), tone: app.online ? 'ok' : 'sky' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t('receiptTitle')} right={<SyncBadge />}
      footer={<View style={{ gap: 10 }}>
        {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
        {sent ? <Button big tone="primary" label={t('done')} onPress={() => router.back()} /> : (
          <>
            <Button big tone="primary" label={t('receiptSend')} busy={busy} disabled={!photoId} onPress={() => void send()} />
            <Button label={t('back')} onPress={() => router.back()} />
          </>
        )}
      </View>}>
      {job ? <Text style={font.strong}>{jobLabel(job)}</Text> : null}
      <Notice text={t('receiptHint')} tone="sky" />
      {photoId ? <Pill text={t('receiptPhotoTaken')} tone="ok" /> : <Button big label={t('takePhoto')} onPress={() => void shoot()} />}
      <Field label={t('receiptVendor')} value={vendor} onChangeText={setVendor} maxLength={200} />
      <Field label={t('receiptAmount')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" maxLength={12} />
      <Field label={t('receiptDate')} value={date} onChangeText={setDate} maxLength={10} />
      <Field label={t('receiptMemo')} value={memo} onChangeText={setMemo} maxLength={500} />
    </Screen>
  );
}
