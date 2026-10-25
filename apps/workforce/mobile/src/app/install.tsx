/**
 * Install day (flooring FLR-33/20): my crew's bookings today — address, rooms and square feet, the
 * cut list, site checks still needed — "on my way" (texts the customer once), the customer's
 * sign-off with after photos, a signature and the leftover roll goods to take back, and an on-site
 * change from the job's labor codes the customer signs for. All three are queued (the photos go
 * first and the commands name them; the change carries its command id, so a re-send never makes a
 * second change order). My own pay this week shows at the top; it is the only amount here.
 */
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import type { FlrChangeCommand, FlrOnMyWayCommand, FlrSignoffCommand, InstallerDay, PhotoCommand } from '@/core/contract';
import { moneyText } from '@/core/money';
import { writeSignaturePng } from '@/lib/files';
import { useApp } from '@/state/app';
import { hoursText } from '@/state/selectors';
import { Button, Card, Field, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { CameraButton, SyncBadge } from '@/ui/chrome';
import { SignaturePad, type SignatureExport } from '@/ui/SignaturePad';
import { font } from '@/ui/theme';

type Booking = InstallerDay['bookings'][number];
type Mode = { kind: 'none' } | { kind: 'signoff'; booking: Booking } | { kind: 'change'; booking: Booking };
type Msg = { text: string; tone: 'ok' | 'danger' | 'sky' | 'warn' } | null;

export default function InstallDay() {
  const app = useApp();
  const { t, lang, more, queued } = app;
  const day = more.installerDay;
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [photos, setPhotos] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState(false);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Array<{ code: string; qty: string; what: string }>>([{ code: '', qty: '', what: '' }]);
  const [leftover, setLeftover] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const pad = useRef<SignatureExport>(null);
  const closedHere = new Set(queued.filter((q) => q.command.kind === 'flr.signoff' && q.status !== 'rejected' && q.status !== 'dismissed').map((q) => (q.command as FlrSignoffCommand).bookingId));
  const omwHere = new Set(queued.filter((q) => q.command.kind === 'flr.omw' && q.status !== 'rejected' && q.status !== 'dismissed').map((q) => (q.command as FlrOnMyWayCommand).bookingId));

  const reset = () => {
    setMode({ kind: 'none' });
    setPhotos([]);
    setName('');
    setDrawn(false);
    setNotes('');
    setLines([{ code: '', qty: '', what: '' }]);
    setLeftover({});
  };

  /** The drawn signature as a queued photo on the job; its command id (or null). */
  const signaturePhoto = async (jobId: string): Promise<string | null> => {
    const id = app.newId();
    const png = await pad.current?.png();
    const uri = png ? await writeSignaturePng(id, png) : null;
    if (!uri) return null;
    await app.record<PhotoCommand>({ id, kind: 'photo.upload', jobId, caption: 'Customer signature', attachTo: null }, { fileUri: uri, geo: null });
    return id;
  };

  const signoff = async () => {
    if (mode.kind !== 'signoff') return;
    if (!name.trim()) return setMsg({ text: t('sellNeedsName'), tone: 'danger' });
    if (!drawn) return setMsg({ text: t('sellNeedsDrawing'), tone: 'danger' });
    setBusy(true);
    try {
      const sig = await signaturePhoto(mode.booking.job_id);
      const rolls = [...new Set(mode.booking.cuts.map((c) => c.roll_id).filter((x): x is string => !!x))];
      const back = rolls.map((r) => ({ roll_id: r, len_in: Number((leftover[r] ?? '').replace(',', '.')) })).filter((x) => Number.isFinite(x.len_in) && x.len_in > 0);
      await app.record<FlrSignoffCommand>({
        kind: 'flr.signoff', bookingId: mode.booking.booking_id, signerName: name.trim(), notes: notes.trim() || null, leftover: back,
        docRefs: [...(sig ? [{ field: 'signatureDocumentId' as const, photoId: sig }] : []), ...photos.map((p) => ({ field: 'photoDocumentIds' as const, photoId: p }))],
      });
      reset();
      setMsg({ text: t('installSignedSaved'), tone: app.online ? 'ok' : 'sky' });
    } finally {
      setBusy(false);
    }
  };

  const change = async () => {
    if (mode.kind !== 'change') return;
    const ls = lines.map((l) => ({ labor_code: l.code, qty: Number(l.qty.replace(',', '.')), description: l.what.trim() || null }))
      .filter((l) => /^[A-Z0-9_]{2,32}$/.test(l.labor_code) && Number.isFinite(l.qty) && l.qty > 0);
    if (!ls.length) return setMsg({ text: t('laborPick'), tone: 'danger' });
    if (!name.trim() || !drawn) return setMsg({ text: t('sellNeedsDrawing'), tone: 'danger' });
    setBusy(true);
    try {
      const sig = await signaturePhoto(mode.booking.job_id);
      await app.record<FlrChangeCommand>({
        kind: 'flr.change', jobId: mode.booking.job_id, lines: ls, signerName: name.trim(), note: notes.trim() || null,
        docRefs: sig ? [{ field: 'signatureDocumentId', photoId: sig }] : [],
      });
      reset();
      setMsg({ text: app.online ? t('changeSaved') : t('changeSavedQueued'), tone: app.online ? 'ok' : 'sky' });
    } finally {
      setBusy(false);
    }
  };

  const sigFields = (
    <>
      <Field label={t('customerName')} value={name} onChangeText={setName} autoCapitalize="words" maxLength={200} />
      <SignaturePad label={t('customerSigns')} clearLabel={t('clearSignature')} onChange={(p) => setDrawn(!!p)} exportRef={pad} />
      <Field label={t('installSignoffNotes')} value={notes} onChangeText={setNotes} multiline maxLength={2000} />
    </>
  );

  return (
    <Screen title={t('installTitle')} right={<SyncBadge />}
      footer={<View style={{ gap: 10 }}>{msg ? <Notice text={msg.text} tone={msg.tone} /> : null}<Button label={mode.kind === 'none' ? t('back') : t('cancel')} onPress={() => (mode.kind === 'none' ? router.back() : reset())} /></View>}>
      {day ? <Pill text={t('myPayToday', { amount: moneyText(day.my_pay_this_week_cents, lang) })} tone="ok" /> : null}
      {!day?.bookings.length ? <Text style={font.muted}>{t('installNone')}</Text> : null}
      {mode.kind === 'none' ? day?.bookings.map((b) => {
        const closed = closedHere.has(b.booking_id);
        return (
          <Card key={b.booking_id} tone={closed ? 'ok' : undefined}>
            <Text style={font.title}>{[b.job_number, b.job].filter(Boolean).join(' · ')}</Text>
            {b.address ? <Text style={font.regular}>{b.address}</Text> : null}
            {b.sf ? <Text style={font.strong}>{t('sfLabel', { n: hoursText(b.sf) })}</Text> : null}
            {b.notes ? <Text style={font.muted}>{b.notes}</Text> : null}
            {b.areas.length ? (
              <Section title={t('installRooms')}>
                {b.areas.map((a, i) => <Text key={i} style={font.regular}>{[a.room, a.category, a.sqft != null ? t('sfLabel', { n: hoursText(a.sqft) }) : null].filter(Boolean).join(' · ')}</Text>)}
              </Section>
            ) : null}
            {b.cuts.length ? (
              <Section title={t('installCuts')}>
                {b.cuts.map((c, i) => <Text key={i} style={font.regular}>{[c.room, c.roll, c.dye_lot, c.planned_len_in != null ? `${hoursText(c.planned_len_in)}″` : null, c.status].filter(Boolean).join(' · ')}</Text>)}
              </Section>
            ) : null}
            {b.site_checks_needed.length ? <Notice text={t('installChecks', { list: b.site_checks_needed.join(', ') })} /> : null}
            {closed ? <Pill text={t('saved')} tone="ok" /> : (
              <>
                <Button label={t('installOnMyWay')} disabled={omwHere.has(b.booking_id)} onPress={async () => { await app.record<FlrOnMyWayCommand>({ kind: 'flr.omw', bookingId: b.booking_id }); setMsg({ text: t('installOmwSaved'), tone: app.online ? 'ok' : 'sky' }); }} />
                <Button label={t('installChange')} onPress={() => setMode({ kind: 'change', booking: b })} />
                <Button big tone="primary" label={t('installSignoff')} onPress={() => setMode({ kind: 'signoff', booking: b })} />
              </>
            )}
          </Card>
        );
      }) : null}

      {mode.kind === 'signoff' ? (
        <Section title={t('installSignoff')}>
          <Text style={font.muted}>{t('installSignoffHint')}</Text>
          <Text style={font.strong}>{t('photosTaken', { n: photos.length })}</Text>
          <View style={{ height: 96 }}><CameraButton jobId={mode.booking.job_id} onTaken={(id) => setPhotos((p) => [...p, id])} /></View>
          {mode.booking.cuts.some((c) => c.roll_id) ? (
            <Section title={t('leftoverTitle')}>
              {[...new Map(mode.booking.cuts.filter((c) => c.roll_id).map((c) => [c.roll_id!, c])).values()].map((c) => (
                <Field key={c.roll_id} label={t('leftoverInches', { roll: [c.roll, c.dye_lot].filter(Boolean).join(' · ') || '—' })} value={leftover[c.roll_id!] ?? ''}
                  onChangeText={(v) => setLeftover((m) => ({ ...m, [c.roll_id!]: v }))} keyboardType="decimal-pad" maxLength={7} />
              ))}
            </Section>
          ) : null}
          {sigFields}
          <Button big tone="ok" label={t('installSignoffSave')} busy={busy} onPress={() => void signoff()} />
        </Section>
      ) : null}

      {mode.kind === 'change' ? (
        <Section title={t('installChange')}>
          <Notice text={t('installChangeHint')} tone="sky" />
          {lines.map((l, i) => (
            <Card key={i}>
              <Text style={font.strong}>{t('laborPick')}</Text>
              {(mode.booking.labor_codes ?? []).map((c) => (
                <Row key={c.code} title={c.description} sub={`${c.code} · ${c.unit}`} selected={l.code === c.code}
                  onPress={() => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, code: c.code } : x)))} />
              ))}
              {!(mode.booking.labor_codes ?? []).length ? (
                <Field label={t('laborCode')} value={l.code} onChangeText={(v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, code: v.trim().toUpperCase() } : x)))} autoCapitalize="characters" autoCorrect={false} maxLength={32} />
              ) : null}
              <Field label={t('changeQty')} value={l.qty} onChangeText={(v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: v } : x)))} keyboardType="decimal-pad" maxLength={8} />
              <Field label={t('changeWhat')} value={l.what} onChangeText={(v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, what: v } : x)))} maxLength={200} />
            </Card>
          ))}
          {lines.length < 20 ? <Button label={t('changeAddLine')} onPress={() => setLines((ls) => [...ls, { code: '', qty: '', what: '' }])} /> : null}
          {sigFields}
          <Button big tone="primary" label={t('changeSend')} busy={busy} onPress={() => void change()} />
        </Section>
      ) : null}
    </Screen>
  );
}
