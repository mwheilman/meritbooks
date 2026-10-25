/**
 * Visit tools (field service FS-26/29/30/31): the checklists with readings this visit should use
 * (checked on the phone the same way the server checks them: missing readings, out of range, red
 * tag), the visit note by voice (the keyboard microphone; the office sorts it into diagnosis / work
 * performed / recommendations), the equipment at the site with its nameplate photo, and — when the
 * office lets this person — the customer's pay link and a text to the customer. Everything is
 * cached for the visit and every save is queued with its own command id (POST /api/field/fs-commands,
 * applied once). No money.
 */
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { FormAnswer, FsEquipmentCommand, FsFormSubmitCommand, FsFormTemplate, FsMessageCommand, FsNoteSaveCommand, FsPayLinkCommand, FsTools, PhotoCommand } from '@/core/contract';
import { capturePhoto } from '@/lib/device';
import { jobById } from '@/state/selectors';
import { answersForServer, formBlockers, validateForm } from '@/core/forms';
import { isFsTools } from '@/lib/api';
import { useApp } from '@/state/app';
import { useCached } from '@/state/cache';
import { Button, Card, Choice, Field, Notice, Pill, Row, Screen, Section } from '@/ui/components';
import { CameraButton, SyncBadge } from '@/ui/chrome';
import { SignaturePad } from '@/ui/SignaturePad';
import { color, font } from '@/ui/theme';

type Msg = { text: string; tone: 'ok' | 'danger' | 'sky' } | null;
const FUELS = ['GAS', 'PROPANE', 'ELECTRIC', 'OIL', 'DUAL', 'OTHER'] as const;

function FormFill({ form, workOrderId, jobId, onDone }: { form: FsFormTemplate; workOrderId: string; jobId: string | null; onDone: (m: Msg) => void }) {
  const app = useApp();
  const { t } = app;
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>({});
  const [photos, setPhotos] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [redWhy, setRedWhy] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const check = useMemo(() => validateForm(form.fields, answers), [form.fields, answers]);
  const set = (k: string, v: FormAnswer) => setAnswers((a) => ({ ...a, [k]: v }));

  const save = async () => {
    const block = formBlockers(check, { requiresSignature: form.requires_signature, signedName: name, drawn: !!path, redTagReason: redWhy || check.redTagReason || '' });
    if (block.includes('missing')) return setErr(t('formMissing', { list: check.missing.join(', ') }));
    if (block.includes('signature')) return setErr(t('formNeedsSignature'));
    await app.record<FsFormSubmitCommand>({
      kind: 'fs.form.submit', workOrderId, templateId: form.id, answers: answersForServer(form.fields, answers), photoIds: photos,
      signedName: name.trim() || null, signaturePath: path, redTagReason: check.redTag ? (redWhy.trim() || check.redTagReason) : null,
    });
    onDone({ text: t('formSaved'), tone: app.online ? 'ok' : 'sky' });
  };

  return (
    <Card>
      <Text style={font.title}>{form.name}</Text>
      {form.fields.map((f) => {
        const label = `${f.label ?? f.key}${f.required ? ' *' : ''}`;
        const range = f.min != null || f.max != null ? t('formRange', { min: f.min ?? '', max: f.max ?? '', unit: f.unit ?? '' }).trim() : null;
        const bad = check.outOfRange.some((o) => o.key === f.key);
        switch (f.type ?? 'text') {
          case 'reading':
          case 'number':
            return (
              <View key={f.key} style={{ gap: 4 }}>
                <Field label={`${label}${f.unit ? ` (${f.unit})` : ''}`} value={String(answers[f.key] ?? '')} onChangeText={(v) => set(f.key, v)} keyboardType="decimal-pad" maxLength={12} />
                {range ? <Text style={[font.muted, bad ? { color: color.danger } : null]}>{range}</Text> : null}
              </View>
            );
          case 'pass_fail':
            return (
              <View key={f.key} style={{ gap: 6 }}>
                <Text style={font.strong}>{label}</Text>
                <Choice options={[{ value: 'PASS', label: t('pass'), tone: 'ok' as const }, { value: 'FAIL', label: t('fail'), tone: 'danger' as const }, { value: 'NA', label: t('na') }]} value={(answers[f.key] as string) ?? null} onChange={(v) => set(f.key, v)} />
              </View>
            );
          case 'check':
            return <Row key={f.key} title={label} selected={answers[f.key] === true} onPress={() => set(f.key, answers[f.key] === true ? null : true)} right={answers[f.key] === true ? <Pill text={t('checkYes')} tone="ok" /> : null} />;
          case 'choice':
            return (
              <View key={f.key} style={{ gap: 6 }}>
                <Text style={font.strong}>{label}</Text>
                {(f.options ?? []).map((o) => <Row key={o} title={o} selected={answers[f.key] === o} onPress={() => set(f.key, o)} />)}
              </View>
            );
          case 'photo':
            return (
              <View key={f.key} style={{ gap: 6 }}>
                <Text style={font.strong}>{label}</Text>
                <Text style={font.muted}>{t('photosTaken', { n: Array.isArray(answers[f.key]) ? (answers[f.key] as string[]).length : 0 })}</Text>
              </View>
            );
          default:
            return <Field key={f.key} label={label} value={String(answers[f.key] ?? '')} onChangeText={(v) => set(f.key, v)} multiline maxLength={2000} />;
        }
      })}
      {check.outOfRange.length ? <Notice text={t('formOutOfRange', { list: check.outOfRange.map((o) => o.label).join(', ') })} /> : null}
      {check.redTag ? (
        <>
          <Notice text={t('formRedTag', { reason: check.redTagReason ?? '' })} tone="danger" />
          <Field label={t('redTagWhy')} value={redWhy} onChangeText={setRedWhy} multiline maxLength={500} />
        </>
      ) : null}
      {form.requires_signature || check.redTag ? (
        <>
          <Field label={t('customerName')} value={name} onChangeText={setName} autoCapitalize="words" maxLength={120} />
          <SignaturePad label={t('customerSigns')} clearLabel={t('clearSignature')} onChange={setPath} />
        </>
      ) : null}
      <Text style={font.muted}>{t('photosTaken', { n: photos.length })}</Text>
      {err ? <Notice text={err} tone="danger" /> : null}
      <Button big tone="primary" label={t('formSubmit')} onPress={() => void save()} />
      <CameraInline jobId={jobId} onTaken={(id) => {
        setPhotos((p) => [...p, id]);
        const pf = form.fields.find((f) => f.type === 'photo');
        if (pf) setAnswers((a) => ({ ...a, [pf.key]: [...((a[pf.key] as string[] | undefined) ?? []), id] }));
      }} />
    </Card>
  );
}

/** The camera inside a card (not floating): photos queue on the visit's job. */
function CameraInline({ jobId, onTaken }: { jobId: string | null; onTaken: (id: string) => void }) {
  return <View style={{ height: 96 }}><CameraButton jobId={jobId} onTaken={onTaken} /></View>;
}

export default function Visit() {
  const app = useApp();
  const { t, today } = app;
  const { workOrderId = '' } = useLocalSearchParams<{ workOrderId?: string }>();
  const data = useCached<FsTools>(workOrderId ? `fs.tools.${workOrderId}` : null, isFsTools, () => app.api.fsTools(workOrderId), app.online);
  const visit = today?.assignments.find((a) => a.workOrderId === workOrderId) ?? null;
  const [formId, setFormId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [notePhotos, setNotePhotos] = useState<string[]>([]);
  const [eq, setEq] = useState<{ assetId: string | null; make: string; model: string; serial: string; type: string; tons: string; refrigerant: string; fuel: (typeof FUELS)[number] | null; plate: string | null } | null>(null);
  const [text, setText] = useState('');
  const job = jobById(today, visit?.jobId ?? data.value?.jobId ?? null);
  const review = data.value?.invoiceReview ?? null;
  const payLinkQueued = app.queued.some((q) => q.command.kind === 'fs.paylink.send' && review && (q.command as FsPayLinkCommand).reviewId === review.id && q.status !== 'rejected' && q.status !== 'dismissed');
  const [msg, setMsg] = useState<Msg>(null);
  const say = (m: Msg) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  const doneHere = useMemo(() => new Set(app.queued.filter((q) => q.command.kind === 'fs.form.submit' && q.status !== 'rejected' && q.status !== 'dismissed').map((q) => (q.command as FsFormSubmitCommand).templateId)), [app.queued]);
  const forms = data.value?.forms ?? [];

  const saveNote = async () => {
    if (!note.trim()) return;
    await app.record<FsNoteSaveCommand>({ kind: 'fs.note.save', workOrderId, source: 'TYPED', transcript: note.trim(), fields: null, photoIds: notePhotos, photoCaptions: {} });
    setNote('');
    setNotePhotos([]);
    say({ text: t('noteSaved'), tone: app.online ? 'ok' : 'sky' });
  };

  const saveEq = async () => {
    if (!eq) return;
    if (!eq.make.trim() && !eq.model.trim() && !eq.serial.trim()) return say({ text: t('eqNeedsSomething'), tone: 'danger' });
    const tons = eq.tons.trim() ? Number(eq.tons.replace(',', '.')) : null;
    const type = eq.type.trim().toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '');
    await app.record<FsEquipmentCommand>({
      kind: 'fs.equipment.upsert', workOrderId, assetId: eq.assetId, make: eq.make.trim() || null, model: eq.model.trim() || null, serial: eq.serial.trim() || null,
      equipmentType: /^[A-Z_]{2,30}$/.test(type) ? type : null, tonnage: tons != null && Number.isFinite(tons) ? tons : null,
      refrigerantType: eq.refrigerant.trim() || null, fuelType: eq.fuel, nameplatePhotoId: eq.plate,
    }, { dependsOn: eq.plate });
    setEq(null);
    say({ text: t('eqSaved'), tone: app.online ? 'ok' : 'sky' });
  };

  const shootPlate = async () => {
    if (!eq) return;
    const jobId = visit?.jobId ?? data.value?.jobId;
    if (!jobId) return;
    const id = app.newId();
    const shot = await capturePhoto(id);
    if (!shot.ok) {
      if (shot.reason === 'denied') say({ text: t('cameraDenied'), tone: 'danger' });
      return;
    }
    await app.record<PhotoCommand>({ id, kind: 'photo.upload', jobId, caption: 'Equipment nameplate', attachTo: null }, { fileUri: shot.uri });
    setEq({ ...eq, plate: id });
  };

  const sendPayLink = async () => {
    if (!review?.canSendPayLink) return;
    await app.record<FsPayLinkCommand>({ kind: 'fs.paylink.send', reviewId: review.id, channel: 'SMS' }, { geo: null });
    say({ text: t('payLinkSent'), tone: app.online ? 'ok' : 'sky' });
  };

  const sendText = async () => {
    const customerId = data.value?.customerId;
    if (!customerId || !job || !text.trim()) return;
    await app.record<FsMessageCommand>({ kind: 'fs.message.send', companyId: job.companyId, customerId, jobId: job.id, workOrderId, body: text.trim().slice(0, 640) }, { geo: null });
    setText('');
    say({ text: t('messageSent'), tone: app.online ? 'ok' : 'sky' });
  };

  return (
    <Screen title={visit ? t('visitToolsFor', { visit: visit.title }) : t('visitTools')} right={<SyncBadge />}
      footer={<View style={{ gap: 10 }}>{msg ? <Notice text={msg.text} tone={msg.tone} /> : null}<Button label={t('back')} onPress={() => router.back()} /></View>}>
      {!data.value ? <Notice text={data.loading ? t('loadingWork') : t('toolsLoadFailed')} tone={data.loading ? 'sky' : 'warn'} /> : null}

      <Section title={t('formsTitle')}>
        {data.value && !forms.length ? <Text style={font.muted}>{t('formNone')}</Text> : null}
        {forms.map((f) => (
          <View key={f.id} style={{ gap: 8 }}>
            <Row title={f.name} selected={formId === f.id} onPress={() => setFormId(formId === f.id ? null : f.id)}
              right={f.submitted || doneHere.has(f.id) ? <Pill text={t('formDone')} tone="ok" /> : f.suggested ? <Pill text={t('formSuggested')} tone="primary" /> : null} />
            {formId === f.id ? <FormFill form={f} workOrderId={workOrderId} jobId={visit?.jobId ?? null} onDone={(m) => { setFormId(null); say(m); }} /> : null}
          </View>
        ))}
      </Section>

      <Section title={t('notesTitle')}>
        <Text style={font.muted}>{t('noteHint')}</Text>
        <Field label={t('noteBody')} value={note} onChangeText={setNote} multiline maxLength={20_000} />
        <Text style={font.muted}>{t('photosTaken', { n: notePhotos.length })}</Text>
        <Button tone="primary" label={t('noteSave')} disabled={!note.trim()} onPress={() => void saveNote()} />
        <CameraInline jobId={visit?.jobId ?? null} onTaken={(id) => setNotePhotos((p) => [...p, id])} />
        {(data.value?.notes ?? []).length ? <Text style={font.eyebrow}>{t('notesEarlier')}</Text> : null}
        {(data.value?.notes ?? []).map((n) => (
          <Card key={n.id}>
            {[n.diagnosis, n.work_performed, n.recommendations].filter(Boolean).map((x, i) => <Text key={i} style={font.regular}>{x}</Text>)}
          </Card>
        ))}
      </Section>

      <Section title={t('equipmentTitle')}>
        {data.value && !(data.value.equipment ?? []).length ? <Text style={font.muted}>{t('equipmentNone')}</Text> : null}
        {(data.value?.equipment ?? []).map((e) => (
          <Row key={e.asset_id} title={[e.make, e.model].filter(Boolean).join(' ') || (e.equipment_type ?? '—')}
            sub={[e.serial_number, e.age_years != null ? t('eqAge', { n: e.age_years }) : null, e.parts_covered ? t('eqCovered') : e.parts_covered === false ? t('eqNotCovered') : null].filter(Boolean).join(' · ')}
            right={<Pill text={t('equipmentEdit')} />}
            onPress={() => setEq({ assetId: e.asset_id, make: e.make ?? '', model: e.model ?? '', serial: e.serial_number ?? '', type: e.equipment_type ?? '', tons: '', refrigerant: '', fuel: null, plate: null })} />
        ))}
        {eq ? (
          <Card>
            <Field label={t('eqMake')} value={eq.make} onChangeText={(v) => setEq({ ...eq, make: v })} maxLength={80} />
            <Field label={t('eqModel')} value={eq.model} onChangeText={(v) => setEq({ ...eq, model: v })} maxLength={80} autoCapitalize="characters" />
            <Field label={t('eqSerial')} value={eq.serial} onChangeText={(v) => setEq({ ...eq, serial: v })} maxLength={80} autoCapitalize="characters" autoCorrect={false} />
            <Field label={t('eqType')} value={eq.type} onChangeText={(v) => setEq({ ...eq, type: v })} maxLength={30} />
            <Field label={t('eqTonnage')} value={eq.tons} onChangeText={(v) => setEq({ ...eq, tons: v })} keyboardType="decimal-pad" maxLength={6} />
            <Field label={t('eqRefrigerant')} value={eq.refrigerant} onChangeText={(v) => setEq({ ...eq, refrigerant: v })} maxLength={20} autoCapitalize="characters" />
            <Text style={font.strong}>{t('eqFuel')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {FUELS.map((f) => <View key={f} style={{ flexBasis: '30%', flexGrow: 1 }}><Button label={f} tone={eq.fuel === f ? 'primary' : 'secondary'} onPress={() => setEq({ ...eq, fuel: eq.fuel === f ? null : f })} /></View>)}
            </View>
            {eq.plate ? <Pill text={t('eqNameplateTaken')} tone="ok" /> : <Button label={t('eqNameplatePhoto')} onPress={() => void shootPlate()} />}
            <Button big tone="primary" label={t('saveChange')} onPress={() => void saveEq()} />
            <Button label={t('cancel')} onPress={() => setEq(null)} />
          </Card>
        ) : (
          <Button label={t('equipmentAdd')} onPress={() => setEq({ assetId: null, make: '', model: '', serial: '', type: '', tons: '', refrigerant: '', fuel: null, plate: null })} />
        )}
      </Section>

      {data.value?.customerId && job ? (
        <Section title={t('messageCustomer')}>
          <Field label={t('messageBody')} value={text} onChangeText={setText} multiline maxLength={640} />
          <Button label={t('messageSend')} disabled={!text.trim()} onPress={() => void sendText()} />
        </Section>
      ) : null}

      {review && review.blockingCount > 0 ? <Notice text={t('payLinkBlocked', { n: review.blockingCount })} /> : null}
      {review?.canSendPayLink ? <Button big tone="primary" label={t('payLinkSend')} disabled={payLinkQueued} onPress={() => void sendPayLink()} /> : null}
    </Screen>
  );
}
